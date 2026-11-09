import type { ChatStreamEvent } from '../../types/chat-stream-event';
import type { ConversationToolActivity } from './conversation-store';

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
  startedAt: number;
  elapsedMs: number | null;
};

/** Keeps one immutable activity snapshot per user message during this app run. */
export type AgentActivityState = Readonly<Record<string, AgentActivitySnapshot>>;

/** 将当前运行的安全 Pi 事件发布给 React 活动状态订阅者。 */
export class AgentEventBus {
  private readonly listeners = new Set<() => void>();
  private activeRequestId: string | null = null;
  private activeTurnId: string | null = null;
  private lastTurnId: string | null = null;
  private snapshot: AgentActivityState = {};

  /** 订阅活动状态快照，并返回取消订阅函数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the latest activity snapshot for existing single-run consumers. */
  getSnapshot = (): AgentActivitySnapshot => {
    const turnId = this.activeTurnId ?? this.lastTurnId;
    return turnId ? this.snapshot[turnId] : EMPTY_ACTIVITY_SNAPSHOT;
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
    if (!this.activeRequestId) this.lastTurnId = turnId;
    // 整轮耗时未持久化；null 让历史活动隐藏运行时计时而不伪造时间。
    this.updateTurnSnapshot({
      turnId,
      requestId: null,
      phase: 'idle',
      tools,
      startedAt: 0,
      elapsedMs: null,
    });
  }

  /** Starts one activity record, optionally tied to its initiating user message. */
  begin(turnIdOrRequestId: string, requestId?: string): void {
    if (this.activeRequestId) this.clear(this.activeRequestId);

    const turnId = turnIdOrRequestId;
    const runRequestId = requestId ?? turnIdOrRequestId;
    const startedAt = Date.now();
    this.activeRequestId = runRequestId;
    this.activeTurnId = turnId;
    this.lastTurnId = turnId;
    this.updateTurnSnapshot({
      turnId,
      requestId: runRequestId,
      phase: 'working',
      tools: [],
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

  /** Ends one matching request, freezes elapsed time, and retains its final tools. */
  clear(requestId: string): void {
    const activity = this.getActiveSnapshot(requestId);
    if (!activity) return;

    this.activeRequestId = null;
    this.activeTurnId = null;
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
    if (requestId !== this.activeRequestId || !this.activeTurnId) return null;
    return this.snapshot[this.activeTurnId] ?? null;
  }

  /** Replaces a live turn snapshot only while its request still owns the active slot. */
  private updateActiveSnapshot(
    requestId: string,
    activity: AgentActivitySnapshot,
  ): void {
    if (requestId !== this.activeRequestId || activity.turnId !== this.activeTurnId) {
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
  startedAt: 0,
  elapsedMs: 0,
};

/** 向常驻 Agent 页面提供当前运行的事件状态。 */
export const agentEventBus = new AgentEventBus();
