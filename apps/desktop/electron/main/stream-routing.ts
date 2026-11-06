import type { AgentStreamEvent } from '../../src/types/desktop-bridge';

type StreamPort = { postMessage(event: AgentStreamEvent): void };
type StreamRequest = { port: StreamPort };

/** Routes an event through only the MessagePort registered to its request ID. */
export function routeAgentStreamEvent(
  streams: ReadonlyMap<string, StreamRequest>,
  requestId: string,
  event: AgentStreamEvent,
): boolean {
  const stream = streams.get(requestId);
  if (!stream) return false;
  stream.port.postMessage(event);
  return true;
}
