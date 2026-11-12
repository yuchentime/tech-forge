import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsClockwise, ArrowsOut, X } from '@phosphor-icons/react';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import { conversationStore } from './conversation-store';
import {
  ALL_FILES_TAB_ID,
  artifactListStore,
  artifactTabsStore,
} from './artifact-store';
import {
  ArtifactFileRow,
  ArtifactTabs,
} from './ArtifactSidebarParts';
import { ArtifactPreview } from './ArtifactPreview';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  planArtifactLayout,
} from './layout-budget';

/** Remembers the width the user chose, so a narrow window cannot rewrite it. */
const SIDEBAR_WIDTH_STORAGE_KEY = 'teachforge.artifacts.sidebarWidth';

/**
 * Delay before the window shrinks back after the panel closes.
 *
 * Without it, a double click on the file entry (or a stray Escape) would grow and shrink the
 * window twice for an action the user meant once.
 */
const RELEASE_DELAY_MS = 250;

/** Reads the stored panel preference, falling back to the default when storage is unavailable. */
function readStoredPanelWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(parsed) && parsed > 0) return clampPanelWidth(parsed);
  } catch {
    // Private or unavailable storage keeps the default width.
  }
  return PANEL_DEFAULT_WIDTH;
}

/** Persists the panel preference, ignoring storage failures. */
function storePanelWidth(value: number): void {
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
 * artifact's preview. Nothing here writes files or edits artifacts, and the file list itself is
 * fetched by the conversation page so the header entry and this panel share one snapshot.
 */
export function ArtifactSidebar() {
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
  const listState = useSyncExternalStore(
    artifactListStore.subscribe,
    artifactListStore.getSnapshot,
    artifactListStore.getSnapshot,
  );
  const conversationId = conversationState.activeConversationId;
  /** Rows of another conversation stay hidden until its own list arrives. */
  const files = listState.conversationId === conversationId ? listState.files : [];
  const error = listState.conversationId === conversationId ? listState.error : null;
  const isLoading = listState.status === 'loading';
  /** The user's width preference. The rendered width comes from the budget plan below. */
  const [requestedWidth, setRequestedWidth] = useState(readStoredPanelWidth);
  const requestedWidthRef = useRef(requestedWidth);
  /** Content width of the window, tracked so the plan follows OS resizes without a reload. */
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  /**
   * Widest content width the current display can give the window, reported by the main process.
   * `null` until the first growth reply: the plan then assumes growth still works.
   */
  const [maxContentWidth, setMaxContentWidth] = useState<number | null>(null);
  const maxContentWidthRef = useRef<number | null>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  /** True while the active file is shown in the full-window overlay instead of the panel. */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /**
   * Bumped by the header's refresh button. The model rewrites a file in place, so the artifact id
   * never changes and prop-driven re-render cannot notice an edit; this token is the manual trigger.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null);
  const fullscreenCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    requestedWidthRef.current = requestedWidth;
  }, [requestedWidth]);

  useEffect(() => {
    maxContentWidthRef.current = maxContentWidth;
  }, [maxContentWidth]);

  /** Keeps the plan in sync with OS-driven window resizes. */
  useEffect(() => {
    const handleResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /**
   * Asks the main process to widen the window until both the chat column and the panel fit.
   *
   * Growth is requested only when the layout actually needs more room, so opening the panel in a
   * window that already fits changes nothing at all. A failure leaves the CSS budget in charge.
   */
  const requestPanelWidth = useCallback(async (): Promise<void> => {
    if (!hasDesktopBridge()) return;
    const plan = planArtifactLayout({
      viewportContentWidth: window.innerWidth,
      requestedPanelWidth: requestedWidthRef.current,
      maxContentWidth: maxContentWidthRef.current,
    });
    if (!plan.needsGrowth && plan.mode !== 'overlay') return;
    try {
      const result = await window.teachforge.ensureContentWidth(plan.requiredContentWidth);
      maxContentWidthRef.current = result.maxContentWidth;
      setMaxContentWidth(result.maxContentWidth);
      setViewportWidth(result.contentWidth);
    } catch {
      // No window capability (or a refused request): keep the panel inside the current width.
    }
  }, []);

  /**
   * Grows the window while the panel is open and restores the user's own size afterwards.
   *
   * The restore is delayed so toggling the panel twice does not resize the window twice, and the
   * main process still refuses to shrink a window the user resized in the meantime.
   */
  useEffect(() => {
    if (tabsState.visible) {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      void requestPanelWidth();
      return;
    }
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      if (hasDesktopBridge()) {
        void window.teachforge.releaseContentWidth().catch(() => undefined);
      }
      maxContentWidthRef.current = null;
      setMaxContentWidth(null);
    }, RELEASE_DELAY_MS);
  }, [requestPanelWidth, tabsState.visible]);

  useEffect(
    () => () => {
      // Unmounting (settings, library, rehearsal) closes the panel without going through the
      // visibility effect, so the growth is released here too.
      if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
      if (hasDesktopBridge()) {
        void window.teachforge.releaseContentWidth().catch(() => undefined);
      }
    },
    [],
  );

  /** Stores one width preference; the rendered width stays budget-driven. */
  const applyWidth = useCallback((next: number): number => {
    const clamped = clampPanelWidth(next);
    setRequestedWidth(clamped);
    return clamped;
  }, []);

  /** Starts a drag; pointer capture keeps the move events on the handle. */
  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = {
        startX: event.clientX,
        startWidth: requestedWidthRef.current,
      };
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

  /** Ends the drag: stores the preference and widens the window if the user asked for more room. */
  const handleResizeEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current;
      if (!drag) return;
      dragState.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      // Only the preference is stored: the rendered width stays a function of the budget, so a
      // narrow window can never overwrite what the user asked for.
      storePanelWidth(requestedWidthRef.current);
      if (requestedWidthRef.current <= drag.startWidth) return;
      void requestPanelWidth();
    },
    [requestPanelWidth],
  );

  /** Resizes from the keyboard so the handle is reachable without a pointer. */
  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const previous = requestedWidthRef.current;
      const next = applyWidth(previous + (event.key === 'ArrowLeft' ? 24 : -24));
      storePanelWidth(next);
      if (next > previous) void requestPanelWidth();
    },
    [applyWidth, requestPanelWidth],
  );

  const activeTab =
    tabsState.activeId === ALL_FILES_TAB_ID
      ? null
      : tabsState.tabs.find((tab) => tab.id === tabsState.activeId) ??
        tabsState.tabs[0] ??
        null;

  // Tab objects get new identities on store updates; keying the effects on primitives keeps them
  // from re-running (and re-stealing focus) on an unchanged file.
  const activeTabId = activeTab?.id ?? null;

  /**
   * Keeps the overlay keyboard-accessible: Escape closes it, the background stops scrolling, and
   * focus moves into the overlay and back to the trigger, so closing it returns the panel's focus.
   */
  useEffect(() => {
    if (!isFullscreen || activeTabId === null) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsFullscreen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    fullscreenCloseRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      fullscreenTriggerRef.current?.focus();
    };
  }, [isFullscreen, activeTabId]);

  // Closing the last tab must not leave an overlay pointing at a file that no longer exists.
  useEffect(() => {
    if (activeTabId === null && isFullscreen) setIsFullscreen(false);
  }, [activeTabId, isFullscreen]);

  /** How the panel and the chat share this window right now. */
  const plan = planArtifactLayout({
    viewportContentWidth: viewportWidth,
    requestedPanelWidth: requestedWidth,
    maxContentWidth,
  });
  const isOverlay = plan.mode === 'overlay';

  // The floating panel covers part of the chat, so it gets the same Escape affordance as the
  // full-screen preview instead of relying on the close button alone.
  useEffect(() => {
    if (!isOverlay || !tabsState.visible) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') artifactTabsStore.hide();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOverlay, tabsState.visible]);

  if (!tabsState.visible) return null;

  return (
    <aside
      className={
        // Row layout: the resize handle is the aside's first child and must sit beside the
        // content, so the container must never become a column.
        isOverlay
          ? 'absolute inset-y-0 right-0 z-30 flex w-full min-w-0 border-l border-ink-200 bg-white shadow-2xl md:w-[var(--artifact-sidebar-width)]'
          : 'flex w-full min-w-0 shrink-0 border-t border-ink-200 bg-white md:h-full md:w-[var(--artifact-sidebar-width)] md:border-l md:border-t-0'
      }
      style={{ '--artifact-sidebar-width': `${plan.panelWidth}px` } as React.CSSProperties}
    >
      <div
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuenow={plan.panelWidth}
        className="hidden w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center border-r border-ink-200 transition hover:bg-brand-600/20 focus-visible:bg-brand-600/25 focus-visible:outline-none md:flex"
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
          onClosePanel={() => artifactTabsStore.hide()}
          tabs={tabsState.tabs}
        />

        {activeTab ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-100 px-4 py-2">
              <h2 className="min-w-0 truncate text-sm font-medium text-ink-900">
                {activeTab.fileName}
              </h2>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* Only the notable case keeps a label; a session file needs no announcement. */}
                {activeTab.external && (
                  <span className="text-xs text-ink-500">外部文件</span>
                )}
                <button
                  aria-label="重新读取文件"
                  className="flex size-7 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-200 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
                  onClick={() => setReloadToken((token) => token + 1)}
                  title="重新读取文件"
                  type="button"
                >
                  <ArrowsClockwise aria-hidden="true" className="size-4" />
                </button>
                <button
                  aria-label="全屏查看"
                  className="flex size-7 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-200 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
                  onClick={() => setIsFullscreen(true)}
                  ref={fullscreenTriggerRef}
                  title="全屏查看"
                  type="button"
                >
                  <ArrowsOut aria-hidden="true" className="size-4" />
                </button>
              </div>
            </header>
            <ArtifactPreview file={activeTab} reloadToken={reloadToken} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-100 px-4 py-2">
              <h2 className="text-sm font-medium text-ink-900">本会话生成的文件</h2>
              <button
                className="shrink-0 text-xs text-ink-500 underline underline-offset-2 hover:text-ink-800"
                onClick={() => void artifactListStore.load(conversationId)}
                type="button"
              >
                刷新
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
              {isLoading && files.length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-500">正在加载文件…</p>
              )}
              {error && (
                <p className="px-3 py-2 text-sm text-rose-700" role="alert">
                  {error}
                </p>
              )}
              {!isLoading && !error && files.length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-500">
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
      {isFullscreen &&
        activeTab &&
        createPortal(
          // Sits below the toast layer (z-50) so notices still show over the overlay, and is
          // portalled onto the body to escape the panel's clipping and scroll containers.
          <div
            aria-label={`${activeTab.fileName} 全屏预览`}
            aria-modal="true"
            className="fixed inset-0 z-40 flex flex-col bg-white"
            role="dialog"
          >
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-200 px-4 py-2">
              <h2 className="min-w-0 truncate text-sm font-medium text-ink-900">
                {activeTab.fileName}
              </h2>
              <div className="flex shrink-0 items-center gap-1.5">
                {activeTab.external && (
                  <span className="text-xs text-ink-500">外部文件</span>
                )}
                <button
                  aria-label="重新读取文件"
                  className="flex size-7 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-200 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
                  onClick={() => setReloadToken((token) => token + 1)}
                  title="重新读取文件"
                  type="button"
                >
                  <ArrowsClockwise aria-hidden="true" className="size-4" />
                </button>
                <button
                  aria-label="退出全屏"
                  className="flex size-7 items-center justify-center rounded-md text-ink-500 transition hover:bg-ink-200 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
                  onClick={() => setIsFullscreen(false)}
                  ref={fullscreenCloseRef}
                  title="退出全屏（Esc）"
                  type="button"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ArtifactPreview file={activeTab} reloadToken={reloadToken} />
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
