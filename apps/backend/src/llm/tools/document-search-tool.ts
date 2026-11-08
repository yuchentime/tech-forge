import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { RetrievalHit, RetrievalService } from '../../retrieval/retrieval.service';

/** Tool name exposed to the model; also used by prompts and tests. */
export const DOCUMENT_SEARCH_TOOL_NAME = 'search_documents';

/** Default and maximum result counts for one tool call. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** Parameters accepted by the tool; the model fills these from the user's question. */
const searchDocumentsParameters = Type.Object({
  query: Type.String({ description: '要在用户已入库资料中检索的问题或关键词' }),
  limit: Type.Optional(
    Type.Number({
      description: `返回条数，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}`,
      minimum: 1,
      maximum: MAX_LIMIT,
    }),
  ),
});

/** One result item: the chunk text plus where it came from. */
export interface DocumentSearchItem {
  content: string;
  document: {
    name: string;
    path: string;
    title: string;
    id: string;
  };
  locator: {
    headingPath: string[];
    pageStart?: number;
    pageEnd?: number;
  };
}

/** Maps one retrieval hit to the tool's public item shape. */
function toItem(hit: RetrievalHit): DocumentSearchItem {
  const locator = parseLocator(hit.locatorJson);
  return {
    content: hit.content,
    document: {
      name: hit.document.fileName,
      path: hit.document.path,
      title: hit.document.title,
      id: hit.document.id,
    },
    locator: {
      headingPath: locator.headingPath,
      pageStart: locator.pageStart,
      pageEnd: locator.pageEnd,
    },
  };
}

/** Reads the stored locator defensively; a malformed value must not fail the tool call. */
function parseLocator(raw: string): { headingPath: string[]; pageStart?: number; pageEnd?: number } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { headingPath: [] };
    const record = parsed as Record<string, unknown>;
    const headingPath = Array.isArray(record.headingPath)
      ? record.headingPath.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return {
      headingPath,
      pageStart: typeof record.pageStart === 'number' ? record.pageStart : undefined,
      pageEnd: typeof record.pageEnd === 'number' ? record.pageEnd : undefined,
    };
  } catch {
    return { headingPath: [] };
  }
}

/**
 * Builds the `search_documents` tool.
 *
 * The tool is intentionally thin: it forwards the query to `RetrievalService` and returns an array of
 * chunks with document metadata. Whether to call it, and how to use the results, is left to the model.
 */
export function createDocumentSearchTool(
  retrieval: RetrievalService,
): ToolDefinition<typeof searchDocumentsParameters, { count: number; query: string }> {
  return {
    name: DOCUMENT_SEARCH_TOOL_NAME,
    label: '检索资料',
    description:
      '在用户已入库的资料中做检索，返回相关原文片段及其文档元数据（文档名称、路径、页码）。' +
      '当需要引用或核对资料里的具体内容时使用；不确定资料中是否有相关内容时不要调用。',
    parameters: searchDocumentsParameters,
    async execute(_toolCallId, params) {
      const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      try {
        const hits = await retrieval.search({ query: params.query, limit });
        const items = hits.map((hit) => toItem(hit));
        return {
          content: [{ type: 'text', text: JSON.stringify(items) }],
          details: { count: items.length, query: params.query },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `检索失败：${message}` }],
          details: { count: 0, query: params.query },
          isError: true,
        };
      }
    },
  };
}
