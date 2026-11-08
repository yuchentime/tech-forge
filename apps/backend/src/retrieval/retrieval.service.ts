import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmbeddingService } from '../embedding/embedding.service';
import { buildExpansionMatchQuery, QUERY_EXPANDER, type QueryExpander } from './query-expander';
import { buildMatchQuery } from './text-normalizer';

/** Reciprocal rank fusion constant; identical to the value fixed in the design. */
export const RRF_K = 60;
/** Candidates requested from each channel before fusion. */
export const CHANNEL_DEPTH = 50;
/** Default number of fused hits returned to callers. */
export const DEFAULT_LIMIT = 12;
/**
 * Minimum cosine for a dense hit. Measured on `bge-small-zh-v1.5`: unrelated Chinese sentences land
 * around 0.47–0.48 and related ones above 0.6, so the floor sits between the two populations.
 */
export const MIN_VECTOR_SCORE = 0.55;

/** Expansion runs only on a total lexical miss: partial recall must not pay a model round-trip. */
export const EXPAND_BELOW_LEXICAL_HITS = 1;
/** Rank penalty applied to expanded-terms hits so literal query matches still lead. */
export const EXPANSION_RANK_OFFSET = 5;

/** One retrieval request. `documentIds` restricts the search to an explicit document set. */
export interface RetrievalRequest {
  query: string;
  limit?: number;
  documentIds?: string[];
  /** Overrides the dense-channel similarity floor for tuning and evaluation. */
  minVectorScore?: number;
  /** Set false to skip LLM query expansion for this call even when it is enabled. */
  expand?: boolean;
}

/** Score provenance for one hit, keeping channel scores visible for debugging and evaluation. */
export interface RetrievalScore {
  rrf: number;
  lexicalRank?: number;
  vectorRank?: number;
  expandedRank?: number;
  lexicalScore?: number;
  vectorScore?: number;
  expandedScore?: number;
}

/** One retrieved chunk with everything a citation needs. */
export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  content: string;
  locatorJson: string;
  score: RetrievalScore;
}

/** Raw row shape returned by the vector and chunk queries. */
interface VectorRow {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  vector: Buffer;
}

/** Raw chunk row used to hydrate hits. */
interface ChunkRow {
  id: string;
  documentId: string;
  documentVersionId: string;
  content: string;
  locatorJson: string;
}

/** One channel's ranked hits in descending relevance. */
interface ChannelHit {
  chunkId: string;
  score: number;
}

/**
 * Searches persisted chunks with two independent channels and fuses their rankings.
 *
 * Lexical recall covers exact terms and Chinese bigrams; dense recall covers paraphrases. RRF is used
 * because BM25 scores are unbounded and cosine is bounded, so score summation would need calibration.
 * Either channel may be empty; fusion still returns the other channel's ranking.
 */
@Injectable()
export class RetrievalService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly embeddings: EmbeddingService,
    @Optional() @Inject(QUERY_EXPANDER) private readonly expander?: QueryExpander,
  ) {}

  /** Runs lexical and dense recall, optionally adds LLM-expanded terms, and fuses the ranking. */
  async search(request: RetrievalRequest): Promise<RetrievalHit[]> {
    const limit = request.limit ?? DEFAULT_LIMIT;
    const query = request.query?.trim() ?? '';
    if (query === '' || limit <= 0) return [];

    const [lexical, dense] = await Promise.all([
      this.searchLexical(query, request.documentIds),
      this.searchDense(query, request.documentIds, request.minVectorScore ?? MIN_VECTOR_SCORE),
    ]);

    // Expansion costs a model round-trip, so it only runs when literal terms under-deliver. It is
    // strictly additive: the original terms keep their own ranked list and therefore their rank.
    let expanded: ChannelHit[] = [];
    if (this.expander && request.expand !== false && lexical.length < EXPAND_BELOW_LEXICAL_HITS) {
      expanded = await this.searchExpanded(query, request.documentIds);
    }

    const fused = this.fuse(lexical, dense, expanded).slice(0, limit);
    if (fused.length === 0) return [];
    return this.hydrate(fused);
  }

  /** Runs the expansion channel; any failure means "no expansion", never a failed search. */
  private async searchExpanded(query: string, documentIds?: string[]): Promise<ChannelHit[]> {
    if (!this.expander) return [];
    try {
      const expansion = await this.expander.expand(query);
      if (!expansion) return [];
      const match = buildExpansionMatchQuery(expansion);
      if (!match) return [];
      return await this.searchLexicalByMatch(match, documentIds);
    } catch {
      return [];
    }
  }

  /** Runs the FTS5 channel for the query terms; returns no hits when nothing is indexable. */
  private async searchLexical(query: string, documentIds?: string[]): Promise<ChannelHit[]> {
    const match = buildMatchQuery(query);
    if (!match) return [];
    return this.searchLexicalByMatch(match, documentIds);
  }

  /** Runs one FTS5 MATCH expression and returns chunks ordered by bm25. */
  private async searchLexicalByMatch(
    match: string,
    documentIds?: string[],
  ): Promise<ChannelHit[]> {
    const scope = documentIds && documentIds.length > 0 ? documentIds : undefined;
    const rows = await this.dataSource.query<Array<{ chunkId: string; score: number }>>(
      `SELECT t."chunkId" AS chunkId, bm25(chunk_fts, 5.0, 1.0) AS score
         FROM chunk_fts
         JOIN chunk_search_terms t ON t.rowid = chunk_fts.rowid
         JOIN document_chunks c ON c.id = t."chunkId"
        WHERE chunk_fts MATCH ?
          ${scope ? `AND c."documentVersionId" IN (SELECT id FROM document_versions WHERE "documentId" IN (${scope.map(() => '?').join(', ')}))` : ''}
        ORDER BY score
        LIMIT ?`,
      scope ? [match, ...scope, CHANNEL_DEPTH] : [match, CHANNEL_DEPTH],
    );
    // FTS5 bm25() is negative (lower is better); flip so callers see a monotonic score.
    return rows.map((row) => ({ chunkId: row.chunkId, score: -Number(row.score) }));
  }

  /** Runs the dense channel by scoring the active model's vectors in process. */
  private async searchDense(
    query: string,
    documentIds?: string[],
    minScore = MIN_VECTOR_SCORE,
  ): Promise<ChannelHit[]> {
    let queryVector: Float32Array;
    try {
      queryVector = await this.embeddings.embedOne(query);
    } catch {
      // Embeddings unavailable: retrieval degrades to the lexical channel instead of failing.
      return [];
    }

    const scope = documentIds && documentIds.length > 0 ? documentIds : undefined;
    const rows = await this.dataSource.query<VectorRow[]>(
      `SELECT "chunkId", "documentId", "documentVersionId", "vector"
         FROM chunk_embeddings
        WHERE "embeddingModel" = ? AND "embeddingDim" = ?
          ${scope ? `AND "documentId" IN (${scope.map(() => '?').join(', ')})` : ''}`,
      scope
        ? [this.embeddings.modelId, this.embeddings.dimension, ...scope]
        : [this.embeddings.modelId, this.embeddings.dimension],
    );

    const hits: ChannelHit[] = [];
    for (const row of rows) {
      const vector = toFloat32(row.vector);
      if (vector.length !== queryVector.length) continue;
      let dot = 0;
      for (let index = 0; index < vector.length; index += 1) dot += vector[index] * queryVector[index];
      if (dot <= minScore) continue;
      hits.push({ chunkId: row.chunkId, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, CHANNEL_DEPTH);
  }

  /** Fuses ranked lists with RRF, penalising expanded terms so literal matches still lead. */
  private fuse(
    lexical: ChannelHit[],
    dense: ChannelHit[],
    expanded: ChannelHit[],
  ): Array<RetrievalHit> {
    const merged = new Map<string, RetrievalHit>();
    const add = (
      hits: ChannelHit[],
      channel: 'lexical' | 'vector' | 'expanded',
    ): void => {
      const offset = channel === 'expanded' ? EXPANSION_RANK_OFFSET : 0;
      hits.forEach((hit, rank) => {
        const boost = 1 / (RRF_K + rank + offset + 1);
        const existing = merged.get(hit.chunkId);
        if (existing) {
          existing.score.rrf += boost;
          if (channel === 'lexical') {
            existing.score.lexicalRank = rank;
            existing.score.lexicalScore = hit.score;
          } else if (channel === 'vector') {
            existing.score.vectorRank = rank;
            existing.score.vectorScore = hit.score;
          } else {
            existing.score.expandedRank = rank;
            existing.score.expandedScore = hit.score;
          }
          return;
        }
        const score: RetrievalScore = { rrf: boost };
        if (channel === 'lexical') {
          score.lexicalRank = rank;
          score.lexicalScore = hit.score;
        } else if (channel === 'vector') {
          score.vectorRank = rank;
          score.vectorScore = hit.score;
        } else {
          score.expandedRank = rank;
          score.expandedScore = hit.score;
        }
        merged.set(hit.chunkId, {
          chunkId: hit.chunkId,
          documentId: '',
          documentVersionId: '',
          content: '',
          locatorJson: '',
          score,
        });
      });
    };
    add(lexical, 'lexical');
    add(dense, 'vector');
    add(expanded, 'expanded');
    return [...merged.values()].sort((a, b) => b.score.rrf - a.score.rrf);
  }

  /** Loads chunk content and locator for the fused hits, preserving fused order. */
  private async hydrate(hits: Array<RetrievalHit>): Promise<RetrievalHit[]> {
    const ids = hits.map((hit) => hit.chunkId);
    const rows = await this.dataSource.query<ChunkRow[]>(
      `SELECT c.id AS id, c.content AS content, c."locatorJson" AS locatorJson,
              c."documentVersionId" AS documentVersionId, v."documentId" AS documentId
         FROM document_chunks c
         JOIN document_versions v ON v.id = c."documentVersionId"
        WHERE c.id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return hits
      .map((hit) => {
        const row = byId.get(hit.chunkId);
        if (!row) return null;
        return {
          ...hit,
          documentId: row.documentId,
          documentVersionId: row.documentVersionId,
          content: row.content,
          locatorJson: row.locatorJson,
        };
      })
      .filter((hit): hit is RetrievalHit => hit !== null);
  }
}

/** Reinterprets a BLOB as Float32Array without copying when the buffer is already aligned. */
function toFloat32(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
