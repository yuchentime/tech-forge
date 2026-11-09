import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmbeddingService } from '../embedding/embedding.service';
import {
  clipLogText,
  getSafeErrorLogFields,
  writeStructuredEvent,
} from '../logging/structured-logger';
import { buildExpansionMatchQuery, QUERY_EXPANDER, type QueryExpander } from './query-expander';
import { buildDistinctiveMatchQuery, buildMatchQuery, singleHanCharacter } from './text-normalizer';

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
/** Cap for the generated FTS5 MATCH expression kept in one debug line. */
const LEXICAL_MATCH_LOG_MAX_CHARS = 300;

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

/** Source document metadata attached to every hit so callers can cite or open the file. */
export interface RetrievedDocument {
  id: string;
  title: string;
  /** Original file name of the indexed version. */
  fileName: string;
  /** Workspace-relative path of the copied source file. */
  path: string;
}

/** One retrieved chunk with everything a citation needs. */
export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  content: string;
  locatorJson: string;
  document: RetrievedDocument;
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
  title: string;
  fileName: string;
  path: string;
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
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly embeddings: EmbeddingService,
    @Optional() @Inject(QUERY_EXPANDER) private readonly expander?: QueryExpander,
  ) {}

  /**
   * Runs lexical and dense recall, optionally adds LLM-expanded terms, and fuses the ranking.
   *
   * Emits one `retrieval.search.completed` line per non-trivial call with per-channel hit counts,
   * per-channel elapsed time and the reason an empty result happened. Channel failures are logged
   * where they degrade the search (dense embedding, query expansion) so a thin result set is
   * diagnosable without reproducing the request.
   */
  async search(request: RetrievalRequest): Promise<RetrievalHit[]> {
    const limit = request.limit ?? DEFAULT_LIMIT;
    const query = request.query?.trim() ?? '';
    const startedAt = Date.now();
    if (query === '' || limit <= 0) {
      writeStructuredEvent(this.logger, 'warn', 'retrieval.search.skipped', {
        reason: query === '' ? 'empty_query' : 'non_positive_limit',
        queryLength: Array.from(request.query ?? '').length,
        limit,
      });
      return [];
    }

    const [[lexical, lexicalMs], [dense, denseMs]] = await Promise.all([
      measure(() => this.searchLexical(query, request.documentIds)),
      measure(() =>
        this.searchDense(query, request.documentIds, request.minVectorScore ?? MIN_VECTOR_SCORE),
      ),
    ]);

    // Expansion costs a model round-trip, so it only runs when literal terms under-deliver. It is
    // strictly additive: the original terms keep their own ranked list and therefore their rank.
    const expansionRequested =
      Boolean(this.expander) &&
      request.expand !== false &&
      lexical.length < EXPAND_BELOW_LEXICAL_HITS;
    let expanded: ChannelHit[] = [];
    let expansionMs = 0;
    if (expansionRequested) {
      [expanded, expansionMs] = await measure(() =>
        this.searchExpanded(query, request.documentIds),
      );
    }

    const fused = this.fuse(lexical, dense, expanded).slice(0, limit);
    const hits = fused.length === 0 ? [] : await this.hydrate(fused);
    const candidateCount = lexical.length + dense.length + expanded.length;
    writeStructuredEvent(this.logger, 'log', 'retrieval.search.completed', {
      query: clipLogText(query),
      queryLength: Array.from(query).length,
      limit,
      scopedDocumentCount: request.documentIds?.length ?? 0,
      lexicalHitCount: lexical.length,
      denseHitCount: dense.length,
      expandedHitCount: expanded.length,
      expansion: expansionRequested
        ? expanded.length > 0
          ? 'used'
          : 'no_hits'
        : 'skipped',
      fusedCount: fused.length,
      hitCount: hits.length,
      hydrateDroppedCount: fused.length - hits.length,
      outcome:
        hits.length > 0 ? 'hit' : candidateCount === 0 ? 'no_candidates' : 'hydrate_missing',
      durationMs: Date.now() - startedAt,
      lexicalDurationMs: lexicalMs,
      denseDurationMs: denseMs,
      expansionDurationMs: expansionMs,
      topChunkIds: hits.slice(0, 3).map((hit) => hit.chunkId),
    });
    return hits;
  }

  /** Runs the expansion channel; any failure means "no expansion", never a failed search. */
  private async searchExpanded(query: string, documentIds?: string[]): Promise<ChannelHit[]> {
    if (!this.expander) return [];
    try {
      const expansion = await this.expander.expand(query);
      if (!expansion) {
        writeStructuredEvent(this.logger, 'debug', 'retrieval.expansion.empty', {
          query: clipLogText(query),
        });
        return [];
      }
      const match = buildExpansionMatchQuery(expansion);
      writeStructuredEvent(this.logger, 'debug', 'retrieval.expansion.terms', {
        query: clipLogText(query),
        keywords: expansion.keywords.map((keyword) => clipLogText(keyword, 60)),
        correctedQuery: expansion.correctedQuery
          ? clipLogText(expansion.correctedQuery)
          : undefined,
        match: clipLogText(match, LEXICAL_MATCH_LOG_MAX_CHARS),
        usable: Boolean(match),
      });
      if (!match) return [];
      return await this.searchLexicalByMatch(match, documentIds, 'expanded');
    } catch (error) {
      writeStructuredEvent(this.logger, 'debug', 'retrieval.expansion.failed', {
        query: clipLogText(query),
        ...getSafeErrorLogFields(error),
      });
      return [];
    }
  }

  /**
   * Runs the FTS5 channel for the query terms; returns no hits when nothing is indexable.
   *
   * Specific names are tried first. A question that names its subject ("… EDMA …") must not lose to a
   * long document that merely shares the question's generic words, and measured on a real corpus it
   * did. Falling back to the broad expression keeps ordinary questions unchanged.
   */
  private async searchLexical(query: string, documentIds?: string[]): Promise<ChannelHit[]> {
    const singleCharacter = singleHanCharacter(query);
    if (singleCharacter) return this.searchSubstring(singleCharacter, documentIds);
    const distinctive = buildDistinctiveMatchQuery(query);
    if (distinctive) {
      const focused = await this.searchLexicalByMatch(distinctive, documentIds, 'lexical');
      if (focused.length > 0) return focused;
    }
    const match = buildMatchQuery(query);
    if (!match) {
      writeStructuredEvent(this.logger, 'warn', 'retrieval.lexical.no_indexable_terms', {
        query: clipLogText(query),
        queryLength: Array.from(query).length,
      });
      return [];
    }
    return this.searchLexicalByMatch(match, documentIds, 'lexical');
  }

  /**
   * Scans chunk content for one Han character.
   *
   * The bigram index cannot answer single-character queries, and a LIKE scan over a personal corpus
   * (thousands of chunks) costs a few milliseconds, so this stays a first-class channel instead of a
   * special case in the caller.
   */
  private async searchSubstring(
    character: string,
    documentIds?: string[],
  ): Promise<ChannelHit[]> {
    const scope = documentIds && documentIds.length > 0 ? documentIds : undefined;
    const rows = await this.dataSource.query<Array<{ chunkId: string }>>(
      `SELECT c.id AS chunkId
         FROM document_chunks c
         JOIN document_versions v ON v.id = c."documentVersionId"
        WHERE c.content LIKE '%' || ? || '%'
          ${scope ? `AND v."documentId" IN (${scope.map(() => '?').join(', ')})` : ''}
        ORDER BY c."documentVersionId", c."sequenceNo"
        LIMIT ?`,
      scope ? [character, ...scope, CHANNEL_DEPTH] : [character, CHANNEL_DEPTH],
    );
    writeStructuredEvent(this.logger, 'debug', 'retrieval.lexical.substring_scanned', {
      character,
      scopedDocumentCount: scope?.length ?? 0,
      rowCount: rows.length,
    });
    return rows.map((row, rank) => ({ chunkId: row.chunkId, score: CHANNEL_DEPTH - rank }));
  }

  /** Runs one FTS5 MATCH expression and returns chunks ordered by bm25. */
  private async searchLexicalByMatch(
    match: string,
    documentIds: string[] | undefined,
    channel: 'lexical' | 'expanded',
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
    writeStructuredEvent(this.logger, 'debug', 'retrieval.lexical.matched', {
      channel,
      match: clipLogText(match, LEXICAL_MATCH_LOG_MAX_CHARS),
      scopedDocumentCount: scope?.length ?? 0,
      rowCount: rows.length,
      topScore: rows.length > 0 ? Number((-Number(rows[0].score)).toFixed(4)) : undefined,
    });
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
    } catch (error) {
      // Embeddings unavailable: retrieval degrades to the lexical channel instead of failing.
      writeStructuredEvent(this.logger, 'warn', 'retrieval.dense_channel.failed', {
        query: clipLogText(query),
        modelId: this.embeddings.modelId,
        // Embedding failures are technical (missing model file, load error), not user content.
        detail: clipLogText(error instanceof Error ? error.message : String(error)),
        ...getSafeErrorLogFields(error),
      });
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
    let skippedByWidth = 0;
    let skippedByFloor = 0;
    let bestBelowFloor = 0;
    for (const row of rows) {
      const vector = toFloat32(row.vector);
      if (vector.length !== queryVector.length) {
        skippedByWidth += 1;
        continue;
      }
      let dot = 0;
      for (let index = 0; index < vector.length; index += 1) dot += vector[index] * queryVector[index];
      if (dot <= minScore) {
        skippedByFloor += 1;
        bestBelowFloor = Math.max(bestBelowFloor, dot);
        continue;
      }
      hits.push({ chunkId: row.chunkId, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    writeStructuredEvent(this.logger, 'debug', 'retrieval.dense_channel.scored', {
      modelId: this.embeddings.modelId,
      dimension: this.embeddings.dimension,
      scopedDocumentCount: scope?.length ?? 0,
      vectorRowCount: rows.length,
      acceptedCount: hits.length,
      skippedByWidth,
      skippedByFloor,
      bestBelowFloor: Number(bestBelowFloor.toFixed(4)),
      topScore: hits.length > 0 ? Number(hits[0].score.toFixed(4)) : undefined,
    });
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
          document: { id: '', title: '', fileName: '', path: '' },
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
              c."documentVersionId" AS documentVersionId, v."documentId" AS documentId,
              d.title AS title, v."originalName" AS fileName, v."workspaceRelativePath" AS path
         FROM document_chunks c
         JOIN document_versions v ON v.id = c."documentVersionId"
         JOIN documents d ON d.id = v."documentId"
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
          document: {
            id: row.documentId,
            title: row.title,
            fileName: row.fileName,
            path: row.path,
          },
        };
      })
      .filter((hit): hit is RetrievalHit => hit !== null);
  }
}

/** Runs one channel and returns its value with the elapsed milliseconds recorded for the trace. */
async function measure<T>(run: () => Promise<T>): Promise<[T, number]> {
  const startedAt = Date.now();
  const value = await run();
  return [value, Date.now() - startedAt];
}

/** Reinterprets a BLOB as Float32Array without copying when the buffer is already aligned. */
function toFloat32(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
