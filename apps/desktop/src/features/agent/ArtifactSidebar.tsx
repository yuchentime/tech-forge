import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import { conversationStore } from './conversation-store';
import {
  ALL_FILES_TAB_ID,
  artifactTabsStore,
  type GeneratedFileRef,
} from './artifact-store';
import {
  ArtifactFileRow,
  ArtifactTabs,
} from './ArtifactSidebarParts';
import { ArtifactPreview } from './ArtifactPreview';

/** Narrowest usable preview width; the chat column keeps the rest. */
const MIN_SIDEBAR_WIDTH = 320;

/** Widest preview width before the chat column is squeezed past usefulness. */
const MAX_SIDEBAR_WIDTH = 900;

/** Remembers the dragged width across restarts. */
const SIDEBAR_WIDTH_STORAGE_KEY = 'teachforge.artifacts.sidebarWidth';

/** Width reserved for the left sidebar and the chat column during a drag. */
const RESERVED_LAYOUT_WIDTH = 560;

/** Reads the stored width, falling back to the default when storage is unavailable. */
function readStoredSidebarWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(parsed, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);
    }
  } catch {
    // Private or unavailable storage keeps the default width.
  }
  return 384;
}

/** Persists the dragged width, ignoring storage failures. */
function storeSidebarWidth(value: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // A failed write only costs the stored width.
  }
}

/**
 * Renders the read-only artifact sidebar for the active conversation.
 *
 * The built-in tab lists every file the model produced in this conversation; file tabs show one
 * artifact's preview. Nothing here writes files or edits artifacts.
 */
export function ArtifactSidebar({ refreshToken }: { refreshToken: string }) {
  const tabsState = useSyncExternalStore(
    artifactTabsStore.subscribe,
    artifactTabsStore.getSnapshot,
    artifactTabsStore.getSnapshot,
  );
  const conversationState = useSyncExternalStore(
    conversationStore.subscribe,
    conversationStore.getSnapshot,
    conversationStore.getSnapshot,
  );
  const conversationId = conversationState.activeConversationId;
  const [width, setWidth] = useState(readStoredSidebarWidth);
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const [files, setFiles] = useState<readonly GeneratedFileRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  /** Loads the conversation's generated files, used by the list and by tab metadata refresh. */
  const loadFiles = useCallback(async () => {
    if (!conversationId || !hasDesktopBridge()) {
      setFiles([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await window.teachforge.request<GeneratedFileRef[]>({
        method: 'GET',
        path: `/api/conversations/${encodeURIComponent(conversationId)}/artifacts`,
      });
      if (response.status !== 200) {
        setError('文件列表加载失败。');
        return;
      }
      setFiles(response.data);
      // Tabs keep working across refreshes, so their missing flags stay current.
      artifactTabsStore.syncAll(response.data);
    } catch {
      setError('文件列表加载失败。');
    } finally {
      setIsLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles, refreshToken]);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  /** Applies one width, clamped to the range the layout can still show. */
  const applyWidth = useCallback((next: number): number => {
    const layoutLimit = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - RESERVED_LAYOUT_WIDTH);
    const clamped = Math.min(Math.max(next, MIN_SIDEBAR_WIDTH), Math.min(MAX_SIDEBAR_WIDTH, layoutLimit));
    setWidth(clamped);
    return clamped;
  }, []);

  /** Starts a drag; pointer capture keeps the move events on the handle. */
  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = { startX: event.clientX, startWidth: widthRef.current };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  /** Widens the panel as the pointer moves left, since the panel sits on the right. */
  const handleResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current;
      if (!drag) return;
      applyWidth(drag.startWidth + (drag.startX - event.clientX));
    },
    [applyWidth],
  );

  /** Ends the drag and stores the final width. */
  const handleResizeEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;
      dragState.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      storeSidebarWidth(widthRef.current);
    },
    [],
  );

  /** Resizes from the keyboard so the handle is reachable without a pointer. */
  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = applyWidth(
        widthRef.current + (event.key === 'ArrowLeft' ? 24 : -24),
      );
      storeSidebarWidth(next);
    },
    [applyWidth],
  );

  if (!tabsState.visible) return null;

  const activeTab =
    tabsState.activeId === ALL_FILES_TAB_ID
      ? null
      : tabsState.tabs.find((tab) => tab.id === tabsState.activeId) ??
        tabsState.tabs[0] ??
        null;

  return (
    <aside
      className="flex w-full min-w-0 shrink-0 border-t border-stone-200 bg-white md:h-full md:w-[var(--artifact-sidebar-width)] md:border-l md:border-t-0"
      style={{ '--artifact-sidebar-width': `${width}px` } as React.CSSProperties}
    >
      <div
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={width}
        className="hidden w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center border-r border-stone-200 transition hover:bg-emerald-800/20 focus-visible:bg-emerald-800/25 focus-visible:outline-none md:flex"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        role="separator"
        tabIndex={0}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <ArtifactTabs
          activeId={tabsState.activeId}
          onActivate={(id) => artifactTabsStore.activate(id)}
          onClose={(id) => artifactTabsStore.close(id)}
          tabs={tabsState.tabs}
        />

        {activeTab ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-100 px-4 py-2">
              <h2 className="min-w-0 truncate text-sm font-medium text-stone-900">
                {activeTab.fileName}
              </h2>
              <span className="shrink-0 text-xs text-stone-500">
                {activeTab.external ? '外部文件' : '会话文件'}
              </span>
            </header>
            <ArtifactPreview file={activeTab} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-100 px-4 py-2">
              <h2 className="text-sm font-medium text-stone-900">本会话生成的文件</h2>
              <button
                className="shrink-0 text-xs text-stone-500 underline underline-offset-2 hover:text-stone-800"
                onClick={() => void loadFiles()}
                type="button"
              >
                刷新
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
              {isLoading && files.length === 0 && (
                <p className="px-3 py-2 text-sm text-stone-500">正在加载文件…</p>
              )}
              {error && (
                <p className="px-3 py-2 text-sm text-rose-700" role="alert">
                  {error}
                </p>
              )}
              {!isLoading && !error && files.length === 0 && (
                <p className="px-3 py-2 text-sm text-stone-500">
                  这个会话还没有生成文件。
                </p>
              )}
              {files.length > 0 && (
                <div className="space-y-0.5">
                  {files.map((file) => (
                    <ArtifactFileRow file={file} key={file.id} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
