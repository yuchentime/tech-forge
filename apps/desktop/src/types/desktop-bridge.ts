import type { AgentStreamEvent } from './agent-stream-event';

export type BackendRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
};

export type BackendResponse<T = unknown> = {
  status: number;
  data: T;
};

export type { AgentStreamEvent } from './agent-stream-event';

export type DesktopBridge = {
  getBackendState(): Promise<{ ready: boolean; port: number | null }>;
  request<T = unknown>(input: BackendRequest): Promise<BackendResponse<T>>;
  /** Starts one validated Agent stream and returns its cancellation request ID. */
  streamAgent(prompt: string, onEvent: (event: AgentStreamEvent) => void): string;
  /** Cancels an active stream started by this Renderer. */
  cancelAgentStream(requestId: string): void;
};

declare global {
  interface Window {
    teachforge: DesktopBridge;
  }
}
