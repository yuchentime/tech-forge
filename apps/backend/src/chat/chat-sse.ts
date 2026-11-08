import type { ChatStreamEvent } from './chat-events';

/** Describes the only SSE events exposed by the one-turn Chat endpoint. */
export type ChatSseEvent =
  | ChatStreamEvent
  | { type: 'done'; finishReason: 'stop' }
  | { type: 'error'; message: string };

/** Encodes one typed Chat event as a standards-compliant SSE frame. */
export function encodeChatSseEvent(event: ChatSseEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
