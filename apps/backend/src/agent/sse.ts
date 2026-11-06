/** Describes the only SSE events exposed by the one-turn Agent endpoint. */
export type AgentSseEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: { finishReason: 'stop' } }
  | { event: 'error'; data: { message: string } };

/** Encodes one typed Agent event as a standards-compliant SSE frame. */
export function encodeAgentSseEvent(event: AgentSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
