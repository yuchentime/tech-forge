import { isRecord } from '../api/json';

/** Defines the safe conversation metadata and Pi event fields that may cross the desktop bridge. */
export type ChatStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'agent_start' }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs?: number;
    }
  | {
      type: 'message_update';
      assistantMessageEvent: { type: 'text_delta'; delta: string };
    }
  | { type: 'agent_end' }
  | {
      type: 'artifact';
      artifact: {
        id: string;
        fileName: string;
        contentFormat: string;
        byteSize: number | null;
        createdAt: string;
        updatedAt: string;
        userMessageId: string | null;
        missing: boolean;
        external: boolean;
      };
    }
  | { type: 'done'; finishReason: 'stop' }
  | { type: 'error'; message: string };

/** 严格校验事件字段，避免完整 Pi payload 越过桌面桥接。 */
export function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'conversation':
      return (
        hasExactKeys(value, ['type', 'conversationId']) &&
        typeof value.conversationId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.conversationId,
        )
      );
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'agent_end':
      return hasExactKeys(value, ['type']);
    case 'tool_execution_start':
      return (
        hasExactKeys(value, ['type', 'toolCallId', 'toolName', 'args']) &&
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        isJsonValue(value.args)
      );
    case 'tool_execution_end':
      return (
        hasExactKeys(
          value,
          ['type', 'toolCallId', 'toolName', 'isError'],
          ['durationMs'],
        ) &&
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.isError === 'boolean' &&
        (value.durationMs === undefined ||
          (typeof value.durationMs === 'number' &&
            Number.isFinite(value.durationMs) &&
            value.durationMs >= 0))
      );
    case 'message_update':
      return (
        hasExactKeys(value, ['type', 'assistantMessageEvent']) &&
        isRecord(value.assistantMessageEvent) &&
        hasExactKeys(value.assistantMessageEvent, ['type', 'delta']) &&
        value.assistantMessageEvent.type === 'text_delta' &&
        typeof value.assistantMessageEvent.delta === 'string'
      );
    case 'artifact':
      return (
        hasExactKeys(value, ['type', 'artifact']) &&
        isRecord(value.artifact) &&
        hasExactKeys(
          value.artifact,
          [
            'id',
            'fileName',
            'contentFormat',
            'byteSize',
            'createdAt',
            'updatedAt',
            'userMessageId',
            'missing',
            'external',
          ],
        ) &&
        typeof value.artifact.id === 'string' &&
        typeof value.artifact.fileName === 'string' &&
        typeof value.artifact.contentFormat === 'string' &&
        (value.artifact.byteSize === null ||
          typeof value.artifact.byteSize === 'number') &&
        typeof value.artifact.createdAt === 'string' &&
        typeof value.artifact.updatedAt === 'string' &&
        (value.artifact.userMessageId === null ||
          typeof value.artifact.userMessageId === 'string') &&
        typeof value.artifact.missing === 'boolean' &&
        typeof value.artifact.external === 'boolean'
      );
    case 'done':
      return (
        hasExactKeys(value, ['type', 'finishReason']) &&
        value.finishReason === 'stop'
      );
    case 'error':
      return (
        hasExactKeys(value, ['type', 'message']) &&
        typeof value.message === 'string'
      );
    default:
      return false;
  }
}

/** 校验必需字段，并拒绝额外的 Pi 内部字段。 */
function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** 确认从 SSE 反序列化得到的工具参数仍是合法 JSON 值。 */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** 将未知值收窄为普通对象。 */

