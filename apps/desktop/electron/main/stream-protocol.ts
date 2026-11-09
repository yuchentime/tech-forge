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
    // A dropped frame leaves the Renderer waiting for a terminal event, so it must be visible.
    console.error('[teachforge][stream] dropped_frame', {
      event: message.event,
      reason: 'invalid_json',
      bytes: message.data.length,
    });
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  if (Object.hasOwn(data, 'type')) return undefined;
  const event = { ...data, type: message.event };
  if (isChatStreamEvent(event)) return event;

  // A new backend event type without a matching validator case shows up here, not in the UI.
  console.error('[teachforge][stream] dropped_frame', {
    event: message.event,
    reason: 'validator_rejected',
    keys: Object.keys(data).sort(),
  });
  return undefined;
}
