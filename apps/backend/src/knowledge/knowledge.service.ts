import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { getChunkTokenCounter } from '../documents/chunking/token-counter';
import {
  clipLogText,
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';
// Value import: `emitDecoratorMetadata` needs the class at runtime for Nest DI.
import { RetrievalService, type RetrievalHit } from '../retrieval/retrieval.service';
import {
  CHUNK_RERANKER,
  RERANK_CANDIDATE_LIMIT,
  type ChunkReranker,
} from './chunk-reranker';

/**
 * Chunks injected per knowledge turn.
 *
 * Chunks are ~500 tokens at most, so eight sits around 4k tokens: enough for a definition, a worked
 * example and the passage a challenge can be checked against, without crowding the conversation. The
 * real corpus (1688 chunks) showed that answering from ten or more passages starts mixing unrelated
 * material, while fewer than six leaves the answer without enough evidence to cite.
 */
export const KNOWLEDGE_CHUNK_LIMIT = 8;

/** Why a knowledge turn produced only a notice instead of chunk text. */
export type KnowledgeContextOutcome =
  | 'injected'
  | 'no_scope'
  | 'no_hits'
  | 'already_loaded';

/** One injected chunk, in the shape persisted to `messages.contextRefsJson`. */
export interface KnowledgeChunkRef {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  title: string;
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
}

/** What one knowledge turn contributes to the model request. */
export interface KnowledgeContextResult {
  outcome: KnowledgeContextOutcome;
  /** Text to prepend to the system prompt; a notice when nothing was injected. */
  text: string;
  refs: KnowledgeChunkRef[];
  stats: {
    scopeDocuments: number;
    candidateChunks: number;
    skippedAlreadyLoaded: number;
    reranked: boolean;
    injectedChunks: number;
    injectedTokens: number;
    elapsedMs: number;
  };
}

/** Reads a request-scoped knowledge context from the local library. */
export interface KnowledgeContextInput {
  conversationId: string;
  query: string;
  /** Chunk ids already present in the conversation's stored context refs. */
  loadedChunkIds: string[];
  /** Explicit per-conversation document selection; empty means the default range. */
  explicitDocumentIds?: readonly string[];
  logContext?: RequestLogContext;
  /** Cancels the rerank call when the turn is aborted. */
  signal?: AbortSignal;
}

/**
 * Builds the knowledge context for an explicitly requested turn.
 *
 * Retrieval ranks chunks; the model receives the best few with their citation anchors. Whole
 * documents were tried first and dropped: reconstructing text, budgeting per document and ranking
 * documents added three layers of machinery to save one tool call, while spending 15k+ tokens per
 * turn on passages the model usually did not need.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly documents: DocumentsService,
    private readonly retrieval: RetrievalService,
    @Optional() @Inject(CHUNK_RERANKER) private readonly reranker?: ChunkReranker,
  ) {}

  /** Resolves scope, recalls chunks, reranks when available, and renders the prompt block. */
  async buildContext(input: KnowledgeContextInput): Promise<KnowledgeContextResult> {
    const startedAt = Date.now();
    const logContext = input.logContext ?? {};
    const scopeIds = await this.documents.resolveKnowledgeScope(
      input.conversationId,
      input.explicitDocumentIds,
    );
    if (scopeIds.length === 0) {
      writeStructuredEvent(this.logger, 'warn', 'knowledge.context.empty_scope', {
        ...logContext,
        conversationId: input.conversationId,
      });
      return this.result('no_scope', NOTICE_NO_SCOPE, [], {
        scopeDocuments: 0,
        candidateChunks: 0,
        skippedAlreadyLoaded: 0,
        reranked: false,
        injectedChunks: 0,
        injectedTokens: 0,
        elapsedMs: Date.now() - startedAt,
      });
    }

    // Expansion stays off: the scope is already narrow and rerank does the precision work.
    const hits = await this.retrieval.search({
      query: input.query,
      limit: RERANK_CANDIDATE_LIMIT,
      documentIds: scopeIds,
      expand: false,
    });
    const loaded = new Set(input.loadedChunkIds);
    const fresh = hits.filter((hit) => !loaded.has(hit.chunkId));
    const skippedAlreadyLoaded = hits.length - fresh.length;

    if (hits.length === 0) {
      writeStructuredEvent(this.logger, 'log', 'knowledge.context.no_hits', {
        ...logContext,
        conversationId: input.conversationId,
        query: clipLogText(input.query),
        scopeDocuments: scopeIds.length,
        elapsedMs: Date.now() - startedAt,
      });
      return this.result('no_hits', NOTICE_NO_HITS, [], {
        scopeDocuments: scopeIds.length,
        candidateChunks: 0,
        skippedAlreadyLoaded: 0,
        reranked: false,
        injectedChunks: 0,
        injectedTokens: 0,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (fresh.length === 0) {
      writeStructuredEvent(this.logger, 'log', 'knowledge.context.already_loaded', {
        ...logContext,
        conversationId: input.conversationId,
        query: clipLogText(input.query),
        candidateChunks: hits.length,
        elapsedMs: Date.now() - startedAt,
      });
      return this.result('already_loaded', NOTICE_ALREADY_LOADED, [], {
        scopeDocuments: scopeIds.length,
        candidateChunks: hits.length,
        skippedAlreadyLoaded,
        reranked: false,
        injectedChunks: 0,
        injectedTokens: 0,
        elapsedMs: Date.now() - startedAt,
      });
    }

    const { ordered, reranked } = await this.rerank(input, fresh);
    const selected = ordered.slice(0, KNOWLEDGE_CHUNK_LIMIT);
    const refs = selected.map(toChunkRef);
    const counter = getChunkTokenCounter();
    const text = [HEADER, ...selected.map((hit, index) => renderChunk(index, hit))].join('\n\n');
    const injectedTokens = counter.count(text);
    const stats = {
      scopeDocuments: scopeIds.length,
      candidateChunks: hits.length,
      skippedAlreadyLoaded,
      reranked,
      injectedChunks: refs.length,
      injectedTokens,
      elapsedMs: Date.now() - startedAt,
    };

    writeStructuredEvent(this.logger, 'log', 'knowledge.context.injected', {
      ...logContext,
      conversationId: input.conversationId,
      query: clipLogText(input.query),
      chunks: refs.map((ref) => ({
        chunkId: ref.chunkId,
        documentId: ref.documentId,
        title: ref.title,
        headingPath: ref.headingPath,
        pageStart: ref.pageStart,
      })),
      ...stats,
    });

    return { outcome: 'injected', text, refs, stats };
  }

  /** Serialises the refs for `messages.contextRefsJson`, the durable record of what was injected. */
  toContextRefsJson(result: KnowledgeContextResult, query: string): string | null {
    if (result.refs.length === 0) return null;
    return JSON.stringify({
      knowledge: {
        query,
        triggeredBy: 'command',
        chunks: result.refs,
      },
    });
  }

  /**
   * Applies the reranker, then appends the chunks it did not mention.
   *
   * Reranking only reorders: a candidate the model left out is still a valid hit, and dropping it
   * would turn a ranking step into a recall regression when the reply is short.
   */
  private async rerank(
    input: KnowledgeContextInput,
    hits: RetrievalHit[],
  ): Promise<{ ordered: RetrievalHit[]; reranked: boolean }> {
    if (!this.reranker) return { ordered: hits, reranked: false };
    try {
      const order = await this.reranker.rank(
        input.query,
        hits.map((hit) => ({
          chunkId: hit.chunkId,
          title: hit.document.title,
          headingPath: readHeadingPath(hit.locatorJson),
          content: hit.content,
        })),
        input.signal,
      );
      if (!order) {
        writeStructuredEvent(this.logger, 'debug', 'knowledge.rerank.skipped', {
          ...(input.logContext ?? {}),
          candidateChunks: hits.length,
        });
        return { ordered: hits, reranked: false };
      }
      const byId = new Map(hits.map((hit) => [hit.chunkId, hit]));
      const ordered = order.flatMap((chunkId) => {
        const hit = byId.get(chunkId);
        return hit ? [hit] : [];
      });
      const placed = new Set(ordered.map((hit) => hit.chunkId));
      return { ordered: [...ordered, ...hits.filter((hit) => !placed.has(hit.chunkId))], reranked: true };
    } catch (error) {
      writeStructuredEvent(this.logger, 'warn', 'knowledge.rerank.failed', {
        ...(input.logContext ?? {}),
        candidateChunks: hits.length,
        ...getSafeErrorLogFields(error),
      });
      return { ordered: hits, reranked: false };
    }
  }

  /** Builds a notice-only result with the shared stats shape. */
  private result(
    outcome: KnowledgeContextOutcome,
    notice: string,
    refs: KnowledgeChunkRef[],
    stats: KnowledgeContextResult['stats'],
  ): KnowledgeContextResult {
    return { outcome, text: notice, refs, stats };
  }
}

/** Prompt block header; states that the library was consulted so the model cannot claim otherwise. */
const HEADER = '## 资料库检索结果（用户本轮显式要求查阅资料库）';

/** Shown to the model when the conversation has no readable documents. */
const NOTICE_NO_SCOPE = '用户要求查阅资料库，但当前会话没有可检索的资料。请明确告知用户资料库为空或尚未关联资料。';

/** Shown when retrieval found nothing in scope. */
const NOTICE_NO_HITS = '用户要求查阅资料库，已检索但没有找到与该问题相关的内容。请如实说明，不要凭记忆代替资料内容。';

/** Shown when every recalled chunk is already present in the conversation history. */
const NOTICE_ALREADY_LOADED =
  '用户要求查阅资料库。相关片段已经在本次对话更早的上下文中，请直接使用已加载内容，不要声称未查阅。';

/** Reads the heading trail for citation; a malformed locator must not fail the turn. */
function readHeadingPath(locatorJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(locatorJson);
    if (!parsed || typeof parsed !== 'object') return [];
    const headingPath = (parsed as { headingPath?: unknown }).headingPath;
    return Array.isArray(headingPath)
      ? headingPath.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Reads page bounds from a stored locator. */
function readPages(locatorJson: string): { pageStart: number | null; pageEnd: number | null } {
  try {
    const parsed: unknown = JSON.parse(locatorJson);
    if (!parsed || typeof parsed !== 'object') return { pageStart: null, pageEnd: null };
    const record = parsed as { pageStart?: unknown; pageEnd?: unknown };
    return {
      pageStart: typeof record.pageStart === 'number' ? record.pageStart : null,
      pageEnd: typeof record.pageEnd === 'number' ? record.pageEnd : null,
    };
  } catch {
    return { pageStart: null, pageEnd: null };
  }
}

/** Maps one recalled chunk to its persisted citation ref. */
function toChunkRef(hit: RetrievalHit): KnowledgeChunkRef {
  const pages = readPages(hit.locatorJson);
  return {
    chunkId: hit.chunkId,
    documentId: hit.documentId,
    documentVersionId: hit.documentVersionId,
    title: hit.document.title,
    headingPath: readHeadingPath(hit.locatorJson),
    pageStart: pages.pageStart,
    pageEnd: pages.pageEnd,
  };
}

/** Renders one chunk with everything a citation needs: document, heading trail and page. */
function renderChunk(index: number, hit: RetrievalHit): string {
  const pages = readPages(hit.locatorJson);
  const headingPath = readHeadingPath(hit.locatorJson);
  const where = [
    `资料：${hit.document.title}`,
    headingPath.length > 0 ? `章节：${headingPath.join(' / ')}` : null,
    pages.pageStart === null ? null : `页码：${pages.pageStart}`,
  ]
    .filter((part): part is string => part !== null)
    .join('；');
  return `### 片段 ${index + 1}（${where}）\n${hit.content}`;
}
