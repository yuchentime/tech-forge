/** 定义允许跨过 Electron 桌面桥接的 Pi 原生事件字段。 */
export type AgentStreamEvent =
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
  | { type: 'done'; finishReason: 'stop' }
  | { type: 'error'; message: string };

/** 严格校验事件字段，避免完整 Pi payload 越过桌面桥接。 */
export function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
