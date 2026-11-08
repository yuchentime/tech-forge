import type { ChatStreamEvent } from '../../src/types/desktop-bridge';

type StreamPort = { postMessage(event: ChatStreamEvent): void };
type StreamRequest = { port: StreamPort };

/** Routes an event through only the MessagePort registered to its request ID. */
export function routeChatStreamEvent(
  streams: ReadonlyMap<string, StreamRequest>,
  requestId: string,
  event: ChatStreamEvent,
): boolean {
  const stream = streams.get(requestId);
  if (!stream) return false;
  stream.port.postMessage(event);
  return true;
}
