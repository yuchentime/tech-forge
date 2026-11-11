import { Type, type Static } from 'typebox';
import type { ExtensionFactory as PiExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  MemoryRejectedError,
  MemoryUnavailableError,
} from './memory-errors';
import type { MemoryRecord, MemoryService } from './memory.service';

/** Tool names must match the `createAgentSession({ tools })` allowlist. */
export const MEMORY_TOOL_NAMES = [
  'memory_write',
  'memory_search',
  'memory_list',
] as const;

/** Tool output cap; memory line caps in the prompt are separate. */
const TOOL_CONTENT_MAX_CHARS = 300;

const writeParameters = Type.Object({
  content: Type.String({
    minLength: 2,
    maxLength: 1000,
    description: '要长期记住的一条事实、偏好或要求。',
  }),
  tags: Type.Optional(
    Type.Array(Type.String({ maxLength: 24 }), {
      maxItems: 5,
      description: '可选标签。',
    }),
  ),
});

const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500, description: '要检索的内容。' }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 10, description: '返回条数，默认 5。' }),
  ),
});

const listParameters = Type.Object({});

/**
 * Builds the in-process Pi extension that exposes memory tools.
 *
 * Only tools are registered: prompt material is injected by ChatService as a per-turn user prefix,
 * so the system prompt stays byte-identical for provider prefix caching.
 */
export function createMemoryToolsExtension(
  service: MemoryService,
): PiExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'memory_write',
      label: '记录长期记忆',
      description:
        '记录跨会话有效的长期事实、用户偏好或明确要求记住的内容。不要记录一次性任务、文件内容、教学掌握度（正确率/薄弱点）或回答风格。',
      parameters: writeParameters,
      execute: async (_toolCallId, params: Static<typeof writeParameters>) => {
        try {
          const result = await service.write(params.content, params.tags ?? []);
          return textResult(JSON.stringify(result), { status: result.status });
        } catch (error) {
          return textResult(describeToolError(error));
        }
      },
    });

    pi.registerTool({
      name: 'memory_search',
      label: '搜索长期记忆',
      description: '按含义搜索跨会话长期记忆；当需要回忆用户偏好或历史要求时使用。',
      parameters: searchParameters,
      execute: async (_toolCallId, params: Static<typeof searchParameters>) => {
        try {
          const records = await service.search(params.query, params.limit ?? 5);
          return textResult(JSON.stringify(records.map(slimRecord)), {
            count: records.length,
          });
        } catch (error) {
          return textResult(describeToolError(error));
        }
      },
    });

    pi.registerTool({
      name: 'memory_list',
      label: '读取长期记忆',
      description: '列出当前保存的长期记忆，最多 50 条。',
      parameters: listParameters,
      execute: async () => {
        try {
          const records = await service.list();
          return textResult(JSON.stringify(records.map(slimRecord)), {
            count: records.length,
          });
        } catch (error) {
          return textResult(describeToolError(error));
        }
      },
    });
  };
}

/** Returns the Pi tool result shape; `content` is what the model reads. */
function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

/** Keeps tool output small and free of internal fields. */
function slimRecord(record: MemoryRecord): MemoryRecord {
  return {
    id: record.id,
    content: record.content.slice(0, TOOL_CONTENT_MAX_CHARS),
    tags: record.tags,
    createdAt: record.createdAt,
    ...(record.score === undefined ? {} : { score: record.score }),
  };
}

/** Maps service failures to a model-facing message without leaking internal paths. */
function describeToolError(error: unknown): string {
  if (error instanceof MemoryRejectedError) return `未写入：${error.message}`;
  if (error instanceof MemoryUnavailableError) return '长期记忆暂不可用。';
  return '长期记忆操作失败，请稍后重试。';
}
