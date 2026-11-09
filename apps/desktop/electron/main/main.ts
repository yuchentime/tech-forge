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
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import type {
  ChatStreamEvent,
  BackendRequest,
} from '../../src/types/desktop-bridge';
import {
  getNetworkErrorCode,
  requestBackend,
} from './backend-request';
import { SseParser } from './sse-parser';
import { decodeChatSseMessage } from './stream-protocol';
import { routeChatStreamEvent } from './stream-routing';

const READY_PREFIX = 'TEACHFORGE_BACKEND_READY=';
const STARTUP_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_CHAT_PROMPT_LENGTH = 10_000;
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const chatRequestIdPattern = /^chat-\d+-\d+$/;

type BackendChild = UtilityProcess | ChildProcess;
type ChatStreamStart = {
  requestId: string;
  prompt: string;
  conversationId?: string;
};
type ActiveChatStream = {
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
const activeChatStreams = new Map<string, ActiveChatStream>();
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
        if (!line.startsWith(READY_PREFIX)) {
          console.log(`[backend] ${line}`);
          continue;
        }
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

/** Registers the existing JSON bridge and the dedicated chat stream IPC. */
function registerBackendIpc(): void {
  ipcMain.handle('backend:state', () => ({
    ready: backendPort !== undefined,
    port: backendPort ?? null,
  }));

  // Returns absolute paths only: the Renderer never reads file bytes, and the backend copies the
  // chosen file into the configured workspace itself.
  ipcMain.handle('documents:pick-files', async () => {
    const options: OpenDialogOptions = {
      title: '选择要导入资料库的资料',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '资料库资料', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('backend:request', async (_event, value: unknown) => {
    if (!isBackendRequest(value)) {
      throw new Error('请求无效，请重试。');
    }
    if (!backendPort || !backendToken) {
      throw new Error('本地服务还没准备好，请稍后重试；如果一直失败，请重启 TeachForge。');
    }

    const input = value as BackendRequest;
    try {
      return await requestBackend(
        { port: backendPort, token: backendToken },
        input,
      );
    } catch (error) {
      // Keep the failing method/path in the desktop log so a reset can be traced to a request.
      console.error('[desktop] backend request failed', {
        method: input.method,
        path: input.path,
        code: getNetworkErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  ipcMain.on('chat:stream:start', (event, value: unknown) => {
    startChatStream(event, value);
  });
  ipcMain.on('chat:stream:cancel', (event, value: unknown) => {
    if (typeof value === 'string') {
      cancelBackendChatStream(value, event.sender);
    }
  });
}

/** Validates the narrow Renderer request before creating a stream channel. */
function parseChatStreamStart(value: unknown): ChatStreamStart | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<ChatStreamStart>;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !['requestId', 'prompt', 'conversationId'].includes(key)) ||
    keys.length < 2 ||
    keys.length > 3 ||
    typeof input.requestId !== 'string' ||
    !chatRequestIdPattern.test(input.requestId) ||
    typeof input.prompt !== 'string' ||
    (input.conversationId !== undefined &&
      (typeof input.conversationId !== 'string' ||
        !conversationIdPattern.test(input.conversationId)))
  ) {
    return undefined;
  }

  const prompt = input.prompt.trim();
  if (!prompt || Array.from(prompt).length > MAX_CHAT_PROMPT_LENGTH) {
    return undefined;
  }
  return {
    requestId: input.requestId,
    prompt,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  };
}

/** Starts a single chat stream only for the main application frame. */
function startChatStream(event: IpcMainEvent, value: unknown): void {
  const requestId =
    value && typeof value === 'object'
      ? (value as { requestId?: unknown }).requestId
      : undefined;
  if (typeof requestId !== 'string' || !chatRequestIdPattern.test(requestId)) {
    return;
  }
  if (
    event.sender !== mainWindow?.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    event.sender.send('chat:stream:failure', {
      requestId,
      message: 'Agent 请求来源无效。',
    });
    return;
  }

  const input = parseChatStreamStart(value);
  if (!input) {
    event.sender.send('chat:stream:failure', {
      requestId,
      message: '输入内容无效，请检查后重试。',
    });
    return;
  }
  if (activeChatStreams.has(input.requestId)) {
    event.sender.send('chat:stream:failure', {
      requestId: input.requestId,
      message: '该 Agent 请求正在运行，请稍后重试。',
    });
    return;
  }

  const channel = new MessageChannelMain();
  const active: ActiveChatStream = {
    requestId: input.requestId,
    sender: event.sender,
    controller: new AbortController(),
    port: channel.port1,
  };
  activeChatStreams.set(active.requestId, active);
  active.port.on('close', () => cancelBackendChatStream(active.requestId, active.sender));
  active.port.start();

  try {
    event.sender.postMessage(
      'chat:stream:port',
      { requestId: active.requestId },
      [channel.port2],
    );
  } catch {
    cancelBackendChatStream(active.requestId, active.sender);
    return;
  }
  void forwardChatStream(active, input.prompt, input.conversationId);
}

/** Posts one normalized event and closes its resources at terminal events. */
function postChatStreamEvent(
  active: ActiveChatStream,
  event: ChatStreamEvent,
): boolean {
  if (activeChatStreams.get(active.requestId) !== active) return false;
  try {
    if (!routeChatStreamEvent(activeChatStreams, active.requestId, event)) {
      return false;
    }
  } catch {
    cancelBackendChatStream(active.requestId, active.sender);
    return false;
  }

  if (event.type === 'done' || event.type === 'error') {
    completeBackendChatStream(active);
    return false;
  }
  return true;
}

/** Reads the fixed Chat endpoint incrementally and forwards only typed events. */
async function forwardChatStream(
  active: ActiveChatStream,
  prompt: string,
  conversationId?: string,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  try {
    if (!backendPort || !backendToken) {
      postChatStreamEvent(active, {
        type: 'error',
        message: '本地服务暂不可用，请稍后重试。',
      });
      return;
    }

    const response = await fetch(
      `http://127.0.0.1:${backendPort}/api/chat/stream`,
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
      postChatStreamEvent(active, {
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
        const streamEvent = decodeChatSseMessage(message);
        if (!streamEvent) {
          postChatStreamEvent(active, {
            type: 'error',
            message: '本地 Agent 返回了无法识别的流事件。',
          });
          finished = true;
          return;
        }
        const shouldContinue = postChatStreamEvent(active, streamEvent);
        if (!shouldContinue) {
          finished = streamEvent.type === 'done' || streamEvent.type === 'error';
          return;
        }
      }
      if (chunk.done) break;
    }
    parser.finish();

    if (!active.controller.signal.aborted && !finished) {
      postChatStreamEvent(active, {
        type: 'error',
        message: 'Agent 响应意外结束，请重试。',
      });
    }
  } catch {
    if (!active.controller.signal.aborted) {
      postChatStreamEvent(active, {
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
    completeBackendChatStream(active);
  }
}

/** Removes a completed request and closes its per-request MessagePort. */
function completeBackendChatStream(active: ActiveChatStream): void {
  if (activeChatStreams.get(active.requestId) !== active) return;
  activeChatStreams.delete(active.requestId);
  active.port.removeAllListeners();
  active.port.close();
}

/** Aborts one Renderer-owned stream and cancels its active response reader. */
function cancelBackendChatStream(requestId: string, sender: WebContents): void {
  const active = activeChatStreams.get(requestId);
  if (!active || active.sender !== sender) return;
  activeChatStreams.delete(requestId);
  active.controller.abort();
  if (active.reader) void active.reader.cancel().catch(() => undefined);
  active.port.removeAllListeners();
  active.port.close();
}

/** Cancels every active chat stream before the application shuts down. */
function cancelAllChatStreams(): void {
  for (const active of activeChatStreams.values()) {
    cancelBackendChatStream(active.requestId, active.sender);
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
    icon: path.join(app.getAppPath(), 'public', 'logo.ico'),
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
    cancelAllChatStreams();
    mainWindow = undefined;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl).then(() => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
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
  cancelAllChatStreams();
  void stopBackend().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});
