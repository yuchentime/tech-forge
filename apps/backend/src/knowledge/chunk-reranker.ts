import { Injectable, Logger } from '@nestjs/common';
import { DEEPSEEK_BASE_URL } from '../llm/adapters/llm-adapter';
import { SettingsService, type StoredLlmSettings } from '../settings/settings.service';

/** Injection token so tests and future local cross-encoders can swap the implementation. */
export const CHUNK_RERANKER = 'CHUNK_RERANKER';

/** Hard budget for one rerank call; the user asked for knowledge, so waiting beats skipping. */
export const RERANK_TIMEOUT_MS = 1500;
/** Candidates sent to the model. Beyond this the prompt grows faster than the ranking improves. */
export const RERANK_CANDIDATE_LIMIT = 24;
/** Excerpt length per candidate; the opening of a chunk carries nearly all of its topic signal. */
const RERANK_SNIPPET_CHARS = 320;

/** One chunk offered to the reranker. */
export interface RerankCandidate {
  chunkId: string;
  title: string;
  headingPath: string[];
  content: string;
}

/** Reorders recalled chunks by usefulness for one question. */
export interface ChunkReranker {
  /**
   * Returns chunk ids in preferred order, best first, or `null` when reranking is unavailable.
   * Callers keep the fusion order on `null`: reranking must never fail a knowledge turn.
   */
  rank(
    query: string,
    candidates: readonly RerankCandidate[],
    signal?: AbortSignal,
  ): Promise<string[] | null>;
}

/** Provider endpoint and credentials resolved from local settings. */
interface ProviderConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

/** Resolves the OpenAI-compatible endpoint for the provider the user selected. */
function resolveProvider(settings: StoredLlmSettings): ProviderConfig {
  if (settings.provider === 'custom') {
    return {
      baseUrl: settings.custom.baseUrl.replace(/\/$/, ''),
      modelId: settings.custom.modelId,
      apiKey: settings.custom.apiKey,
    };
  }
  return {
    baseUrl: DEEPSEEK_BASE_URL,
    modelId: settings.deepseek.modelId,
    apiKey: settings.deepseek.apiKey,
  };
}

/**
 * Reranks recalled chunks with the locally configured chat model.
 *
 * No new disclosure: the selected chunks are injected into the same provider's prompt for the answer
 * anyway, so ranking them here adds a round-trip, not a new recipient. Any failure (no key, timeout,
 * unparseable reply) returns `null` and retrieval keeps its fusion order.
 */
@Injectable()
export class LlmChunkReranker implements ChunkReranker {
  private readonly logger = new Logger(LlmChunkReranker.name);

  constructor(private readonly settings: SettingsService) {}

  /** Asks the model to order the candidates; bounded by RERANK_TIMEOUT_MS. */
  async rank(
    query: string,
    candidates: readonly RerankCandidate[],
    signal?: AbortSignal,
  ): Promise<string[] | null> {
    if (candidates.length <= 1) return null;
    const trimmed = query.trim();
    if (trimmed === '') return null;

    let provider: ProviderConfig;
    try {
      provider = resolveProvider(await this.settings.getLlmSettings());
    } catch {
      return null;
    }
    if (!provider.apiKey || !provider.baseUrl) return null;

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.modelId,
          temperature: 0,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content:
                '你是检索结果重排器。给定用户问题和若干候选片段，按"能否直接回答问题或提供依据"排序。' +
                '只输出 JSON：{"order": [片段编号, ...]}，编号从 1 开始，只保留确实相关的片段，最多 10 个，不要解释。',
            },
            {
              role: 'user',
              content: candidates
                .map(
                  (candidate, index) =>
                    `[${index + 1}] ${candidate.title}${candidate.headingPath.length > 0 ? ` · ${candidate.headingPath.join(' / ')}` : ''}\n${candidate.content
                      .replace(/\s+/g, ' ')
                      .slice(0, RERANK_SNIPPET_CHARS)}`,
                )
                .join('\n\n'),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.debug(`重排失败：HTTP ${response.status}`);
        return null;
      }
      const payload: unknown = await response.json();
      const content = readMessageContent(payload);
      if (!content) return null;
      return sanitizeOrder(extractJsonObject(content), candidates);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`重排异常：${message}`);
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

/** Extracts the first JSON object from a model reply that may include fences or prose. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Reads `choices[0].message.content` without trusting the response shape. */
function readMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (!('choices' in payload) || !Array.isArray(payload.choices)) return null;
  const choice: unknown = payload.choices[0];
  if (!choice || typeof choice !== 'object' || !('message' in choice)) return null;
  const message = choice.message;
  if (!message || typeof message !== 'object' || !('content' in message)) return null;
  return typeof message.content === 'string' ? message.content : null;
}

/** Converts 1-based indices into chunk ids, dropping duplicates, out-of-range and non-integers. */
function sanitizeOrder(raw: unknown, candidates: readonly RerankCandidate[]): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const order = (raw as { order?: unknown }).order;
  if (!Array.isArray(order)) return null;
  const ids: string[] = [];
  const seen = new Set<number>();
  for (const value of order) {
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    const index = value - 1;
    if (index < 0 || index >= candidates.length || seen.has(index)) continue;
    seen.add(index);
    ids.push(candidates[index].chunkId);
  }
  return ids.length > 0 ? ids : null;
}
