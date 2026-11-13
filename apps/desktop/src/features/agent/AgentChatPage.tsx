import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type AssistantRuntime,
} from '@assistant-ui/react';
import {
  CaretDown,
  Chats,
  Check,
  CircleNotch,
  Copy as CopyIcon,
  Database,
  FileText,
  GraduationCap,
  MagnifyingGlass,
  Sparkle,
  Stack,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { agentEventBus } from './agent-event-bus';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ArtifactSidebar } from './ArtifactSidebar';
import { KeywordSearch } from './KeywordSearch';
import { ArtifactEntry, ArtifactFileChips } from './ArtifactSidebarParts';
import { artifactHistoryStore, artifactListStore, artifactTabsStore } from './artifact-store';
import { ToastHost } from './toast';
import { describeFailure } from '../../api/backend-error';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import {
  AttachmentPickerButton,
  ComposerAttachmentChips,
  UserAttachmentChips,
} from './ComposerAttachments';
import {
  composerAttachmentStore,
  sentAttachmentStore,
} from './attachment-store';
import { ConversationSidebar, type SidebarView } from './ConversationSidebar';
import {
  SlashCommandMenu,
  getSlashCommand,
  useSlashCommandMenu,
} from './SlashCommandMenu';
import { composerCommandStore } from './composer-command-store';
import { toThreadMessage } from './conversation-history';
import { describeToolActivity } from './tool-activity-label';
import { KnowledgeBasePage } from '../knowledge/KnowledgeBasePage';
import { KnowledgeProfilePage } from '../knowledge-profile/KnowledgeProfilePage';
import { ClassroomHome } from '../classroom/ClassroomHome';
import { ClassroomMode } from '../classroom/ClassroomMode';
import { generateLessonSummary } from '../classroom/classroom-api';
import {
  REHEARSAL_REQUIRES_ROUND_HINT,
  hasCompletedConversationRound,
} from '../rehearsal/rehearsal-availability';
import { RehearsalMode } from '../rehearsal/RehearsalMode';
import { SettingsPage } from '../settings/SettingsPage';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import {
  conversationStore,
  type ConversationAttachment,
  type ConversationHistoryPage,
  type ConversationHistoryMessage,
  type ConversationToolActivity,
} from './conversation-store';

const CONVERSATION_HEADER_TITLE_LIMIT = 24;

/** Keeps the visible conversation title compact while preserving the full title for its tooltip. */
function truncateConversationTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= CONVERSATION_HEADER_TITLE_LIMIT) return title;
  return `${characters.slice(0, CONVERSATION_HEADER_TITLE_LIMIT - 1).join('')}…`;
}

/** Loads persisted conversation history into the long-lived Agent runtime. */
export function AgentChatPage({ runtime }: { runtime: AssistantRuntime }) {
  const threadListState = useSyncExternalStore(
    runtime.threads.subscribe,
    runtime.threads.getState,
    runtime.threads.getState,
  );
  const conversationState = useSyncExternalStore(
    conversationStore.subscribe,
    conversationStore.getSnapshot,
    conversationStore.getSnapshot,
  );
  const activity = useSyncExternalStore(
    agentEventBus.subscribe,
    agentEventBus.getTurnSnapshots,
    agentEventBus.getTurnSnapshots,
  );
  const liveActivity = useSyncExternalStore(
    agentEventBus.subscribe,
    () => agentEventBus.getSnapshotForThread(threadListState.mainThreadId),
    () => agentEventBus.getSnapshotForThread(threadListState.mainThreadId),
  );
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const hasCompletedRound = useAuiState((state) =>
    hasCompletedConversationRound(state.thread.messages),
  );
  const artifactTabs = useSyncExternalStore(
    artifactTabsStore.subscribe,
    artifactTabsStore.getSnapshot,
    artifactTabsStore.getSnapshot,
  );
  const artifactList = useSyncExternalStore(
    artifactListStore.subscribe,
    artifactListStore.getSnapshot,
    artifactListStore.getSnapshot,
  );
  const [activeView, setActiveView] = useState<SidebarView>('chat');
  /** Non-null only while the 16:9 stage is open; `lessonId: null` is a draft classroom. */
  const [classroomStage, setClassroomStage] = useState<{ lessonId: string | null } | null>(null);
  /** Lesson whose post-class summary is still generating after the stage closed. */
  const [classroomSummaryLessonId, setClassroomSummaryLessonId] = useState<string | null>(null);
  const [conversationDisplayMode, setConversationDisplayMode] =
    useState<'conversation' | 'rehearsal'>('conversation');
  /** Surface owning the keyword search box; the two surfaces never search at the same time. */
  const [searchSurface, setSearchSurface] = useState<'chat' | 'file' | null>(null);
  /** Bumped by Ctrl+F so a box that is already open takes focus and selects its query again. */
  const [searchFocusSeq, setSearchFocusSeq] = useState(0);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyErrorConversationId, setHistoryErrorConversationId] = useState<string | null>(null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [isLoadingEarlierMessages, setIsLoadingEarlierMessages] = useState(false);
  const [earlierMessagesError, setEarlierMessagesError] = useState<string | null>(null);
  const [historyPageRevision, setHistoryPageRevision] = useState(0);
  const [hasLoadedInitialList, setHasLoadedInitialList] = useState(false);
  const requestVersion = useRef(0);
  const restoredInitialConversation = useRef(false);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const slashMenu = useSlashCommandMenu(composerInputRef);
  const composerCommand = useSyncExternalStore(
    composerCommandStore.subscribe,
    composerCommandStore.getSnapshot,
    composerCommandStore.getSnapshot,
  );
  const composerCommandItem = getSlashCommand(composerCommand);
  /** Changes whenever a turn registers another file, so the list refetches after each artifact. */
  const liveArtifactToken = liveActivity.artifacts.map((file) => file.id).join('|');

  /** Keeps visible composer-only stores in the active thread's stable local namespace. */
  useEffect(() => {
    const localThreadId = threadListState.mainThreadId;
    composerAttachmentStore.setActiveThread(localThreadId);
    composerCommandStore.setActiveThread(localThreadId);
  }, [threadListState.mainThreadId]);

  useEffect(() => {
    void artifactListStore.load(conversationState.activeConversationId);
  }, [conversationState.activeConversationId, liveArtifactToken]);

  /** Fetches one history snapshot and replaces the visible local thread on success. */
  const loadConversation = useCallback(async (conversationId: string) => {
    await runtime.threads.switchToThread(conversationId);
    const threadRuntime = runtime.threads.getById(conversationId);
    // A visited background thread already owns its live message repository. Reloading persisted
    // history into it would reset the repository while its SSE adapter is still appending deltas.
    if (threadRuntime.getState().isRunning) {
      conversationStore.setActiveConversationId(conversationId);
      return;
    }
    const version = ++requestVersion.current;
    setLoadingConversationId(conversationId);
    setIsLoadingEarlierMessages(false);
    setEarlierMessagesError(null);
    setHistoryError(null);
    setHistoryErrorConversationId(null);
    let failureMessage = '历史消息加载失败，请重试。';

    if (!hasDesktopBridge()) {
      setLoadingConversationId(null);
      failureMessage = '浏览器预览无法读取本地会话，请通过 TeachForge 桌面应用打开。';
      console.error('[TeachForge][conversation.history] desktop_bridge_unavailable');
      setHistoryError(failureMessage);
      setHistoryErrorConversationId(null);
      return;
    }

    let httpStatus: number | null = null;
    try {
      const response = await window.teachforge.request<ConversationHistoryPage>({
        method: 'GET',
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      });
      httpStatus = response.status;
      if (response.status === 404) {
        await conversationStore.refresh();
        if (version !== requestVersion.current) return;

        const latestState = conversationStore.getSnapshot();
        const conversationStillListed = latestState.conversations.some(
          ({ id }) => id === conversationId,
        );
        if (latestState.listStatus === 'ready' && !conversationStillListed) {
          const activeConversationStillListed = latestState.conversations.some(
            ({ id }) => id === latestState.activeConversationId,
          );
          if (
            latestState.activeConversationId &&
            !activeConversationStillListed
          ) {
            conversationStore.setActiveConversationId(null);
          }
          failureMessage = '该会话已不存在，对话列表已刷新。';
        } else {
          failureMessage = '历史消息暂时不可用，请刷新对话列表后重试。';
        }
        setHistoryError(failureMessage);
        setHistoryErrorConversationId(conversationStillListed ? conversationId : null);
        return;
      }
      if (response.status !== 200) {
        failureMessage = `历史消息加载失败（HTTP ${response.status}），请重试。`;
        throw new Error(failureMessage);
      }
      if (!isConversationHistoryPage(response.data)) {
        failureMessage = '历史消息响应格式异常，请重试。';
        throw new Error(failureMessage);
      }
      if (version !== requestVersion.current) return;

      pendingScrollAnchor.current = null;
      restoreHistoryToolActivities(response.data.messages);
      restoreHistoryAttachments(response.data.messages);
      artifactHistoryStore.setFromHistory(response.data.messages);
      artifactTabsStore.selectConversation(conversationId);
      // The history footer now owns this conversation's files.
      agentEventBus.clearArtifacts(conversationId);
      threadRuntime.reset(response.data.messages.map(toThreadMessage));
      setHasEarlierMessages(response.data.hasMore);
      conversationStore.setActiveConversationId(conversationId);
    } catch (error) {
      if (version !== requestVersion.current) return;
      const bridgeUnavailable = !hasDesktopBridge();
      if (bridgeUnavailable) {
        failureMessage = '浏览器预览无法读取本地会话，请通过 TeachForge 桌面应用打开。';
      }
      console.error('[TeachForge][conversation.history] load_failed', {
        code: bridgeUnavailable ? 'desktop_bridge_unavailable' : 'history_request_failed',
        httpStatus,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      setHistoryError(failureMessage);
      setHistoryErrorConversationId(conversationId);
    } finally {
      if (version === requestVersion.current) setLoadingConversationId(null);
    }
  }, [runtime]);

  /** Loads and prepends the page immediately before the oldest visible message. */
  const loadEarlierMessages = useCallback(async () => {
    if (isRunning || isLoadingEarlierMessages || !hasEarlierMessages) return;
    const conversationId = conversationStore.getSnapshot().activeConversationId;
    if (!conversationId) return;
    const threadRuntime = runtime.threads.getById(conversationId);
    const currentMessages = threadRuntime.getState().messages;
    const beforeMessageId = currentMessages[0]?.id;
    if (!conversationId || !beforeMessageId) return;

    const version = requestVersion.current;
    setIsLoadingEarlierMessages(true);
    setEarlierMessagesError(null);
    let httpStatus: number | null = null;
    let failureMessage = '更早的消息加载失败，请重试。';

    if (!hasDesktopBridge()) {
      failureMessage = '浏览器预览无法读取本地会话，请通过 TeachForge 桌面应用打开。';
      setEarlierMessagesError(failureMessage);
      setIsLoadingEarlierMessages(false);
      console.error('[TeachForge][conversation.history.earlier] desktop_bridge_unavailable');
      return;
    }

    try {
      const response = await window.teachforge.request<ConversationHistoryPage>({
        method: 'GET',
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages?beforeMessageId=${encodeURIComponent(beforeMessageId)}`,
      });
      httpStatus = response.status;
      if (response.status === 404) {
        await conversationStore.refresh();
        if (version !== requestVersion.current) return;
        failureMessage = '该会话已不存在，对话列表已刷新。';
        throw new Error(failureMessage);
      }
      if (response.status !== 200) {
        failureMessage = `更早的消息加载失败（HTTP ${response.status}），请重试。`;
        throw new Error(failureMessage);
      }
      if (!isConversationHistoryPage(response.data)) {
        failureMessage = '历史消息响应格式异常，请重试。';
        throw new Error(failureMessage);
      }
      if (version !== requestVersion.current) return;

      if (response.data.messages.length === 0) {
        setHasEarlierMessages(false);
        return;
      }

      restoreHistoryToolActivities(response.data.messages);
      restoreHistoryAttachments(response.data.messages);
      artifactHistoryStore.mergeFromHistory(response.data.messages);
      const latestMessages = threadRuntime.getState().messages;
      const latestMessageIds = new Set(latestMessages.map(({ id }) => id));
      const earlierThreadMessages = response.data.messages
        .map(toThreadMessage)
        .filter(({ id }) => !id || !latestMessageIds.has(id));
      if (earlierThreadMessages.length === 0) {
        setHasEarlierMessages(false);
        return;
      }

      const viewport = messageViewportRef.current;
      if (viewport) {
        pendingScrollAnchor.current = {
          scrollHeight: viewport.scrollHeight,
          scrollTop: viewport.scrollTop,
        };
      }
      threadRuntime.reset([...earlierThreadMessages, ...latestMessages]);
      setHasEarlierMessages(response.data.hasMore);
      setHistoryPageRevision((revision) => revision + 1);
    } catch (error) {
      if (version !== requestVersion.current) return;
      const bridgeUnavailable = !hasDesktopBridge();
      if (bridgeUnavailable) {
        failureMessage = '浏览器预览无法读取本地会话，请通过 TeachForge 桌面应用打开。';
      }
      console.error('[TeachForge][conversation.history.earlier] load_failed', {
        code: bridgeUnavailable ? 'desktop_bridge_unavailable' : 'history_request_failed',
        httpStatus,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      setEarlierMessagesError(failureMessage);
    } finally {
      if (version === requestVersion.current) {
        setIsLoadingEarlierMessages(false);
      }
    }
  }, [hasEarlierMessages, isLoadingEarlierMessages, isRunning, runtime]);

  /** Restores the first visible message after older rows are prepended. */
  useLayoutEffect(() => {
    const anchor = pendingScrollAnchor.current;
    const viewport = messageViewportRef.current;
    if (!anchor || !viewport) return;

    viewport.scrollTop =
      anchor.scrollTop + viewport.scrollHeight - anchor.scrollHeight;
    pendingScrollAnchor.current = null;
  }, [historyPageRevision]);

  /** Loads sidebar rows when the Agent page first mounts. */
  useEffect(() => {
    void conversationStore.refresh();
    const refreshAfterChange = () => void conversationStore.refresh();
    window.addEventListener('teachforge:conversation-summary-changed', refreshAfterChange);
    return () => window.removeEventListener('teachforge:conversation-summary-changed', refreshAfterChange);
  }, []);

  /** Restores the last selected thread only after the initial list is known. */
  useEffect(() => {
    if (
      conversationState.listStatus !== 'ready' ||
      restoredInitialConversation.current
    ) {
      return;
    }
    setHasLoadedInitialList(true);
    restoredInitialConversation.current = true;

    const savedConversationId = conversationState.activeConversationId;
    if (!savedConversationId) {
      // `reset()` emits assistant-ui's initialize event even for an empty repository. On a remote
      // draft that event calls the adapter's `initialize()` and would persist a Conversation before
      // the teacher sends anything. The seeded draft is already empty, so leave it untouched.
      setHasEarlierMessages(false);
      return;
    }
    if (!conversationState.conversations.some(({ id }) => id === savedConversationId)) {
      conversationStore.setActiveConversationId(null);
      // See the empty-draft note above: clearing a stale selection must not materialize it remotely.
      setHasEarlierMessages(false);
      return;
    }

    void loadConversation(savedConversationId);
  }, [conversationState, loadConversation, runtime]);

  /** Clears the active thread so the next prompt creates a new Conversation. */
  const startNewConversation = useCallback(() => {
    void runtime.threads.switchToNewThread();
    requestVersion.current += 1;
    setLoadingConversationId(null);
    setIsLoadingEarlierMessages(false);
    setHasEarlierMessages(false);
    setEarlierMessagesError(null);
    setHistoryError(null);
    setHistoryErrorConversationId(null);
    conversationStore.setActiveConversationId(null);
    composerCommandStore.reset();
    composerAttachmentStore.reset();
    sentAttachmentStore.reset();
    artifactHistoryStore.clear();
    artifactTabsStore.reset();
    agentEventBus.clearArtifacts();
  }, [isRunning, runtime]);

  /**
   * Deletes one conversation and clears the thread when it was the one on screen.
   *
   * The backend removes rows and the conversation's local session files, so nothing is left behind;
   * the renderer only resets the view and the composer state.
   */
  const deleteConversation = useCallback(
    async (conversationId: string) => {
      const wasActive =
        conversationStore.getSnapshot().activeConversationId === conversationId;
      setHistoryError(null);
      setHistoryErrorConversationId(null);
      try {
        await runtime.threads.getItemById(conversationId).delete();
        await conversationStore.refresh();
      } catch (error) {
        setHistoryError(describeFailure(error, '删除会话失败，请重试。'));
        return;
      }
      if (!wasActive) return;

      requestVersion.current += 1;
      setLoadingConversationId(null);
      setIsLoadingEarlierMessages(false);
      setHasEarlierMessages(false);
      setEarlierMessagesError(null);
      composerCommandStore.reset();
      composerAttachmentStore.reset();
      sentAttachmentStore.reset();
    },
    [runtime],
  );

  /**
   * Renames one conversation; the sidebar dialog owns the optimistic/error presentation.
   *
   * The backend persists the title, so the sidebar and header pick it up on the refresh that
   * `conversationStore.renameConversation` performs.
   */
  const renameConversation = useCallback(async (conversationId: string, title: string) => {
    await conversationStore.renameConversation(conversationId, title);
  }, []);

  const isHistoryLoading = loadingConversationId !== null;
  /** Drills need a completed round, so the toggle and the view both follow that gate. */
  const canEnterRehearsal = hasCompletedRound;
  const isRehearsalMode = conversationDisplayMode === 'rehearsal' && canEnterRehearsal;
  const isInitialListLoading =
    !hasLoadedInitialList && conversationState.listStatus !== 'error';
  const activeConversation = conversationState.conversations.find(
    ({ id }) => id === conversationState.activeConversationId,
  );
  const activeConversationTitle = activeConversation?.title?.trim() || '新对话';
  /** Files of the conversation on screen; a list loaded for another one never shows a count. */
  const conversationFiles =
    artifactList.conversationId === conversationState.activeConversationId
      ? artifactList.files
      : [];
  const runningConversationIds = new Set(
    threadListState.threadIds.flatMap((threadId) => {
      const item = runtime.threads.getItemById(threadId).getState();
      return item.isRunning && item.remoteId ? [item.remoteId] : [];
    }),
  );

  /** Opens or closes the chat search box. */
  const handleChatSearchOpenChange = useCallback((open: boolean) => {
    setSearchSurface(open ? 'chat' : null);
  }, []);

  /** Opens or closes the artifact search box. */
  const handleFileSearchOpenChange = useCallback((open: boolean) => {
    setSearchSurface(open ? 'file' : null);
  }, []);

  /**
   * Routes Ctrl+F to the search box of the panel that owns focus.
   *
   * The desktop shell removes the application menu (`Menu.setApplicationMenu(null)`), so Electron
   * has no find bar and the shortcut is free; it is still consumed here so a dev-server browser tab
   * never opens its own find UI.
   */
  useEffect(() => {
    if (activeView !== 'chat' || isRehearsalMode) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const ownsFiles =
        target !== null && target.closest('[data-search-surface="file"]') !== null;
      setSearchSurface(ownsFiles && artifactTabs.visible ? 'file' : 'chat');
      setSearchFocusSeq((sequence) => sequence + 1);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeView, artifactTabs.visible, isRehearsalMode]);

  // Leaving the conversation view or entering rehearsal hides the surface being searched.
  useEffect(() => {
    setSearchSurface(null);
  }, [activeView, classroomStage, isRehearsalMode]);

  // A hidden artifact panel cannot host a running search.
  useEffect(() => {
    if (artifactTabs.visible) return;
    setSearchSurface((current) => (current === 'file' ? null : current));
  }, [artifactTabs.visible]);

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden md:flex-row">
      {activeView === 'classroom' && classroomStage ? (
        // The stage owns the whole window so its 16:9 artwork matches the locked window ratio;
        // leaving goes through the stage's own exit control instead of the hidden sidebar.
        <ClassroomMode
          lessonId={classroomStage.lessonId}
          onEnded={(lessonId) => {
            setClassroomStage(null);
            // The summary is post-class work; the home page polls while this runs.
            setClassroomSummaryLessonId(lessonId);
            void generateLessonSummary(lessonId)
              .catch(() => undefined)
              .finally(() => setClassroomSummaryLessonId(null));
          }}
          onExit={() => setClassroomStage(null)}
        />
      ) : (
        <>
          <ConversationSidebar
            isBusy={false}
            runningConversationIds={runningConversationIds}
            activeView={activeView}
            loadingConversationId={loadingConversationId}
            onNewConversation={() => {
              setActiveView('chat');
              setConversationDisplayMode('conversation');
              startNewConversation();
            }}
            onRefresh={() => void conversationStore.refresh()}
            onSelect={(conversationId) => {
              setActiveView('chat');
              setConversationDisplayMode('conversation');
              void loadConversation(conversationId);
            }}
            onDelete={(conversationId) => void deleteConversation(conversationId)}
            onRename={renameConversation}
            onSelectView={(view) =>
              setActiveView((current) => (current === view ? 'chat' : view))
            }
            state={conversationState}
          />

          {activeView === 'settings' ? (
            <SettingsPage />
          ) : activeView === 'knowledge' ? (
            <KnowledgeBasePage />
          ) : activeView === 'knowledgeProfile' ? (
            <KnowledgeProfilePage
              conversations={conversationState.conversations}
              onSelectConversation={(conversationId) => {
                setActiveView('chat');
                setConversationDisplayMode('conversation');
                void loadConversation(conversationId);
              }}
            />
          ) : activeView === 'classroom' ? (
            <ClassroomHome
              onEnterStage={(lessonId) =>
                setClassroomStage({ lessonId: lessonId ?? null })
              }
              summaryRunning={classroomSummaryLessonId !== null}
            />
          ) : (
            // Positioned so the artifact panel can float over the chat when the window is too narrow.
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <PageHeader className="justify-between">
                  <h1
                    aria-label={activeConversationTitle}
                    className="min-w-0 max-w-[32rem] flex-1 truncate whitespace-nowrap text-xl font-semibold tracking-tight text-ink-900"
                    title={activeConversationTitle}
                  >
                    {truncateConversationTitle(activeConversationTitle)}
                  </h1>
                  <div className="flex shrink-0 items-center gap-2">
                    {!isRehearsalMode && (
                      <>
                        <KeywordSearch
                          containerRef={messageViewportRef}
                          focusSeq={searchFocusSeq}
                          isOpen={searchSurface === 'chat'}
                          label="搜索消息"
                          onOpenChange={handleChatSearchOpenChange}
                        />
                        <ArtifactEntry
                          count={conversationFiles.length}
                          visible={artifactTabs.visible}
                        />
                      </>
                    )}
                    <div
                      aria-label="会话模式"
                      className="inline-flex h-10 shrink-0 items-center rounded-full border border-ink-200/80 bg-white/70 p-1 shadow-sm backdrop-blur"
                      role="group"
                    >
                      <button
                        aria-pressed={!isRehearsalMode}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors duration-200 motion-reduce:transition-none ${
                          isRehearsalMode
                            ? 'font-medium text-ink-500 hover:text-ink-800'
                            : 'bg-brand-700 font-semibold text-white shadow-sm'
                        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1`}
                        onClick={() => setConversationDisplayMode('conversation')}
                        type="button"
                      >
                        <Chats aria-hidden="true" className="h-4 w-4" />
                        对话模式
                      </button>
                      {/* A disabled button receives no pointer events, so the reason lives on the
                          wrapper: hovering the greyed tab still explains why it is unavailable. */}
                      <span
                        className="inline-flex"
                        title={canEnterRehearsal ? undefined : REHEARSAL_REQUIRES_ROUND_HINT}
                      >
                        <button
                          aria-pressed={isRehearsalMode}
                          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors duration-200 motion-reduce:transition-none ${
                            isRehearsalMode
                              ? 'bg-brand-700 font-semibold text-white shadow-sm'
                              : canEnterRehearsal
                                ? 'font-medium text-ink-500 hover:text-ink-800'
                                : 'font-medium text-ink-300'
                          } disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1`}
                          disabled={!canEnterRehearsal}
                          onClick={() => setConversationDisplayMode('rehearsal')}
                          type="button"
                        >
                          <GraduationCap aria-hidden="true" className="h-4 w-4" />
                          演练模式
                        </button>
                      </span>
                    </div>
                  </div>
                </PageHeader>

                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <div
                    aria-hidden={isRehearsalMode}
                    className={`absolute inset-0 flex min-h-0 flex-col px-4 py-4 transition-[opacity,transform] duration-300 ease-in-out motion-reduce:transition-none md:px-8 md:py-5 ${
                      isRehearsalMode
                        ? 'pointer-events-none translate-y-1 opacity-0'
                        : 'translate-y-0 opacity-100'
                    }`}
                    inert={isRehearsalMode}
                  >
                    {historyError && (
                      <div className="mb-3 flex shrink-0 items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                        <span className="min-w-0 flex-1">{historyError}</span>
                        {historyErrorConversationId && (
                          <button
                            className="shrink-0 font-medium underline underline-offset-2"
                            onClick={() => void loadConversation(historyErrorConversationId)}
                            type="button"
                          >
                            重试
                          </button>
                        )}
                      </div>
                    )}

                    {isHistoryLoading || isInitialListLoading ? (
                      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500" role="status">
                        {isInitialListLoading
                          ? conversationState.listStatus === 'error'
                            ? conversationState.listError ?? '会话列表加载失败，请在左侧重试。'
                            : '正在加载对话列表…'
                          : '正在加载历史消息…'}
                      </div>
                    ) : (
                      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ThreadPrimitive.Viewport
                    className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pt-3 pr-1"
                    ref={messageViewportRef}
                  >
                    {hasEarlierMessages && (
                      <div
                        className="flex shrink-0 flex-col items-center gap-2 py-2"
                        data-search-ignore
                      >
                        {earlierMessagesError && (
                          <div className="flex items-center gap-2 text-xs text-rose-700" role="alert">
                            <span>{earlierMessagesError}</span>
                            <button
                              className="font-medium underline underline-offset-2"
                              disabled={isLoadingEarlierMessages}
                              onClick={() => void loadEarlierMessages()}
                              type="button"
                            >
                              重试
                            </button>
                          </div>
                        )}
                        <button
                          className="rounded-full border border-ink-300 bg-white px-4 py-2 text-sm font-medium text-ink-600 transition hover:border-ink-400 hover:text-ink-900 disabled:cursor-wait disabled:opacity-50"
                          disabled={isLoadingEarlierMessages || isRunning}
                          onClick={() => void loadEarlierMessages()}
                          type="button"
                        >
                          {isLoadingEarlierMessages ? '正在加载更早的消息…' : '查看更早的消息'}
                        </button>
                      </div>
                    )}

                    <AuiIf condition={(state) => state.thread.isEmpty}>
                      <EmptyState
                        className="my-auto"
                        description="先聊清楚你想讲的内容，再去演练模式接受学生的提问。"
                        hint="例如：帮我用一个生活中的例子解释缓存雪崩"
                        icon={Sparkle}
                        title="从一个备课问题开始"
                      />
                    </AuiIf>

                    <ThreadPrimitive.Messages>
                      {({ message }) => {
                        if (message.role === 'user') {
                          return (
                            <div className="space-y-4" key={message.id}>
                              <UserMessage messageId={message.id} />
                              <AgentActivity activity={activity[message.id]} />
                            </div>
                          );
                        }

                        return <AssistantMessage key={message.id} messageId={message.id} />;
                      }}
                    </ThreadPrimitive.Messages>
                    <TurnProgress activity={liveActivity} />
                    <LiveArtifactFooter files={liveActivity.artifacts} />
                  </ThreadPrimitive.Viewport>

                  <div className="mt-2 shrink-0 pb-1 pt-3">
                    <ComposerPrimitive.Root className="relative rounded-3xl border border-ink-200 bg-white p-3 transition-colors duration-200 ease-out focus-within:border-brand-500 motion-reduce:transition-none">
                      <SlashCommandMenu menu={slashMenu} />
                      <ComposerAttachmentChips />
                      {composerCommand && (
                        <div className="mb-2 flex items-center">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 py-0.5 pl-2 pr-1 text-xs font-medium text-brand-800">
                            {composerCommandItem?.icon === 'research' ? (
                              <MagnifyingGlass className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <Database className="h-3.5 w-3.5" aria-hidden />
                            )}
                            {composerCommandItem?.label ?? composerCommand}
                            <button
                              aria-label={`移除${composerCommandItem?.label ?? '命令'}`}
                              className="rounded-full p-0.5 text-brand-600 transition hover:bg-brand-100"
                              onClick={() => composerCommandStore.reset()}
                              type="button"
                            >
                              <X className="h-3 w-3" aria-hidden />
                            </button>
                          </span>
                        </div>
                      )}
                      <ComposerPrimitive.Input
                        aria-label="发送给备课助手"
                        className="h-24 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400 tf-scrollbar"
                        disabled={isLoadingEarlierMessages}
                        onKeyDown={slashMenu.handleKeyDown}
                        placeholder="写下你正在准备的内容或问题…输入 / 可查询资料库或发起探索主题"
                        ref={composerInputRef}
                        // A plain textarea instead of the primitive's auto-growing one: the box
                        // keeps a fixed height and scrolls internally once the message is long.
                        render={<textarea />}
                        submitMode="ctrlEnter"
                      />
                      <div className="mt-2 flex items-center justify-between border-t border-ink-100 pt-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <AttachmentPickerButton disabled={isLoadingEarlierMessages} />
                          <span className="text-xs text-ink-500">Ctrl + Enter 发送</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <AuiIf condition={(state) => state.thread.isRunning}>
                            <ComposerPrimitive.Cancel className="rounded-xl border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-50">
                              停止生成
                            </ComposerPrimitive.Cancel>
                          </AuiIf>
                          <AuiIf condition={(state) => !state.thread.isRunning}>
                            <ComposerPrimitive.Send
                              className="rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={isLoadingEarlierMessages}
                            >
                              发送
                            </ComposerPrimitive.Send>
                          </AuiIf>
                        </div>
                      </div>
                    </ComposerPrimitive.Root>
                  </div>
                      </ThreadPrimitive.Root>
                    )}
                  </div>
                  <div
                    aria-hidden={!isRehearsalMode}
                    className={`absolute inset-0 z-10 flex min-h-0 flex-col px-4 py-4 transition-[opacity,transform] duration-300 ease-in-out motion-reduce:transition-none md:px-8 md:py-5 ${
                      isRehearsalMode
                        ? 'translate-y-0 opacity-100'
                        : 'pointer-events-none translate-y-1 opacity-0'
                    }`}
                    inert={!isRehearsalMode}
                  >
                    <RehearsalMode
                      conversationId={conversationState.activeConversationId}
                      hasHistory={hasCompletedRound}
                    />
                  </div>
                </div>
              </div>
              {!isRehearsalMode && (
                <ArtifactSidebar
                  focusSeq={searchFocusSeq}
                  isSearchOpen={searchSurface === 'file'}
                  onSearchOpenChange={handleFileSearchOpenChange}
                />
              )}
            </div>
          )}
        </>
      )}
      <ToastHost />
    </section>
  );
}

/** Validates the stable response envelope used by the history paging API. */
function isConversationHistoryPage(
  value: unknown,
): value is ConversationHistoryPage {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const page = value as Partial<ConversationHistoryPage>;
  return (
    Array.isArray(page.messages) &&
    page.messages.every(isConversationHistoryMessage) &&
    typeof page.hasMore === 'boolean'
  );
}

/** Validates one visible history item before passing it to LocalRuntime. */
function isConversationHistoryMessage(
  value: unknown,
): value is ConversationHistoryMessage {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const message = value as Partial<ConversationHistoryMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    (message.status === 'completed' ||
      message.status === 'failed' ||
      message.status === 'cancelled') &&
    typeof message.createdAt === 'string' &&
    (message.toolActivities === undefined ||
      (Array.isArray(message.toolActivities) &&
        message.toolActivities.every(isConversationToolActivity))) &&
    (message.attachments === undefined ||
      (Array.isArray(message.attachments) &&
        message.attachments.every(isConversationAttachment)))
  );
}

/** Narrows one attached-file entry before it reaches the renderer. */
function isConversationAttachment(
  value: unknown,
): value is ConversationAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const attachment = value as Partial<ConversationAttachment>;
  return (
    typeof attachment.attachmentId === 'string' &&
    typeof attachment.name === 'string'
  );
}

/** Validates the safe tool fields before the activity state receives API data. */
function isConversationToolActivity(
  value: unknown,
): value is ConversationToolActivity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const activity = value as Partial<ConversationToolActivity>;
  return (
    typeof activity.toolCallId === 'string' &&
    typeof activity.toolName === 'string' &&
    (activity.path === undefined || typeof activity.path === 'string') &&
    (activity.pattern === undefined || typeof activity.pattern === 'string') &&
    (activity.status === 'completed' || activity.status === 'failed') &&
    (activity.durationMs === undefined ||
      (typeof activity.durationMs === 'number' &&
        Number.isFinite(activity.durationMs) &&
        activity.durationMs >= 0))
  );
}

/** Rebuilds history activities for persisted user IDs before the message list renders. */
function restoreHistoryToolActivities(messages: ConversationHistoryMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' || !message.toolActivities?.length) continue;
    // 历史 API 使用数据库 message ID，而实时活动可能使用另一 renderer ID，因此要按历史 ID 重建。
    agentEventBus.restoreHistoryActivity(message.id, message.toolActivities);
  }
}

/** Rebuilds attachment chips for persisted user messages before the thread renders. */
function restoreHistoryAttachments(messages: ConversationHistoryMessage[]): void {
  for (const message of messages) {
    if (message.role !== 'user' || !message.attachments?.length) continue;
    sentAttachmentStore.restoreHistory(message.id, message.attachments);
  }
}

/** Shows one request's elapsed time and safe tool summaries below its user message. */
function AgentActivity({
  activity,
}: {
  activity: ReturnType<typeof agentEventBus.getTurnSnapshots>[string] | undefined;
}) {
  // 历史活动已经是终态，挂载时直接收起；本轮运行中的活动保持展开。
  const [isExpanded, setIsExpanded] = useState(() => activity?.phase !== 'idle');
  const liveElapsedMs = useElapsedMs(
    activity?.startedAt ?? 0,
    activity !== undefined && activity.phase !== 'idle',
  );

  useEffect(() => {
    // 最终回复到达后收起工具明细，只留摘要行；用户随后手动展开不会被再次收起。
    if (activity?.phase === 'idle') setIsExpanded(false);
  }, [activity?.phase]);

  if (!activity || activity.tools.length === 0) return null;

  const isFinal = activity.phase === 'idle';
  const elapsedMs = isFinal ? activity.elapsedMs : liveElapsedMs;

  return (
    <div className="flex w-full justify-start">
      <details
        className="group w-full max-w-[96%]"
        open={isExpanded}
        onToggle={(event) => setIsExpanded(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg py-1.5 text-sm text-ink-600 outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30">
          <Stack aria-hidden="true" className="size-5 shrink-0 text-ink-600" weight="regular" />
          <span>{isFinal ? '已工作' : '正在工作'}</span>
          {elapsedMs !== null && (
            <time
              aria-live="off"
              className="tabular-nums"
              dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}
            >
              {formatDuration(elapsedMs)}
            </time>
          )}
          <CaretDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 transition-transform group-open:rotate-180"
            weight="bold"
          />
        </summary>
        <div className="ml-2 space-y-2 border-l-2 border-ink-300 py-1 pl-4">
          {activity.tools.map((tool) => (
            <ToolActivityRow key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * Fills the response area while a turn is still working and has streamed no text yet,
 * so a long model or document wait never leaves the thread blank.
 */
function TurnProgress({
  activity,
}: {
  activity: ReturnType<typeof agentEventBus.getSnapshot>;
}) {
  const isWaiting = activity.phase === 'working';
  const elapsedMs = useElapsedMs(activity.startedAt, isWaiting);
  if (!isWaiting) return null;

  return (
    <div className="flex w-full justify-start" data-search-ignore role="status">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2.5 text-sm text-ink-600">
          <CircleNotch
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-brand-600"
          />
          <span className="min-w-0 animate-pulse truncate">{describeTurnStatus(activity.tools)}</span>
          <time
            aria-live="off"
            className="shrink-0 tabular-nums text-ink-500"
            dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}
          >
            {formatDuration(elapsedMs)}
          </time>
        </div>
        {isLongWait(elapsedMs) && (
          <p className="pl-[1.625rem] text-xs leading-5 text-ink-500">
            长文档解析和长回答会更久一些，可以随时停止生成。
          </p>
        )}
      </div>
    </div>
  );
}

/** Tells the user the wait is expected rather than stuck once a turn exceeds a minute. */
function isLongWait(elapsedMs: number): boolean {
  return elapsedMs >= 60_000;
}

/** Summarises the live turn in one sentence: the newest running tool, or plain thinking. */
function describeTurnStatus(
  tools: ReturnType<typeof agentEventBus.getTurnSnapshots>[string]['tools'],
): string {
  const running = [...tools].reverse().find((tool) => tool.status === 'running');
  if (!running) return '正在思考…';

  const description = describeToolActivity(running.toolName, running.status, running.args);
  if (description.fileName) return `${description.action} ${description.fileName}`;
  if (description.pattern) return `${description.action}“${description.pattern}”`;
  return `${description.action}…`;
}

/** Ticks once a second while `isActive` so live durations stay current without a reload. */
function useElapsedMs(startedAt: number, isActive: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timerId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timerId);
  }, [isActive, startedAt]);

  return Math.max(0, now - startedAt);
}

/** Presents one tool action with plain-language wording, target and lifecycle status. */
function ToolActivityRow({
  tool,
}: {
  tool: ReturnType<typeof agentEventBus.getTurnSnapshots>[string]['tools'][number];
}) {
  const description = describeToolActivity(tool.toolName, tool.status, tool.args);

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-ink-200/65 px-3 py-2 text-sm text-ink-800">
      <ToolStatusIcon status={tool.status} />
      <span className="shrink-0">{description.action}</span>
      {description.pattern && (
        <code className="min-w-0 break-all font-mono text-[0.9em] text-ink-700">
          "{description.pattern}"
        </code>
      )}
      {description.fileName && (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-ink-300 bg-ink-100 px-2 py-0.5">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-600" />
          <code className="min-w-0 break-all font-mono text-[0.9em]">{description.fileName}</code>
        </span>
      )}
      <span className="sr-only">{getToolStatusLabel(tool.status)}</span>
    </div>
  );
}

/** Formats total request time with short units suited to the activity header. */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}

/** Gives every tool state both a distinct icon and a screen-reader label. */
function ToolStatusIcon({
  status,
}: {
  status: ReturnType<typeof agentEventBus.getTurnSnapshots>[string]['tools'][number]['status'];
}) {
  if (status === 'running') {
    return (
      <CircleNotch
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-ink-600"
      />
    );
  }

  if (status === 'completed') {
    return (
      <Check
        aria-hidden="true"
        className="size-4 shrink-0 text-brand-600"
        weight="bold"
      />
    );
  }

  if (status === 'failed') {
    return (
      <WarningCircle
        aria-hidden="true"
        className="size-4 shrink-0 text-rose-700"
        weight="fill"
      />
    );
  }

  return (
    <XCircle aria-hidden="true" className="size-4 shrink-0 text-ink-500" />
  );
}

/** Names the lifecycle status for non-color context in each tool row. */
function getToolStatusLabel(
  status: ReturnType<typeof agentEventBus.getTurnSnapshots>[string]['tools'][number]['status'],
): string {
  if (status === 'running') return '正在运行';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '执行失败';
  return '已取消';
}

/**
 * Displays the user's message with right-aligned emphasis, its attachment chips,
 * and a copy action that only appears while the message is hovered or focused.
 */
function UserMessage({ messageId }: { messageId: string }) {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="group flex w-fit max-w-[82%] flex-col items-end gap-1.5">
        <div className="max-w-full rounded-2xl rounded-br-md bg-ink-100 px-4 py-3 text-sm leading-6 text-ink-900">
          <UserAttachmentChips messageId={messageId} />
          <MessagePrimitive.Parts />
        </div>
        <div className="flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          <UserMessageCopyButton />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

/** Copies the user's message text and shows a check mark while the copy is fresh. */
function UserMessageCopyButton() {
  const isCopied = useAuiState((state) => state.message.isCopied);

  return (
    <ActionBarPrimitive.Copy
      aria-label={isCopied ? '已复制' : '复制消息'}
      className="rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 disabled:cursor-not-allowed disabled:opacity-40"
      title={isCopied ? '已复制' : '复制'}
    >
      {isCopied ? (
        <Check aria-hidden="true" className="size-4 text-brand-600" weight="bold" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-4" />
      )}
    </ActionBarPrimitive.Copy>
  );
}

/** Displays unboxed assistant Markdown, its generated files and accessible safe errors. */
function AssistantMessage({ messageId }: { messageId: string }) {
  const historyFiles = useSyncExternalStore(
    artifactHistoryStore.subscribe,
    artifactHistoryStore.getSnapshot,
    artifactHistoryStore.getSnapshot,
  )[messageId];

  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="min-w-0 w-full max-w-full text-[15px] leading-7 text-ink-800">
        <MessagePrimitive.Parts>
          {({ part }) =>
            part.type === 'text' ? <AssistantMarkdown /> : null
          }
        </MessagePrimitive.Parts>
        <MessagePrimitive.Error>
          <p className="mt-2 text-sm text-rose-700" role="alert">
            这次回答没有完成，请检查模型配置或网络后重试。
          </p>
        </MessagePrimitive.Error>
        {historyFiles && historyFiles.length > 0 && (
          <ArtifactFileChips files={historyFiles} />
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

/** Shows the files the live turn produced, under the response that just finished. */
function LiveArtifactFooter({
  files,
}: {
  files: NonNullable<
    ReturnType<typeof agentEventBus.getSnapshot>['artifacts']
  >;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex w-full justify-start" data-search-ignore>
      <div className="min-w-0 max-w-full">
        <ArtifactFileChips files={files} />
      </div>
    </div>
  );
}
