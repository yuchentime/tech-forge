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
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import type { BackendRequest } from '../../src/types/desktop-bridge';

const READY_PREFIX = 'TEACHFORGE_BACKEND_READY=';
const STARTUP_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 1_048_576;
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

type BackendChild = UtilityProcess | ChildProcess;

let backendChild: BackendChild | undefined;
let backendPort: number | undefined;
let backendToken: string | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

const configuredDataDirectory = process.env.TEACHFORGE_DATA_DIR;
if (configuredDataDirectory) {
  mkdirSync(configuredDataDirectory, { recursive: true });
  app.setPath('userData', configuredDataDirectory);
}

function getBackendEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'main.js');
  }

  return path.resolve(__dirname, '../../../../backend/dist/main.js');
}

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
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f5f4f0',
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

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
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
  void stopBackend().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});
