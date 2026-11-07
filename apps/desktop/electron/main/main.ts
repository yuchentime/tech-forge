import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type IpcMainEvent,
  type MessagePortMain,
  type WebContents,
} from 'electron';
import type {
  AgentStreamEvent,
  BackendRequest,
} from '../../src/types/desktop-bridge';
import { SseParser } from './sse-parser';
import { decodeAgentSseMessage } from './stream-protocol';
import { routeAgentStreamEvent } from './stream-routing';

const READY_PREFIX = 'TEACHFORGE_BACKEND_READY=';
const STARTUP_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_AGENT_PROMPT_LENGTH = 10_000;
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const agentRequestIdPattern = /^agent-\d+-\d+$/;

type BackendChild = UtilityProcess | ChildProcess;
type AgentStreamStart = {
  requestId: string;
  prompt: string;
  conversationId?: string;
};
type ActiveAgentStream = {
  requestId: string;
  sender: WebContents;
  controller: AbortController;
  port: MessagePortMain;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
};

let backendChild: BackendChild | undefined;
let backendPort: number | undefined;
let backendToken: string | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
const activeAgentStreams = new Map<string, ActiveAgentStream>();
const conversationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const configuredDataDirectory = process.env.TEACHFORGE_DATA_DIR;
if (configuredDataDirectory) {
  mkdirSync(configuredDataDirectory, { recursive: true });
  app.setPath('userData', configuredDataDirectory);
}

/** Resolves the backend entry for packaged and development Electron builds. */
function getBackendEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'main.js');
  }

  return path.resolve(__dirname, '../../../../backend/dist/main.js');
}

/** Validates the existing narrow JSON request contract and size limit. */
function isBackendRequest(value: unknown): value is BackendRequest {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<BackendRequest>;
  if (!input.method || !allowedMethods.has(input.method)) return false;
  if (typeof input.path !== 'string' || !input.path.startsWith('/api/')) return false;
  if (input.path.startsWith('//') || input.path.includes('..') || input.path.includes('\\')) return false;
  if (input.path.includes('://') || input.path.includes('#')) return false;

  if (input.body !== undefined) {
    try {
      return Buffer.byteLength(JSON.stringify(input.body)) <= MAX_REQUEST_BYTES;
    } catch {
      return false;
    }
  }

  return true;
}

/** Stops the local backend process and clears its runtime credentials. */
function stopBackend(): Promise<void> {
  const child = backendChild;
  backendChild = undefined;
  backendPort = undefined;
  backendToken = undefined;

  if (!child) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, 2_000);

    if (app.isPackaged) {
      (child as UtilityProcess).once('exit', finish);
    } else {
      (child as ChildProcess).once('exit', finish);
    }
    child.kill();
  });
}

/** Starts the loopback backend and waits for its ready port announcement. */
function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = getBackendEntry();
    if (!existsSync(entry)) {
      reject(new Error(`Backend entry was not found: ${entry}`));
      return;
    }

    backendToken = randomBytes(32).toString('hex');
    let settled = false;
    let output = '';

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timed out waiting for the local backend to become ready.'));
      void stopBackend();
    }, STARTUP_TIMEOUT_MS);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TEACHFORGE_DATA_DIR: app.getPath('userData'),
      TEACHFORGE_HOST: '127.0.0.1',
      TEACHFORGE_PORT: '0',
      TEACHFORGE_AUTH_TOKEN: backendToken,
    };
    if (app.isPackaged) {
      env.NODE_PATH = path.join(app.getAppPath(), 'node_modules');
    }

    const onOutput = (chunk: Buffer | string): void => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith(READY_PREFIX)) continue;
        try {
          const message = JSON.parse(line.slice(READY_PREFIX.length)) as { port?: unknown };
          if (!Number.isInteger(message.port) || Number(message.port) < 1 || Number(message.port) > 65_535) {
            throw new Error('Backend reported an invalid port.');
          }
          backendPort = Number(message.port);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    };

    const onError = (chunk: Buffer | string): void => {
      console.error(`[backend] ${chunk.toString().trimEnd()}`);
    };

    const onExit = (code: number | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Backend exited before becoming ready (code ${code ?? 'unknown'}).`));
      } else if (!quitting) {
        backendPort = undefined;
        console.error(`Backend exited unexpectedly (code ${code ?? 'unknown'}).`);
      }
    };

    if (app.isPackaged) {
      const child = utilityProcess.fork(entry, [], {
        serviceName: 'TeachForge Backend',
        stdio: 'pipe',
        env,
      });
      backendChild = child;
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onError);
      child.on('exit', onExit);
    } else {
      const child = spawn('node', [entry], {
        cwd: path.dirname(entry),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      backendChild = child;
      child.stdout.on('data', onOutput);
      child.stderr.on('data', onError);
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.on('exit', onExit);
    }
  });
}

/** Registers the existing JSON bridge and the dedicated Agent stream IPC. */
function registerBackendIpc(): void {
  ipcMain.handle('backend:state', () => ({
    ready: backendPort !== undefined,
    port: backendPort ?? null,
  }));

  ipcMain.handle('backend:request', async (_event, value: unknown) => {
    if (!isBackendRequest(value)) {
      throw new Error('Invalid backend request.');
    }
    if (!backendPort || !backendToken) {
      throw new Error('The local backend is not ready.');
    }

    const input = value as BackendRequest;
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const response = await fetch(`http://127.0.0.1:${backendPort}${input.path}`, {
      method: input.method,
      headers: {
        'x-teachforge-token': backendToken,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { status: response.status, data };
  });

  ipcMain.on('agent:stream:start', (event, value: unknown) => {
    startAgentStream(event, value);
  });
  ipcMain.on('agent:stream:cancel', (event, value: unknown) => {
    if (typeof value === 'string') {
      cancelBackendAgentStream(value, event.sender);
    }
  });
}

/** Validates the narrow Renderer request before creating a stream channel. */
function parseAgentStreamStart(value: unknown): AgentStreamStart | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<AgentStreamStart>;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !['requestId', 'prompt', 'conversationId'].includes(key)) ||
    keys.length < 2 ||
    keys.length > 3 ||
    typeof input.requestId !== 'string' ||
    !agentRequestIdPattern.test(input.requestId) ||
    typeof input.prompt !== 'string' ||
    (input.conversationId !== undefined &&
      (typeof input.conversationId !== 'string' ||
        !conversationIdPattern.test(input.conversationId)))
  ) {
    return undefined;
  }

  const prompt = input.prompt.trim();
  if (!prompt || Array.from(prompt).length > MAX_AGENT_PROMPT_LENGTH) {
    return undefined;
  }
  return {
    requestId: input.requestId,
    prompt,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  };
}

/** Starts a single Agent stream only for the main application frame. */
function startAgentStream(event: IpcMainEvent, value: unknown): void {
  const requestId =
    value && typeof value === 'object'
      ? (value as { requestId?: unknown }).requestId
      : undefined;
  if (typeof requestId !== 'string' || !agentRequestIdPattern.test(requestId)) {
    return;
  }
  if (
    event.sender !== mainWindow?.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    event.sender.send('agent:stream:failure', {
      requestId,
      message: 'Agent 请求来源无效。',
    });
    return;
  }

  const input = parseAgentStreamStart(value);
  if (!input) {
    event.sender.send('agent:stream:failure', {
      requestId,
      message: '输入内容无效，请检查后重试。',
    });
    return;
  }
  if (activeAgentStreams.has(input.requestId)) {
    event.sender.send('agent:stream:failure', {
      requestId: input.requestId,
      message: '该 Agent 请求正在运行，请稍后重试。',
    });
    return;
  }

  const channel = new MessageChannelMain();
  const active: ActiveAgentStream = {
    requestId: input.requestId,
    sender: event.sender,
    controller: new AbortController(),
    port: channel.port1,
  };
  activeAgentStreams.set(active.requestId, active);
  active.port.on('close', () => cancelBackendAgentStream(active.requestId, active.sender));
  active.port.start();

  try {
    event.sender.postMessage(
      'agent:stream:port',
      { requestId: active.requestId },
      [channel.port2],
    );
  } catch {
    cancelBackendAgentStream(active.requestId, active.sender);
    return;
  }
  void forwardAgentStream(active, input.prompt, input.conversationId);
}

/** Posts one normalized event and closes its resources at terminal events. */
function postAgentStreamEvent(
  active: ActiveAgentStream,
  event: AgentStreamEvent,
): boolean {
  if (activeAgentStreams.get(active.requestId) !== active) return false;
  try {
    if (!routeAgentStreamEvent(activeAgentStreams, active.requestId, event)) {
      return false;
    }
  } catch {
    cancelBackendAgentStream(active.requestId, active.sender);
    return false;
  }

  if (event.type === 'done' || event.type === 'error') {
    completeBackendAgentStream(active);
    return false;
  }
  return true;
}

/** Reads the fixed Agent endpoint incrementally and forwards only typed events. */
async function forwardAgentStream(
  active: ActiveAgentStream,
  prompt: string,
  conversationId?: string,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  try {
    if (!backendPort || !backendToken) {
      postAgentStreamEvent(active, {
        type: 'error',
        message: '本地服务暂不可用，请稍后重试。',
      });
      return;
    }

    const response = await fetch(
      `http://127.0.0.1:${backendPort}/api/agent/stream`,
      {
        method: 'POST',
        headers: {
          'x-teachforge-token': backendToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          ...(conversationId ? { conversationId } : {}),
        }),
        signal: active.controller.signal,
      },
    );
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('text/event-stream') ||
      !response.body
    ) {
      postAgentStreamEvent(active, {
        type: 'error',
        message: '本地 Agent 请求失败，请检查输入和服务状态。',
      });
      return;
    }

    reader = response.body.getReader();
    active.reader = reader;
    const decoder = new TextDecoder();
    const parser = new SseParser();
    while (!active.controller.signal.aborted) {
      const chunk = await reader.read();
      const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      const messages = parser.feed(text);
      for (const message of messages) {
        const streamEvent = decodeAgentSseMessage(message);
        if (!streamEvent) {
          postAgentStreamEvent(active, {
            type: 'error',
            message: '本地 Agent 返回了无法识别的流事件。',
          });
          finished = true;
          return;
        }
        const shouldContinue = postAgentStreamEvent(active, streamEvent);
        if (!shouldContinue) {
          finished = streamEvent.type === 'done' || streamEvent.type === 'error';
          return;
        }
      }
      if (chunk.done) break;
    }
    parser.finish();

    if (!active.controller.signal.aborted && !finished) {
      postAgentStreamEvent(active, {
        type: 'error',
        message: 'Agent 响应意外结束，请重试。',
      });
    }
  } catch {
    if (!active.controller.signal.aborted) {
      postAgentStreamEvent(active, {
        type: 'error',
        message: '无法连接本地 Agent 服务，请检查服务状态后重试。',
      });
    }
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The response may already be cancelled by the active AbortController.
      }
      reader.releaseLock();
    }
    active.reader = undefined;
    completeBackendAgentStream(active);
  }
}

/** Removes a completed request and closes its per-request MessagePort. */
function completeBackendAgentStream(active: ActiveAgentStream): void {
  if (activeAgentStreams.get(active.requestId) !== active) return;
  activeAgentStreams.delete(active.requestId);
  active.port.removeAllListeners();
  active.port.close();
}

/** Aborts one Renderer-owned stream and cancels its active response reader. */
function cancelBackendAgentStream(requestId: string, sender: WebContents): void {
  const active = activeAgentStreams.get(requestId);
  if (!active || active.sender !== sender) return;
  activeAgentStreams.delete(requestId);
  active.controller.abort();
  if (active.reader) void active.reader.cancel().catch(() => undefined);
  active.port.removeAllListeners();
  active.port.close();
}

/** Cancels every active Agent stream before the application shuts down. */
function cancelAllAgentStreams(): void {
  for (const active of activeAgentStreams.values()) {
    cancelBackendAgentStream(active.requestId, active.sender);
  }
}

/** Creates the isolated Renderer window and opens DevTools in development. */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f0f2ed',
    title: 'TeachForge',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const expectedFileUrl = pathToFileURL(path.join(__dirname, '../../../dist/index.html')).href;
    const isAllowedNavigation = devUrl
      ? new URL(targetUrl).origin === new URL(devUrl).origin && new URL(targetUrl).pathname === '/'
      : targetUrl === expectedFileUrl;
    if (!isAllowedNavigation) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    cancelAllAgentStreams();
    mainWindow = undefined;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl).then(() => {
      mainWindow?.webContents.openDevTools();
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  registerBackendIpc();
  try {
    await startBackend();
    createWindow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'TeachForge 启动失败',
      message: '本地后端未能启动。',
      detail: message,
    });
    await stopBackend();
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  cancelAllAgentStreams();
  void stopBackend().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});
