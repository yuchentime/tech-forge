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

/** Outcome of a width request: the content width now in effect and this display's ceiling. */
export type ContentWidthResult = {
  contentWidth: number;
  maxContentWidth: number;
};

export type DesktopBridge = {
  getBackendState(): Promise<{ ready: boolean; port: number | null }>;
  request<T = unknown>(input: BackendRequest): Promise<BackendResponse<T>>;
  /** Opens the native file picker and returns the chosen absolute paths (empty when cancelled). */
  pickImportFiles(): Promise<string[]>;
  /** Opens the attachment picker (documents and images) and returns absolute paths. */
  pickChatAttachments(): Promise<string[]>;
  /** Starts one validated chat stream and returns its cancellation request ID. */
  streamChat(
    prompt: string,
    onEvent: (event: ChatStreamEvent) => void,
    conversationId?: string,
    attachments?: Array<{ attachmentId: string; path: string }>,
  ): string;
  /** Cancels an active stream started by this Renderer. */
  cancelChatStream(requestId: string): void;
  /**
   * Reveals one backend-resolved path in the operating system file manager.
   *
   * The Renderer only forwards a path the artifact API returned; it never builds one itself.
   */
  revealInFolder(itemPath: string): Promise<boolean>;
  /**
   * Asks the main process to widen the window until its content is at least `minContentWidth`.
   *
   * Only the requirement travels: the main process owns the geometry, clamps the request to the
   * display work area, and reports the ceiling the renderer can plan against.
   */
  ensureContentWidth(minContentWidth: number): Promise<ContentWidthResult>;
  /**
   * Undoes a previous growth, and only while the window is still exactly where growth left it, so
   * a window the user resized in the meantime is never shrunk.
   */
  releaseContentWidth(): Promise<void>;
  /**
   * Locks the window to the classroom stage's 16:9 content ratio, or releases it.
   *
   * The renderer only states which mode is on screen; the main process owns the 16:9 content
   * ratio, the resize correction and the restore of the user's previous size.
   */
  setClassroomMode(enabled: boolean): Promise<void>;
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
      typeof bridge.pickChatAttachments === 'function' &&
      typeof bridge.streamChat === 'function' &&
      typeof bridge.cancelChatStream === 'function' &&
      typeof bridge.revealInFolder === 'function' &&
      typeof bridge.ensureContentWidth === 'function' &&
      typeof bridge.releaseContentWidth === 'function' &&
      typeof bridge.setClassroomMode === 'function',
  );
}

declare global {
  interface Window {
    teachforge: DesktopBridge;
  }
}
