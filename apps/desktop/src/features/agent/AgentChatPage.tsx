import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type AssistantRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  CaretDown,
  Check,
  CircleNotch,
  FileText,
  Stack,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { agentEventBus } from './agent-event-bus';
import { AssistantMarkdown } from './AssistantMarkdown';
import { ConversationSidebar } from './ConversationSidebar';
import {
  conversationStore,
  type ConversationHistoryMessage,
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
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyErrorConversationId, setHistoryErrorConversationId] = useState<string | null>(null);
  const [hasLoadedInitialList, setHasLoadedInitialList] = useState(false);
  const requestVersion = useRef(0);
  const restoredInitialConversation = useRef(false);

  /** Fetches one history snapshot and replaces the visible local thread on success. */
  const loadConversation = useCallback(async (conversationId: string) => {
    if (isRunning) return;
    const version = ++requestVersion.current;
    setLoadingConversationId(conversationId);
    setHistoryError(null);
    setHistoryErrorConversationId(null);

    try {
      const response = await window.teachforge.request<ConversationHistoryMessage[]>({
        method: 'GET',
        path: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      });
      if (response.status !== 200 || !Array.isArray(response.data)) {
        throw new Error('历史消息加载失败。');
      }
      if (version !== requestVersion.current) return;

      runtime.thread.reset(response.data.map(toThreadMessage));
      conversationStore.setActiveConversationId(conversationId);
    } catch {
      if (version !== requestVersion.current) return;
      setHistoryError('历史消息加载失败，请重试。');
      setHistoryErrorConversationId(conversationId);
    } finally {
      if (version === requestVersion.current) setLoadingConversationId(null);
    }
  }, [isRunning, runtime]);

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
      return;
    }
    if (!conversationState.conversations.some(({ id }) => id === savedConversationId)) {
      conversationStore.setActiveConversationId(null);
      runtime.thread.reset([]);
      return;
    }

    void loadConversation(savedConversationId);
  }, [conversationState, loadConversation, runtime]);

  /** Clears the active thread so the next prompt creates a new Conversation. */
  const startNewConversation = useCallback(() => {
    if (isRunning) return;
    requestVersion.current += 1;
    setLoadingConversationId(null);
    setHistoryError(null);
    setHistoryErrorConversationId(null);
    conversationStore.setActiveConversationId(null);
    runtime.thread.reset([]);
  }, [isRunning, runtime]);

  const isHistoryLoading = loadingConversationId !== null;
  const isInitialListLoading = !hasLoadedInitialList;

  return (
    <section className="flex h-full w-full flex-col md:flex-row">
      <ConversationSidebar
        isBusy={isRunning || isHistoryLoading || isInitialListLoading}
        loadingConversationId={loadingConversationId}
        onNewConversation={startNewConversation}
        onRefresh={() => void conversationStore.refresh()}
        onSelect={(conversationId) => void loadConversation(conversationId)}
        state={conversationState}
      />

      <div className="mx-auto flex min-h-0 w-full max-w-none flex-1 flex-col px-5 py-5 md:px-8">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-stone-200 pb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-900">备课助手</h1>
            <p className="mt-1 text-sm text-stone-500">对话上下文保存在本机，重启后可继续提问。</p>
          </div>
        </header>

        {historyError && (
          <div className="mb-3 flex items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
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
                ? '会话列表加载失败，请在左侧重试。'
                : '正在加载对话列表…'
              : '正在加载历史消息…'}
          </div>
        ) : (
          <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3">
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

              <ThreadPrimitive.ViewportFooter className="sticky bottom-0 pt-3">
                <ComposerPrimitive.Root className="rounded-2xl border border-stone-300 bg-white p-3 focus-within:border-emerald-800 focus-within:ring-2 focus-within:ring-emerald-800/10">
                  <ComposerPrimitive.Input
                    aria-label="发送给备课助手"
                    className="min-h-24 w-full resize-y bg-transparent px-1 py-1 text-sm leading-6 text-stone-900 outline-none placeholder:text-stone-400"
                    placeholder="写下你正在准备的内容或问题…"
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
                        <ComposerPrimitive.Send className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40">
                          发送
                        </ComposerPrimitive.Send>
                      </AuiIf>
                    </div>
                  </div>
                </ComposerPrimitive.Root>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        )}
      </div>
    </section>
  );
}

/** Converts one text-only history DTO into the public assistant-ui reset shape. */
function toThreadMessage(message: ConversationHistoryMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.content }],
    createdAt: new Date(message.createdAt),
    status:
      message.status === 'completed'
        ? { type: 'complete', reason: 'stop' }
        : {
            type: 'incomplete',
            reason: message.status === 'cancelled' ? 'cancelled' : 'error',
          },
  };
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
          <time
            aria-live="off"
            className="tabular-nums"
            dateTime={`PT${Math.floor(elapsedMs / 1000)}S`}
          >
            {formatDuration(elapsedMs)}
          </time>
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
