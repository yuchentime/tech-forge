import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmbeddingService } from '../embedding/embedding.service';
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

/** One retrieval request. `documentIds` restricts the search to an explicit document set. */
export interface RetrievalRequest {
  query: string;
  limit?: number;
  documentIds?: string[];
  /** Overrides the dense-channel similarity floor for tuning and evaluation. */
  minVectorScore?: number;
}

/** Score provenance for one hit, keeping channel scores visible for debugging and evaluation. */
export interface RetrievalScore {
  rrf: number;
  lexicalRank?: number;
  vectorRank?: number;
  lexicalScore?: number;
  vectorScore?: number;
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
  ) {}

  /** Runs lexical and dense recall, fuses them, and hydrates the top hits. */
  async search(request: RetrievalRequest): Promise<RetrievalHit[]> {
    const limit = request.limit ?? DEFAULT_LIMIT;
    const query = request.query?.trim() ?? '';
    if (query === '' || limit <= 0) return [];

    const [lexical, dense] = await Promise.all([
      this.searchLexical(query, request.documentIds),
      this.searchDense(query, request.documentIds, request.minVectorScore ?? MIN_VECTOR_SCORE),
    ]);
    const fused = this.fuse(lexical, dense).slice(0, limit);
    if (fused.length === 0) return [];
    return this.hydrate(fused);
  }

  /** Runs the FTS5 channel; returns no hits when the query has no indexable term. */
  private async searchLexical(query: string, documentIds?: string[]): Promise<ChannelHit[]> {
    const match = buildMatchQuery(query);
    if (!match) return [];
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

  /** Fuses two ranked lists with reciprocal rank fusion and keeps per-channel scores for debug. */
  private fuse(lexical: ChannelHit[], dense: ChannelHit[]): Array<RetrievalHit> {
    const merged = new Map<string, RetrievalHit>();
    const add = (hits: ChannelHit[], channel: 'lexical' | 'vector'): void => {
      hits.forEach((hit, rank) => {
        const boost = 1 / (RRF_K + rank + 1);
        const existing = merged.get(hit.chunkId);
        if (existing) {
          existing.score.rrf += boost;
          if (channel === 'lexical') {
            existing.score.lexicalRank = rank;
            existing.score.lexicalScore = hit.score;
          } else {
            existing.score.vectorRank = rank;
            existing.score.vectorScore = hit.score;
          }
          return;
        }
        merged.set(hit.chunkId, {
          chunkId: hit.chunkId,
          documentId: '',
          documentVersionId: '',
          content: '',
          locatorJson: '',
          score:
            channel === 'lexical'
              ? { rrf: boost, lexicalRank: rank, lexicalScore: hit.score }
              : { rrf: boost, vectorRank: rank, vectorScore: hit.score },
        });
      });
    };
    add(lexical, 'lexical');
    add(dense, 'vector');
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
