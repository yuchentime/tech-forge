import {
  isAgentStreamEvent,
  type AgentStreamEvent,
} from '../../src/types/agent-stream-event';
import type { SseMessage } from './sse-parser';

/** Validates and normalizes one backend SSE frame before crossing into Renderer. */
export function decodeAgentSseMessage(
  message: SseMessage,
): AgentStreamEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(message.data);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  if (Object.hasOwn(data, 'type')) return undefined;
  const event = { ...data, type: message.event };
  return isAgentStreamEvent(event) ? event : undefined;
}
