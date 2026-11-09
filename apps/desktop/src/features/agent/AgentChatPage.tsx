import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type AssistantRuntime,
} from '@assistant-ui/react';
import {
  CaretDown,
  Check,
  CircleNotch,
  Database,
  FileText,
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
import { ConversationSidebar, type SidebarView } from './ConversationSidebar';
import { SlashCommandMenu, useSlashCommandMenu } from './SlashCommandMenu';
import { composerCommandStore } from './composer-command-store';
import { toThreadMessage } from './conversation-history';
import { KnowledgeBasePage } from '../knowledge/KnowledgeBasePage';
import { SettingsPage } from '../settings/SettingsPage';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import {
  conversationStore,
  type ConversationHistoryPage,
  type ConversationHistoryMessage,
  type ConversationToolActivity,
} from './conversation-store';

/** Loads persisted conversation history into the long-lived Agent runtime. */
export function AgentChatPage({ runtime }: { runtime: AssistantRuntime }) {
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
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const [activeView, setActiveView] = useState<SidebarView>('chat');
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

  /** Fetches one history snapshot and replaces the visible local thread on success. */
  const loadConversation = useCallback(async (conversationId: string) => {
    if (isRunning) return;
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
      runtime.thread.reset(response.data.messages.map(toThreadMessage));
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
  }, [isRunning, runtime]);

  /** Loads and prepends the page immediately before the oldest visible message. */
  const loadEarlierMessages = useCallback(async () => {
    if (isRunning || isLoadingEarlierMessages || !hasEarlierMessages) return;
    const conversationId = conversationStore.getSnapshot().activeConversationId;
    const currentMessages = runtime.thread.getState().messages;
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
      const latestMessages = runtime.thread.getState().messages;
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
      runtime.thread.reset([...earlierThreadMessages, ...latestMessages]);
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
      runtime.thread.reset([]);
      setHasEarlierMessages(false);
      return;
    }
    if (!conversationState.conversations.some(({ id }) => id === savedConversationId)) {
      conversationStore.setActiveConversationId(null);
      runtime.thread.reset([]);
      setHasEarlierMessages(false);
      return;
    }

    void loadConversation(savedConversationId);
  }, [conversationState, loadConversation, runtime]);

  /** Clears the active thread so the next prompt creates a new Conversation. */
  const startNewConversation = useCallback(() => {
    if (isRunning) return;
    requestVersion.current += 1;
    setLoadingConversationId(null);
    setIsLoadingEarlierMessages(false);
    setHasEarlierMessages(false);
    setEarlierMessagesError(null);
    setHistoryError(null);
    setHistoryErrorConversationId(null);
    conversationStore.setActiveConversationId(null);
    composerCommandStore.reset();
    runtime.thread.reset([]);
  }, [isRunning, runtime]);

  const isHistoryLoading = loadingConversationId !== null;
  const isInitialListLoading =
    !hasLoadedInitialList && conversationState.listStatus !== 'error';

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden md:flex-row">
      <ConversationSidebar
        isBusy={isRunning || isHistoryLoading || isInitialListLoading}
        activeView={activeView}
        loadingConversationId={loadingConversationId}
        onNewConversation={() => {
          setActiveView('chat');
          startNewConversation();
        }}
        onRefresh={() => void conversationStore.refresh()}
        onSelect={(conversationId) => {
          setActiveView('chat');
          void loadConversation(conversationId);
        }}
        onSelectView={(view) =>
          setActiveView((current) => (current === view ? 'chat' : view))
        }
        state={conversationState}
      />

      {activeView === 'settings' ? (
        <SettingsPage />
      ) : activeView === 'knowledge' ? (
        <KnowledgeBasePage />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 md:px-8 md:py-5">
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
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-stone-500" role="status">
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
                  <div className="flex shrink-0 flex-col items-center gap-2 py-2">
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
                      className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition hover:border-stone-400 hover:text-stone-900 disabled:cursor-wait disabled:opacity-50"
                      disabled={isLoadingEarlierMessages || isRunning}
                      onClick={() => void loadEarlierMessages()}
                      type="button"
                    >
                      {isLoadingEarlierMessages ? '正在加载更早的消息…' : '查看更早的消息'}
                    </button>
                  </div>
                )}

                <AuiIf condition={(state) => state.thread.isEmpty}>
                  <div className="my-auto rounded-2xl border border-dashed border-stone-300 bg-white/70 px-6 py-10 text-center">
                    <p className="text-sm font-medium text-stone-800">从一个备课问题开始</p>
                    <p className="mt-2 text-sm leading-6 text-stone-500">
                      例如：帮我用一个生活中的例子解释缓存雪崩。
                    </p>
                  </div>
                </AuiIf>

                <ThreadPrimitive.Messages>
                  {({ message }) => {
                    if (message.role === 'user') {
                      return (
                        <div className="space-y-4" key={message.id}>
                          <UserMessage />
                          <AgentActivity activity={activity[message.id]} />
                        </div>
                      );
                    }

                    return <AssistantMessage key={message.id} />;
                  }}
                </ThreadPrimitive.Messages>
              </ThreadPrimitive.Viewport>

              <div className="mt-2 shrink-0 border-t border-stone-200 bg-white pt-3">
                <ComposerPrimitive.Root className="relative rounded-2xl border border-stone-300 bg-white p-3 focus-within:border-emerald-800 focus-within:ring-2 focus-within:ring-emerald-800/10">
                  <SlashCommandMenu menu={slashMenu} />
                  {composerCommand && (
                    <div className="mb-2 flex items-center">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 py-0.5 pl-2 pr-1 text-xs font-medium text-emerald-900">
                        <Database className="h-3.5 w-3.5" aria-hidden />
                        查询资料库
                        <button
                          aria-label="移除资料库查询"
                          className="rounded-full p-0.5 text-emerald-700 transition hover:bg-emerald-100"
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
                    className="min-h-24 w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 text-stone-900 outline-none placeholder:text-stone-400"
                    disabled={isLoadingEarlierMessages}
                    onKeyDown={slashMenu.handleKeyDown}
                    placeholder="写下你正在准备的内容或问题…输入 / 可查询本地上传的资料库"
                    ref={composerInputRef}
                    rows={3}
                    submitMode="ctrlEnter"
                  />
                  <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2">
                    <span className="text-xs text-stone-500">Ctrl + Enter 发送</span>
                    <div className="flex items-center gap-2">
                      <AuiIf condition={(state) => state.thread.isRunning}>
                        <ComposerPrimitive.Cancel className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-50">
                          停止生成
                        </ComposerPrimitive.Cancel>
                      </AuiIf>
                      <AuiIf condition={(state) => !state.thread.isRunning}>
                        <ComposerPrimitive.Send
                          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
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
      )}
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
        message.toolActivities.every(isConversationToolActivity)))
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

/** Shows one request's elapsed time and safe tool summaries below its user message. */
function AgentActivity({
  activity,
}: {
  activity: ReturnType<typeof agentEventBus.getTurnSnapshots>[string] | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (!activity || activity.phase === 'idle') return;

    const timerId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timerId);
  }, [activity?.phase, activity?.startedAt]);

  if (!activity || activity.tools.length === 0) return null;

  const isFinal = activity.phase === 'idle';
  const elapsedMs = isFinal
    ? activity.elapsedMs
    : Math.max(0, now - activity.startedAt);

  return (
    <div className="flex w-full justify-start">
      <details
        className="group w-full max-w-[96%]"
        open={isExpanded}
        onToggle={(event) => setIsExpanded(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg py-1.5 text-sm text-stone-600 outline-none focus-visible:ring-2 focus-visible:ring-emerald-800/30">
          <Stack aria-hidden="true" className="size-5 shrink-0 text-stone-600" weight="regular" />
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
        <div className="ml-2 space-y-2 border-l-2 border-stone-300 py-1 pl-4">
          {activity.tools.map((tool) => (
            <ToolActivityRow key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      </details>
    </div>
  );
}

/** Presents one tool action with a safe path chip and an accessible lifecycle status. */
function ToolActivityRow({
  tool,
}: {
  tool: ReturnType<typeof agentEventBus.getTurnSnapshots>[string]['tools'][number];
}) {
  const filePath = getToolPath(tool.args);

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-stone-200/65 px-3 py-2 text-sm text-stone-800">
      <ToolStatusIcon status={tool.status} />
      <span className="shrink-0">{getToolAction(tool.toolName)}</span>
      {filePath && (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-stone-300 bg-stone-100 px-2 py-0.5">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-stone-600" />
          <code className="min-w-0 break-all font-mono text-[0.9em]">{filePath}</code>
        </span>
      )}
      <span className="sr-only">{getToolStatusLabel(tool.status)}</span>
    </div>
  );
}

/** Maps known file tools to concise Chinese action labels. */
function getToolAction(toolName: string): string {
  if (toolName === 'read') return '读取';
  if (toolName === 'write') return '写入';
  if (toolName === 'edit') return '编辑';
  return `调用 ${toolName}`;
}

/** Returns only a string path and never exposes any other tool argument. */
function getToolPath(args: unknown): string {
  return typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args) &&
    'path' in args &&
    typeof args.path === 'string'
    ? args.path
    : '';
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
        className="size-4 shrink-0 animate-spin text-stone-600"
      />
    );
  }

  if (status === 'completed') {
    return (
      <Check
        aria-hidden="true"
        className="size-4 shrink-0 text-emerald-700"
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
    <XCircle aria-hidden="true" className="size-4 shrink-0 text-stone-500" />
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

/** Displays the user's message with right-aligned emphasis. */
function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[82%] rounded-2xl rounded-br-md bg-stone-100 px-4 py-3 text-sm leading-6 text-stone-900">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

/** Displays unboxed assistant Markdown and accessible safe errors. */
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="min-w-0 max-w-full text-[15px] leading-7 text-stone-800">
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
      </div>
    </MessagePrimitive.Root>
  );
}
