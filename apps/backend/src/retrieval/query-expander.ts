import { Injectable, Logger } from '@nestjs/common';
import { DEEPSEEK_BASE_URL } from '../llm/adapters/llm-adapter';
import { SettingsService, type StoredLlmSettings } from '../settings/settings.service';
import { buildMatchQuery } from './text-normalizer';

/** Injection token so tests and future settings can swap the expander implementation. */
export const QUERY_EXPANDER = 'QUERY_EXPANDER';

/** Hard budget for one expansion call; retrieval must not wait longer than this. */
export const EXPANSION_TIMEOUT_MS = 800;
/** Maximum keywords accepted from the model. */
const MAX_KEYWORDS = 8;
/** Longest accepted keyword; longer output is treated as prose, not a term. */
const MAX_KEYWORD_CHARS = 20;

/** Additive query expansion produced by a language model. */
export interface QueryExpansion {
  /** Alternative terms, synonyms and domain jargon. */
  keywords: string[];
  /** The query with typos or OCR artefacts repaired, when the model is confident. */
  correctedQuery?: string;
}

/** Produces an additive expansion for one query; returns null when unavailable or not useful. */
export interface QueryExpander {
  expand(query: string, signal?: AbortSignal): Promise<QueryExpansion | null>;
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

/** Strips code fences and isolates the first JSON object in a model reply. */
function extractJsonObject(raw: string): unknown {
  const withoutFence = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Normalises model output: bounded count, bounded length, deduplicated, original terms removed. */
function sanitizeExpansion(raw: unknown, query: string): QueryExpansion | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const keywordsRaw = Array.isArray(record.keywords) ? record.keywords : [];
  const seen = new Set<string>([query.trim().toLowerCase()]);
  const keywords: string[] = [];
  for (const value of keywordsRaw) {
    if (typeof value !== 'string') continue;
    const term = value.trim();
    if (term.length === 0 || term.length > MAX_KEYWORD_CHARS) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    // A keyword with no indexable characters would produce an empty MATCH expression.
    if (!buildMatchQuery(term)) continue;
    seen.add(key);
    keywords.push(term);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  const corrected = typeof record.correctedQuery === 'string' ? record.correctedQuery.trim() : '';
  const expansion: QueryExpansion = { keywords };
  if (corrected.length > 0 && corrected.length <= 200 && corrected.toLowerCase() !== query.trim().toLowerCase()) {
    expansion.correctedQuery = corrected;
  }
  return expansion.keywords.length > 0 || expansion.correctedQuery ? expansion : null;
}

/**
 * Expands a query with the locally configured chat model.
 *
 * Only the query leaves the machine — never document content. Any failure (no key, timeout, bad
 * JSON) returns null so retrieval degrades to the original query instead of failing.
 */
@Injectable()
export class LlmQueryExpander implements QueryExpander {
  private readonly logger = new Logger(LlmQueryExpander.name);

  constructor(private readonly settings: SettingsService) {}

  /** Asks the model for synonyms and a typo-corrected query; bounded by EXPANSION_TIMEOUT_MS. */
  async expand(query: string, signal?: AbortSignal): Promise<QueryExpansion | null> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return null;

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
    const timer = setTimeout(() => controller.abort(), EXPANSION_TIMEOUT_MS);

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
          max_tokens: 300,
          messages: [
            {
              role: 'system',
              content:
                '你是中文检索查询扩展器。给定用户问题，输出 JSON：{"correctedQuery": "纠正错别字后的原问题，无需纠正则省略", "keywords": ["同义词或相关术语"]}。' +
                'keywords 必须是资料里可能出现的名词或术语，最多 6 个，不要重复原句里已有的词，不要解释，只输出 JSON。',
            },
            { role: 'user', content: trimmed },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.debug(`查询扩展失败：HTTP ${response.status}`);
        return null;
      }
      const payload: unknown = await response.json();
      const content = readMessageContent(payload);
      if (!content) return null;
      return sanitizeExpansion(extractJsonObject(content), trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`查询扩展异常：${message}`);
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}

/** Reads `choices[0].message.content` from an OpenAI-compatible response without trusting it. */
function readMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  if (!('choices' in payload) || !Array.isArray(payload.choices)) return null;
  const choice: unknown = payload.choices[0];
  if (!choice || typeof choice !== 'object' || !('message' in choice)) return null;
  const message = choice.message;
  if (!message || typeof message !== 'object' || !('content' in message)) return null;
  return typeof message.content === 'string' ? message.content : null;
}

/** Builds an FTS5 expression over the expanded alternatives; the original query runs separately. */
export function buildExpansionMatchQuery(expansion: QueryExpansion): string | null {
  const alternatives: string[] = [];
  if (expansion.correctedQuery) {
    const corrected = buildMatchQuery(expansion.correctedQuery);
    if (corrected) alternatives.push(corrected);
  }
  for (const keyword of expansion.keywords) {
    const match = buildMatchQuery(keyword);
    if (match) alternatives.push(match);
  }
  return alternatives.length > 0 ? `(${alternatives.join(' OR ')})` : null;
}
