import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
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

/** Validates the shared Agent event contract without importing a local module into the sandboxed preload. */
function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'agent_end':
      return hasExactKeys(value, ['type']);
    case 'tool_execution_start':
      return (
        hasExactKeys(value, ['type', 'toolCallId', 'toolName', 'args']) &&
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        isJsonValue(value.args)
      );
    case 'tool_execution_end':
      return (
        hasExactKeys(
          value,
          ['type', 'toolCallId', 'toolName', 'isError'],
          ['durationMs'],
        ) &&
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.isError === 'boolean' &&
        (value.durationMs === undefined ||
          (typeof value.durationMs === 'number' &&
            Number.isFinite(value.durationMs) &&
            value.durationMs >= 0))
      );
    case 'message_update':
      return (
        hasExactKeys(value, ['type', 'assistantMessageEvent']) &&
        isRecord(value.assistantMessageEvent) &&
        hasExactKeys(value.assistantMessageEvent, ['type', 'delta']) &&
        value.assistantMessageEvent.type === 'text_delta' &&
        typeof value.assistantMessageEvent.delta === 'string'
      );
    case 'done':
      return (
        hasExactKeys(value, ['type', 'finishReason']) &&
        value.finishReason === 'stop'
      );
    case 'error':
      return (
        hasExactKeys(value, ['type', 'message']) &&
        typeof value.message === 'string'
      );
    default:
      return false;
  }
}

/** Requires every declared key and rejects all unrecognized event fields. */
function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** Verifies tool arguments contain JSON-safe values with bounded nesting. */
function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** Narrows unknown input to a plain object before checking event fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
