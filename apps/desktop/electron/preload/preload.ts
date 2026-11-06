import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isAgentStreamEvent } from '../../src/types/agent-stream-event';
import type {
  AgentStreamEvent,
  BackendRequest,
  BackendResponse,
  DesktopBridge,
} from '../../src/types/desktop-bridge';

type AgentStreamHandler = {
  onEvent: (event: AgentStreamEvent) => void;
  port?: MessagePort;
};

const agentStreams = new Map<string, AgentStreamHandler>();
let nextStreamId = 0;

/** Closes one local port and drops its callback after a terminal condition. */
function finishAgentStream(
  requestId: string,
  handler: AgentStreamHandler,
): void {
  if (agentStreams.get(requestId) === handler) agentStreams.delete(requestId);
  handler.port?.close();
}

/** Receives a per-request port from Main and forwards only typed stream events. */
function receiveAgentStreamPort(
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

  const handler = agentStreams.get(requestId);
  if (!handler) {
    port.close();
    return;
  }
  handler.port = port;
  port.onmessage = (messageEvent: MessageEvent<unknown>) => {
    if (!isAgentStreamEvent(messageEvent.data)) {
      try {
        handler.onEvent({ type: 'error', message: '本地 Agent 流事件无效，请重试。' });
      } catch {
        // A Renderer callback failure must not keep the port alive.
      }
      finishAgentStream(requestId, handler);
      return;
    }

    const streamEvent = messageEvent.data;
    try {
      handler.onEvent(streamEvent);
    } catch {
      finishAgentStream(requestId, handler);
      return;
    }
    if (streamEvent.type === 'done' || streamEvent.type === 'error') {
      finishAgentStream(requestId, handler);
    }
  };
  port.onmessageerror = () => {
    try {
      handler.onEvent({ type: 'error', message: '本地 Agent 流连接中断，请重试。' });
    } catch {
      // A Renderer callback failure must not keep the port alive.
    }
    finishAgentStream(requestId, handler);
  };
  port.start();
}

/** Delivers a safe start failure when Main cannot establish a MessagePort. */
function receiveAgentStreamFailure(_event: IpcRendererEvent, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const failure = value as { requestId?: unknown; message?: unknown };
  if (typeof failure.requestId !== 'string' || typeof failure.message !== 'string') {
    return;
  }

  const handler = agentStreams.get(failure.requestId);
  if (!handler) return;
  try {
    handler.onEvent({ type: 'error', message: failure.message });
  } catch {
    // Start failures are terminal even when the Renderer callback throws.
  } finally {
    finishAgentStream(failure.requestId, handler);
  }
}

ipcRenderer.on('agent:stream:port', receiveAgentStreamPort);
ipcRenderer.on('agent:stream:failure', receiveAgentStreamFailure);

const bridge: DesktopBridge = {
  getBackendState: () => ipcRenderer.invoke('backend:state'),
  request: <T = unknown>(input: BackendRequest) =>
    ipcRenderer.invoke('backend:request', input) as Promise<BackendResponse<T>>,
  streamAgent: (prompt, onEvent) => {
    const requestId = `agent-${Date.now()}-${++nextStreamId}`;
    agentStreams.set(requestId, { onEvent });
    ipcRenderer.send('agent:stream:start', { requestId, prompt });
    return requestId;
  },
  cancelAgentStream: (requestId) => {
    const handler = agentStreams.get(requestId);
    if (handler) finishAgentStream(requestId, handler);
    ipcRenderer.send('agent:stream:cancel', requestId);
  },
};

contextBridge.exposeInMainWorld('teachforge', bridge);
