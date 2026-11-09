import type { ChatStreamEvent } from './chat-stream-event';

export type BackendRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
};

export type BackendResponse<T = unknown> = {
  status: number;
  data: T;
};

export type { ChatStreamEvent } from './chat-stream-event';

export type DesktopBridge = {
  getBackendState(): Promise<{ ready: boolean; port: number | null }>;
  request<T = unknown>(input: BackendRequest): Promise<BackendResponse<T>>;
  /** Opens the native file picker and returns the chosen absolute paths (empty when cancelled). */
  pickImportFiles(): Promise<string[]>;
  /** Starts one validated chat stream and returns its cancellation request ID. */
  streamChat(
    prompt: string,
    onEvent: (event: ChatStreamEvent) => void,
    conversationId?: string,
    attachments?: Array<{ attachmentId: string; path: string }>,
  ): string;
  /** Cancels an active stream started by this Renderer. */
  cancelChatStream(requestId: string): void;
};

/** Detects whether this renderer was launched with the restricted Electron preload bridge. */
export function hasDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = window.teachforge;
  return Boolean(
    bridge &&
      typeof bridge.getBackendState === 'function' &&
      typeof bridge.request === 'function' &&
      typeof bridge.pickImportFiles === 'function' &&
      typeof bridge.streamChat === 'function' &&
      typeof bridge.cancelChatStream === 'function',
  );
}

declare global {
  interface Window {
    teachforge: DesktopBridge;
  }
}
