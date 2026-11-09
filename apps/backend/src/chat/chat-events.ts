import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** 定义送到 UI 的会话元数据与安全 Pi 原生事件投影。 */
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
    };

/** 将 Pi session 事件投影为 UI 需要的字段，并在这里剔除内部结果数据。 */
export function projectChatSessionEvent(
  event: AgentSessionEvent,
): ChatStreamEvent | undefined {
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'agent_end':
      return { type: event.type };
    case 'tool_execution_start':
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case 'tool_execution_end':
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
      };
    case 'message_update':
      if (event.assistantMessageEvent.type !== 'text_delta') return undefined;
      return {
        type: event.type,
        assistantMessageEvent: {
          type: 'text_delta',
          delta: event.assistantMessageEvent.delta,
        },
      };
    default:
      return undefined;
  }
}
