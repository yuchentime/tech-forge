import type { ChatStreamEvent } from '../../types/chat-stream-event';
import type { ConversationToolActivity } from './conversation-store';
import type { GeneratedFileRef } from './artifact-store';

export type AgentToolActivity = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
};

export type AgentActivitySnapshot = {
  turnId: string;
  requestId: string | null;
  phase: 'idle' | 'working' | 'responding';
  tools: AgentToolActivity[];
  /** Files this turn produced or rewrote, in backend order. */
  artifacts: GeneratedFileRef[];
  startedAt: number;
  elapsedMs: number | null;
};

/** Keeps one immutable activity snapshot per user message during this app run. */
export type AgentActivityState = Readonly<Record<string, AgentActivitySnapshot>>;

/** 将当前运行的安全 Pi 事件发布给 React 活动状态订阅者。 */
export class AgentEventBus {
  private readonly listeners = new Set<() => void>();
  private readonly activeByRequest = new Map<string, string>();
  /** Associates a live request with its stable local thread, not its mutable selected view. */
  private readonly threadByRequest = new Map<string, string>();
  /** Allows the visible thread to select only its own live progress record. */
  private readonly activeRequestByThread = new Map<string, string>();
  private lastTurnId: string | null = null;
  private snapshot: AgentActivityState = {};

  /** 订阅活动状态快照，并返回取消订阅函数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the latest activity snapshot for existing single-run consumers. */
  getSnapshot = (): AgentActivitySnapshot => {
    const turnId = [...this.activeByRequest.values()].at(-1) ?? this.lastTurnId;
    return turnId ? this.snapshot[turnId] : EMPTY_ACTIVITY_SNAPSHOT;
  };

  /** Returns live progress for one local thread without leaking another thread's activity. */
  getSnapshotForThread = (localThreadId: string): AgentActivitySnapshot => {
    const requestId = this.activeRequestByThread.get(localThreadId);
    const turnId = requestId ? this.activeByRequest.get(requestId) : undefined;
    return turnId ? this.snapshot[turnId] ?? EMPTY_ACTIVITY_SNAPSHOT : EMPTY_ACTIVITY_SNAPSHOT;
  };

  /** Returns the immutable per-turn map consumed by the message list. */
  getTurnSnapshots = (): AgentActivityState => this.snapshot;

  /** Restores durable tool summaries under their persisted user message IDs. */
  restoreHistoryActivity(
    turnId: string,
    activities: readonly ConversationToolActivity[],
  ): void {
    // ToolActivityRow 从 args.path / args.pattern 读取目标，因此历史 DTO 只映射回这两项参数。
    const tools: AgentToolActivity[] = activities.map((activity) => ({
      toolCallId: activity.toolCallId,
      toolName: activity.toolName,
      args: {
        ...(activity.path === undefined ? {} : { path: activity.path }),
        ...(activity.pattern === undefined ? {} : { pattern: activity.pattern }),
      },
      status: activity.status,
      ...(activity.durationMs === undefined
        ? {}
        : { durationMs: activity.durationMs }),
    }));
    if (this.activeByRequest.size === 0) this.lastTurnId = turnId;
    // 整轮耗时未持久化；null 让历史活动隐藏运行时计时而不伪造时间。
    this.updateTurnSnapshot({
      turnId,
      requestId: null,
      phase: 'idle',
      tools,
      artifacts: [],
      startedAt: 0,
      elapsedMs: null,
    });
  }

  /** Starts one activity record, optionally tied to its initiating user message. */
  begin(turnIdOrRequestId: string, requestId?: string, localThreadId?: string): void {
    const turnId = turnIdOrRequestId;
    const runRequestId = requestId ?? turnIdOrRequestId;
    const startedAt = Date.now();
    this.activeByRequest.set(runRequestId, turnId);
    if (localThreadId) {
      this.threadByRequest.set(runRequestId, localThreadId);
      this.activeRequestByThread.set(localThreadId, runRequestId);
    }
    this.lastTurnId = turnId;
    this.updateTurnSnapshot({
      turnId,
      requestId: runRequestId,
      phase: 'working',
      tools: [],
      artifacts: [],
      startedAt,
      elapsedMs: 0,
    });
  }

  /** Applies only events from the active request and preserves older turn records. */
  publish(requestId: string, event: ChatStreamEvent): void {
    const activity = this.getActiveSnapshot(requestId);
    if (!activity) return;

    switch (event.type) {
      case 'tool_execution_start':
        this.updateActiveSnapshot(requestId, {
          ...activity,
          phase: 'working',
          tools: [
            ...activity.tools.filter(
              (tool) => tool.toolCallId !== event.toolCallId,
            ),
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              status: 'running',
            },
          ],
        });
        return;
      case 'tool_execution_end': {
        const toolIndex = activity.tools.findIndex(
          (tool) => tool.toolCallId === event.toolCallId,
        );
        if (toolIndex < 0) return;

        const tools = [...activity.tools];
        tools[toolIndex] = {
          ...tools[toolIndex],
          toolName: event.toolName,
          status: event.isError ? 'failed' : 'completed',
          ...(event.durationMs === undefined
            ? {}
            : { durationMs: event.durationMs }),
        };
        this.updateActiveSnapshot(requestId, {
          ...activity,
          phase: 'working',
          tools,
        });
        return;
      }
      case 'artifact': {
        const artifacts = [
          ...activity.artifacts.filter((file) => file.id !== event.artifact.id),
          {
            id: event.artifact.id,
            fileName: event.artifact.fileName,
            contentFormat: event.artifact.contentFormat,
            missing: event.artifact.missing,
            external: event.artifact.external,
          },
        ];
        // The artifact event arrives after the run settled; it must not reopen the phase.
        this.updateActiveSnapshot(requestId, { ...activity, artifacts });
        return;
      }
      case 'message_update':
        if (activity.phase === 'responding') return;
        this.updateActiveSnapshot(requestId, {
          ...activity,
          phase: 'responding',
        });
        return;
      case 'done':
      case 'error':
        this.clear(requestId);
        return;
      default:
        this.updateActiveSnapshot(requestId, {
          ...activity,
          phase: 'working',
        });
    }
  }

  /** Drops the live artifact list so a reloaded conversation does not duplicate the history footer. */
  clearArtifacts(): void {
    const turnId = [...this.activeByRequest.values()].at(-1) ?? this.lastTurnId;
    if (!turnId) return;
    const snapshot = this.snapshot[turnId];
    if (!snapshot || snapshot.artifacts.length === 0) return;
    this.updateTurnSnapshot({ ...snapshot, artifacts: [] });
  }

  /** Ends one matching request, freezes elapsed time, and retains its final tools. */
  clear(requestId: string): void {
    const activity = this.getActiveSnapshot(requestId);
    if (!activity) return;

    const localThreadId = this.threadByRequest.get(requestId);
    this.activeByRequest.delete(requestId);
    this.threadByRequest.delete(requestId);
    if (localThreadId && this.activeRequestByThread.get(localThreadId) === requestId) {
      this.activeRequestByThread.delete(localThreadId);
    }
    this.lastTurnId = activity.turnId;
    this.updateTurnSnapshot({
      ...activity,
      requestId: null,
      phase: 'idle',
      elapsedMs: Math.max(0, Date.now() - activity.startedAt),
      tools: activity.tools.map((tool) =>
        tool.status === 'running' ? { ...tool, status: 'cancelled' } : tool,
      ),
    });
  }

  /** Finds the current snapshot only when the request id still owns the active slot. */
  private getActiveSnapshot(requestId: string): AgentActivitySnapshot | null {
    const turnId = this.activeByRequest.get(requestId);
    return turnId ? this.snapshot[turnId] ?? null : null;
  }

  /** Replaces a live turn snapshot only while its request still owns the active slot. */
  private updateActiveSnapshot(
    requestId: string,
    activity: AgentActivitySnapshot,
  ): void {
    if (this.activeByRequest.get(requestId) !== activity.turnId) {
      return;
    }
    this.updateTurnSnapshot(activity);
  }

  /** Replaces one turn in the immutable state map and notifies subscribers. */
  private updateTurnSnapshot(activity: AgentActivitySnapshot): void {
    this.snapshot = { ...this.snapshot, [activity.turnId]: activity };
    for (const listener of this.listeners) listener();
  }
}

const EMPTY_ACTIVITY_SNAPSHOT: AgentActivitySnapshot = {
  turnId: '',
  requestId: null,
  phase: 'idle',
  tools: [],
  artifacts: [],
  startedAt: 0,
  elapsedMs: 0,
};

/** 向常驻 Agent 页面提供当前运行的事件状态。 */
export const agentEventBus = new AgentEventBus();
