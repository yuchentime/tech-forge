import type { AgentStreamEvent } from './agent-events';

/** Describes the only SSE events exposed by the one-turn Agent endpoint. */
export type AgentSseEvent =
  | AgentStreamEvent
  | { type: 'done'; finishReason: 'stop' }
  | { type: 'error'; message: string };

/** Encodes one typed Agent event as a standards-compliant SSE frame. */
export function encodeAgentSseEvent(event: AgentSseEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
