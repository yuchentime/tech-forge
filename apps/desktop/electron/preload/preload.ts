import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChatStreamEvent } from '../../src/types/chat-stream-event';
import type { BackendRequest, BackendResponse, DesktopBridge } from '../../src/types/desktop-bridge';

type ChatStreamHandler = {
  onEvent: (event: ChatStreamEvent) => void;
  port?: MessagePort;
};

const chatStreams = new Map<string, ChatStreamHandler>();
let nextStreamId = 0;


/** Closes one local port and drops its callback after a terminal condition. */
function finishChatStream(
  requestId: string,
  handler: ChatStreamHandler,
): void {
  if (chatStreams.get(requestId) === handler) chatStreams.delete(requestId);
  handler.port?.close();
}

/** Receives a per-request port from Main and forwards only typed stream events. */
function receiveChatStreamPort(
  event: IpcRendererEvent,
  value: unknown,
): void {
  if (!value || typeof value !== 'object') return;
  const requestId = (value as { requestId?: unknown }).requestId;
  const port = event.ports[0];
  if (typeof requestId !== 'string' || !port) {
    port?.close();
    return;
  }

  const handler = chatStreams.get(requestId);
  if (!handler) {
    port.close();
    return;
  }
  handler.port = port;
  port.onmessage = (messageEvent: MessageEvent<unknown>) => {
    // Main validates every frame against the shared event contract before posting it here; a
    // second schema copy in the sandboxed preload would drift and silently close the stream.
    const streamEvent = messageEvent.data;
    if (!isStreamEventLike(streamEvent)) {
      console.error('[teachforge][stream] invalid_event', describeStreamEvent(streamEvent));
      try {
        handler.onEvent({ type: 'error', message: '本地 Agent 流事件无效，请重试。' });
      } catch {
        // A Renderer callback failure must not keep the port alive.
      }
      finishChatStream(requestId, handler);
      return;
    }

    try {
      handler.onEvent(streamEvent);
    } catch {
      finishChatStream(requestId, handler);
      return;
    }
    if (streamEvent.type === 'done' || streamEvent.type === 'error') {
      finishChatStream(requestId, handler);
    }
  };
  port.onmessageerror = () => {
    try {
      handler.onEvent({ type: 'error', message: '本地 Agent 流连接中断，请重试。' });
    } catch {
      // A Renderer callback failure must not keep the port alive.
    }
    finishChatStream(requestId, handler);
  };
  port.start();
}

/** Delivers a safe start failure when Main cannot establish a MessagePort. */
function receiveChatStreamFailure(_event: IpcRendererEvent, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const failure = value as { requestId?: unknown; message?: unknown };
  if (typeof failure.requestId !== 'string' || typeof failure.message !== 'string') {
    return;
  }

  const handler = chatStreams.get(failure.requestId);
  if (!handler) return;
  try {
    handler.onEvent({ type: 'error', message: failure.message });
  } catch {
    // Start failures are terminal even when the Renderer callback throws.
  } finally {
    finishChatStream(failure.requestId, handler);
  }
}

ipcRenderer.on('chat:stream:port', receiveChatStreamPort);
ipcRenderer.on('chat:stream:failure', receiveChatStreamFailure);

const bridge: DesktopBridge = {
  getBackendState: () => ipcRenderer.invoke('backend:state'),
  request: <T = unknown>(input: BackendRequest) =>
    ipcRenderer.invoke('backend:request', input) as Promise<BackendResponse<T>>,
  pickImportFiles: () =>
    ipcRenderer.invoke('documents:pick-files') as Promise<string[]>,
  streamChat: (prompt, onEvent, conversationId, attachments) => {
    const requestId = `chat-${Date.now()}-${++nextStreamId}`;
    chatStreams.set(requestId, { onEvent });
    ipcRenderer.send('chat:stream:start', {
      requestId,
      prompt,
      ...(conversationId ? { conversationId } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    return requestId;
  },
  cancelChatStream: (requestId) => {
    const handler = chatStreams.get(requestId);
    if (handler) finishChatStream(requestId, handler);
    ipcRenderer.send('chat:stream:cancel', requestId);
  },
  revealInFolder: (itemPath: string) =>
    ipcRenderer.invoke('shell:reveal', itemPath) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('teachforge', bridge);

/** Checks only that a frame is an object carrying an event name; Main owns the full contract. */
function isStreamEventLike(value: unknown): value is ChatStreamEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string';
}

/** Describes a rejected frame without copying its payload into the console. */
function describeStreamEvent(value: unknown): { type: string; keys: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: typeof value, keys: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    type: typeof record.type === 'string' ? record.type : 'unknown',
    keys: Object.keys(record).sort(),
  };
}
