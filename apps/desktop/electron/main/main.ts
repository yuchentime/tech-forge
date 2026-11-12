import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  screen,
  shell,
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
  ContentWidthResult,
} from '../../src/types/desktop-bridge';
import {
  getNetworkErrorCode,
  requestBackend,
} from './backend-request';
import {
  CLASSROOM_ASPECT_RATIO,
  MIN_CONTENT_WIDTH,
  clampContentWidthRequest,
  isSnappedWidth,
  planAspectLock,
  planWindowGrowth,
  resolveRestoredBounds,
  sameHorizontalBounds,
  type WindowRect,
} from './window-layout';
import { SseParser } from './sse-parser';
import { decodeChatSseMessage } from './stream-protocol';
import { routeChatStreamEvent } from './stream-routing';

const READY_PREFIX = 'TEACHFORGE_BACKEND_READY=';
const STARTUP_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_CHAT_PROMPT_LENGTH = 10_000;
/** Window geometry restored on launch; clamped into the current display before use. */
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 };
const MIN_WINDOW_SIZE = { width: 960, height: 640 };
/** Debounce before persisting a moved or resized window, so dragging writes once. */
const WINDOW_STATE_SAVE_DELAY_MS = 500;
const WINDOW_STATE_FILE = 'window-state.json';
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const chatRequestIdPattern = /^chat-\d+-\d+$/;

type BackendChild = UtilityProcess | ChildProcess;
type ChatStreamStart = {
  requestId: string;
  prompt: string;
  conversationId?: string;
  attachments?: Array<{ attachmentId: string; path: string }>;
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

// A single instance owns the local backend. Without this lock, a second launch would start a
// second backend on a random port and both would write the same `~/.tech-forge` files; the
// conversation database survives that through WAL, but the sql.js memory database would not.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

/** Uses the renderer's PNG asset for the macOS Dock icon while running from source. */
function configureDevelopmentDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin' || !app.dock) return;

  // Compiled main lives at `dist-electron/electron/main`, so the asset path is stable in both
  // development (`apps/desktop/public`) and packaged (`app.asar/apps/desktop/public`) layouts.
  const iconPath = path.join(__dirname, '../../../public', 'logo.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

/** Resolves the backend entry for packaged and development Electron builds. */
function getBackendEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'dist', 'main.js');
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
      TEACHFORGE_HOST: '127.0.0.1',
      TEACHFORGE_PORT: '0',
      TEACHFORGE_AUTH_TOKEN: backendToken,
    };
    // Without an explicit override the backend owns the default `~/.tech-forge` root; Electron's own
    // `userData` is only reported so a database left there by an older build is moved on first start.
    if (configuredDataDirectory) {
      env.TEACHFORGE_DATA_DIR = configuredDataDirectory;
    } else {
      env.TEACHFORGE_LEGACY_DATA_DIR = app.getPath('userData');
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
        // TypeORM resolves migration glob results against the process cwd. Inheriting the
        // launcher's cwd breaks that when it sits on another drive (a shortcut starts in
        // `C:\Windows\System32` while the backend may be installed on `D:`), so pin it to the
        // backend directory exactly like the development `spawn` below does.
        cwd: path.dirname(entry),
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

/** Growth the artifact panel applied, kept so closing the panel can undo exactly that change. */
/**
 * What growth changed about one window.
 *
 * Every write is derived from `baseline`, the rect the user had before the panel widened the
 * window. Re-reading the bounds after each write would feed DPI rounding back into the next
 * write, which at 125% scaling drifts a pixel per open/close cycle; deriving both the grown and
 * the restored rect from the same captured values keeps repeated cycles pixel-identical.
 */
type PendingGrowth = {
  /** The user's own window rect, captured before the first growth of this panel session. */
  baseline: WindowRect;
  /** The rect growth wrote; a different horizontal bounds means the user resized since. */
  applied: WindowRect;
};

const pendingGrowth = new WeakMap<BrowserWindow, PendingGrowth>();
/**
 * The classroom-mode aspect lock of each window.
 *
 * `baseline` is the rect the user had before entering the mode. `resized` records that the user
 * changed the window inside the mode, so leaving then keeps their size instead of snapping back;
 * it is used instead of comparing bounds because the window manager rewrites the rect the mode
 * writes by a few pixels, which a comparison could not tell apart from a real resize.
 */
type AspectLock = {
  baseline: WindowRect;
  resized: boolean;
};

const aspectLocks = new WeakMap<BrowserWindow, AspectLock>();
/**
 * The rect each window had before the artifact panel first widened it.
 *
 * Kept for the whole window session, not per open: writing back a value read from the window and
 * then writing it again compounds DPI rounding, so the same captured size is used until the user
 * resizes the window themselves.
 */
const windowBaselines = new WeakMap<BrowserWindow, WindowRect>();
let windowStateTimer: NodeJS.Timeout | undefined;

/** Path of the persisted window geometry inside the Electron user data directory. */
function windowStatePath(): string {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

/** Reads the last window geometry, ignoring a missing or corrupted file. */
function readStoredWindowState(): Partial<WindowRect> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(windowStatePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Partial<WindowRect>;
  } catch {
    return null;
  }
}

/** Persists one window geometry; a failed write only costs the next launch's placement. */
function storeWindowState(bounds: WindowRect): void {
  try {
    writeFileSync(windowStatePath(), JSON.stringify(bounds), 'utf8');
  } catch {
    // Read-only or full user data directories keep the default window size.
  }
}

/**
 * Saves the current geometry on a debounce, so dragging a window writes once instead of per frame.
 */
function scheduleWindowStateSave(win: BrowserWindow): void {
  if (windowStateTimer !== undefined) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = undefined;
    saveWindowState(win);
  }, WINDOW_STATE_SAVE_DELAY_MS);
}

/**
 * Saves the geometry the next launch should restore.
 *
 * The width is the one the user chose, not the temporary width the artifact panel asked for, and
 * maximized/full-screen states are skipped: restoring a maximized window would hide its own size.
 */
function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
  const bounds = win.getBounds();
  // Classroom mode owns the geometry while it is active; persist the size the user returns to.
  const lock = aspectLocks.get(win);
  if (lock) {
    storeWindowState(lock.baseline);
    return;
  }
  const growth = pendingGrowth.get(win);
  // While the panel holds a grown window, save the size the user will return to.
  storeWindowState(
    growth
      ? { ...bounds, width: growth.baseline.width, height: growth.baseline.height }
      : bounds,
  );
}

/** Resolves one window geometry for creation, clamped into the current display. */
function resolveInitialWindowBounds(): WindowRect | null {
  return resolveRestoredBounds({
    stored: readStoredWindowState(),
    workArea: screen.getPrimaryDisplay().workArea,
    minSize: MIN_WINDOW_SIZE,
  });
}

/**
 * Locks or releases the window to the classroom stage's aspect ratio.
 *
 * Entering first leaves maximize/full screen (the ratio only binds a normal window) and writes the
 * 16:9 content rect that `planAspectLock` derives from the user's own size; the baseline is kept so
 * leaving can return to it. Releasing restores that baseline only while the user has not resized
 * the window inside the mode.
 *
 * The ratio is enforced in `will-resize` instead of `win.setAspectRatio`: measured on Windows, that
 * API constrains the *outer* window, which left the content area ~3% wider than 16:9 and made the
 * stage letterbox (its excluded-size argument did not change that).
 */
function applyClassroomMode(win: BrowserWindow, enabled: boolean): void {
  const existing = aspectLocks.get(win);
  if (enabled) {
    if (existing) return;
    // A maximized or full-screen window is sized by the OS and cannot honour the ratio; the
    // previous normal rect is what the mode measures and what leaving restores.
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const baseline = win.getBounds();
    const applied = planAspectLock({
      bounds: baseline,
      contentBounds: win.getContentBounds(),
      workArea: screen.getDisplayMatching(baseline).workArea,
      aspectRatio: CLASSROOM_ASPECT_RATIO,
    });
    aspectLocks.set(win, { baseline, resized: false });
    win.setBounds(applied, false);
    return;
  }

  if (!existing) return;
  aspectLocks.delete(win);
  // Restoring would undo a maximize or resize the user made while the mode was open.
  if (win.isMaximized() || win.isFullScreen() || existing.resized) return;
  win.setBounds(existing.baseline, false);
}

/**
 * Corrects one manual resize so the content area keeps the classroom ratio.
 *
 * Returns `null` when no classroom lock is active. The axis the user moved the most is kept as the
 * requested value and the other one is derived, so dragging the right edge widens the window while
 * a bottom-edge drag keeps the height the pointer asked for.
 */
function correctAspectResize(win: BrowserWindow, proposed: WindowRect): WindowRect | null {
  const lock = aspectLocks.get(win);
  if (!lock) return null;
  lock.resized = true;
  const current = win.getBounds();
  const content = win.getContentBounds();
  const frameWidth = Math.max(0, current.width - content.width);
  const frameHeight = Math.max(0, current.height - content.height);
  const proposedContentWidth = Math.max(1, proposed.width - frameWidth);
  const proposedContentHeight = Math.max(1, proposed.height - frameHeight);
  // Compare relative deltas so a small window is not biased toward the width.
  const widthDominant =
    Math.abs(proposedContentWidth - content.width) * content.height >=
    Math.abs(proposedContentHeight - content.height) * content.width;
  const contentWidth = widthDominant
    ? proposedContentWidth
    : proposedContentHeight * CLASSROOM_ASPECT_RATIO;
  const contentHeight = widthDominant
    ? proposedContentWidth / CLASSROOM_ASPECT_RATIO
    : proposedContentHeight;
  return {
    x: proposed.x,
    y: proposed.y,
    width: Math.round(contentWidth + frameWidth),
    height: Math.round(contentHeight + frameHeight),
  };
}

/**
 * Registers the artifact panel's width budget IPC.
 *
 * The Renderer only states how wide its content must be; the main process owns the geometry and
 * never lets a request leave the display work area. Growth is remembered so releasing it restores
 * the user's own window size, and only when the user has not resized the window since.
 */
function registerWindowIpc(): void {
  ipcMain.handle(
    'window:ensure-content-width',
    (event, value: unknown): ContentWidthResult => {
      const minContentWidth = clampContentWidthRequest(value);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) throw new Error('窗口不可用，请重试。');

      const bounds = win.getBounds();
      const contentBounds = win.getContentBounds();
      const frame = Math.max(0, bounds.width - contentBounds.width);
      const workArea = screen.getDisplayMatching(bounds).workArea;
      const maxContentWidth = Math.max(MIN_CONTENT_WIDTH, workArea.width - frame);
      // Growing would unmaximize, drop a Windows snap, or fight the user's own layout; the
      // Renderer reads the returned cap and floats the panel over the chat instead.
      if (
        win.isMaximized() ||
        win.isFullScreen() ||
        isSnappedWidth(bounds.width, workArea.width)
      ) {
        return { contentWidth: contentBounds.width, maxContentWidth };
      }

      // The baseline is captured once per window and reused by every later open, so neither the
      // grown nor the restored rect inherits a rounding error from a previous cycle.
      let baseline = windowBaselines.get(win);
      if (!baseline) {
        baseline = bounds;
        windowBaselines.set(win, baseline);
      }
      const target = planWindowGrowth({ bounds, contentBounds, workArea, minContentWidth });
      if (!target) return { contentWidth: contentBounds.width, maxContentWidth };

      const applied = {
        x: target.x,
        y: bounds.y,
        width: target.width,
        height: baseline.height,
      };
      win.setBounds(applied, false);
      pendingGrowth.set(win, { baseline, applied });
      return { contentWidth: target.width - frame, maxContentWidth };
    },
  );

  ipcMain.handle('window:release-content-width', (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const growth = pendingGrowth.get(win);
    if (!growth) return;
    // Keep the record while the window is maximized: the grown rect is still its normal rect, so
    // the growth must be undone when the user later restores the window.
    if (win.isMaximized() || win.isFullScreen()) return;
    pendingGrowth.delete(win);

    const bounds = win.getBounds();
    // A different width or x means the user resized while the panel was open: their size wins.
    if (!sameHorizontalBounds(bounds, growth.applied)) return;
    // Restores the captured rect instead of a recomputed one, so the height the user had is
    // written back verbatim even if Electron reported a rounded value in between.
    win.setBounds(
      {
        x: bounds.x,
        y: bounds.y,
        width: growth.baseline.width,
        height: growth.baseline.height,
      },
      false,
    );
  });

  // The classroom stage only says whether it is on screen; the main process owns the ratio, the
  // geometry, and the restore of the user's own size.
  ipcMain.handle('window:set-classroom-mode', (event, value: unknown): void => {
    if (typeof value !== 'boolean') throw new Error('课堂模式参数无效。');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) throw new Error('窗口不可用，请重试。');
    applyClassroomMode(win, value);
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
      title: '选择要添加的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文件', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  // Chat attachments also accept images: the backend encodes them for the model's vision input,
  // while the knowledge library keeps its document-only picker.
  ipcMain.handle('chat:pick-attachments', async () => {
    const options: OpenDialogOptions = {
      title: '选择要附加的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的文件',
          extensions: [
            'pdf',
            'docx',
            'md',
            'markdown',
            'txt',
            'png',
            'jpg',
            'jpeg',
            'gif',
            'webp',
          ],
        },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  // Reveals a path the artifact API resolved. The Renderer never invents a path, so this only
  // navigates to files the conversation already produced.
  ipcMain.handle('shell:reveal', (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      return false;
    }
    if (!path.isAbsolute(value)) return false;
    try {
      if (existsSync(value)) {
        shell.showItemInFolder(value);
        return true;
      }
      const directory = path.dirname(value);
      if (existsSync(directory)) {
        void shell.openPath(directory);
        return true;
      }
      return false;
    } catch {
      return false;
    }
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
    keys.some(
      (key) =>
        ![
          'requestId',
          'prompt',
          'conversationId',
          'attachments',
        ].includes(key),
    ) ||
    keys.length < 2 ||
    keys.length > 4 ||
    typeof input.requestId !== 'string' ||
    !chatRequestIdPattern.test(input.requestId) ||
    typeof input.prompt !== 'string' ||
    (input.conversationId !== undefined &&
      (typeof input.conversationId !== 'string' ||
        !conversationIdPattern.test(input.conversationId)))
  ) {
    return undefined;
  }

  const attachments =
    input.attachments === undefined
      ? undefined
      : parseChatAttachments(input.attachments);
  if (input.attachments !== undefined && !attachments) {
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
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Accepts at most ten `{ attachmentId, path }` pairs with no duplicate ids.
 *
 * The channel is the Renderer's only way to name attachments, so it is validated here as strictly as
 * the backend DTO: a malformed entry rejects the whole request instead of silently dropping a file.
 */
function parseChatAttachments(
  value: unknown,
): Array<{ attachmentId: string; path: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    return undefined;
  }
  const seen = new Set<string>();
  const attachments: Array<{ attachmentId: string; path: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const keys = Object.keys(entry);
    if (keys.length !== 2) return undefined;
    const { attachmentId, path } = entry as { attachmentId?: unknown; path?: unknown };
    if (
      typeof attachmentId !== 'string' ||
      !conversationIdPattern.test(attachmentId) ||
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 4096 ||
      seen.has(attachmentId)
    ) {
      return undefined;
    }
    seen.add(attachmentId);
    attachments.push({ attachmentId, path });
  }
  return attachments;
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
  void forwardChatStream(
    active,
    input.prompt,
    input.conversationId,
    input.attachments,
  );
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
  attachments?: Array<{ attachmentId: string; path: string }>,
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
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
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

/**
 * Removes Electron's default File/Edit/View/Window menu bar on Windows and Linux; that bar is
 * developer scaffolding and its items act on Renderer state the product does not expose.
 * macOS keeps the standard app menu because it owns Cmd+Q/Cmd+W and the app-level items.
 */
function configureApplicationMenu(): void {
  if (process.platform === 'darwin') return;
  Menu.setApplicationMenu(null);
}

/** Creates the isolated Renderer window and opens DevTools in development. */
function createWindow(): void {
  const restoredBounds = resolveInitialWindowBounds();
  mainWindow = new BrowserWindow({
    ...(restoredBounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    backgroundColor: '#f0f2ed',
    title: 'TeachForge',
    icon: path.join(__dirname, '../../../public', 'logo.ico'),
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
  const windowRef = mainWindow;
  // A user resize invalidates the pending growth, so closing the panel never shrinks a window the
  // user resized in the meantime. In classroom mode the same event enforces the content ratio.
  windowRef.on('will-resize', (event, newBounds) => {
    pendingGrowth.delete(windowRef);
    windowBaselines.delete(windowRef);
    const corrected = correctAspectResize(windowRef, newBounds);
    if (!corrected) return;
    event.preventDefault();
    windowRef.setBounds(corrected, false);
  });
  windowRef.on('resize', () => scheduleWindowStateSave(windowRef));
  windowRef.on('move', () => scheduleWindowStateSave(windowRef));
  windowRef.on('close', () => {
    if (windowStateTimer !== undefined) {
      clearTimeout(windowStateTimer);
      windowStateTimer = undefined;
    }
    saveWindowState(windowRef);
  });
  windowRef.on('closed', () => {
    pendingGrowth.delete(windowRef);
    aspectLocks.delete(windowRef);
    windowBaselines.delete(windowRef);
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
  if (!hasSingleInstanceLock) return;
  configureDevelopmentDockIcon();
  configureApplicationMenu();
  registerBackendIpc();
  registerWindowIpc();
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
