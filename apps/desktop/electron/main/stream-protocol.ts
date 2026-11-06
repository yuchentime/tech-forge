import type { AgentStreamEvent } from '../../src/types/desktop-bridge';
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
  if (!data || typeof data !== 'object') return undefined;

  if (message.event === 'delta') {
    const text = (data as { text?: unknown }).text;
    return typeof text === 'string' ? { type: 'delta', text } : undefined;
  }
  if (message.event === 'done') return { type: 'done' };
  if (message.event === 'error') {
    const errorMessage = (data as { message?: unknown }).message;
    return typeof errorMessage === 'string'
      ? { type: 'error', message: errorMessage }
      : undefined;
  }
  return undefined;
}
