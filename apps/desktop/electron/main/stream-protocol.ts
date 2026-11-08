import {
  isChatStreamEvent,
  type ChatStreamEvent,
} from '../../src/types/chat-stream-event';
import type { SseMessage } from './sse-parser';

/** Validates and normalizes one backend SSE frame before crossing into Renderer. */
export function decodeChatSseMessage(
  message: SseMessage,
): ChatStreamEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(message.data);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  if (Object.hasOwn(data, 'type')) return undefined;
  const event = { ...data, type: message.event };
  return isChatStreamEvent(event) ? event : undefined;
}
