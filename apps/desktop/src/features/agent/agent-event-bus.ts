import type { AgentStreamEvent } from '../../types/agent-stream-event';

export type AgentToolActivity = {
  toolCallId: string;
  toolName: string;
  args: unknown;
};

export type AgentActivitySnapshot = {
  requestId: string | null;
  phase: 'idle' | 'working' | 'responding';
  tools: AgentToolActivity[];
};

/** 将当前运行的安全 Pi 事件发布给 React 活动状态订阅者。 */
export class AgentEventBus {
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentActivitySnapshot = {
    requestId: null,
    phase: 'idle',
    tools: [],
  };

  /** 订阅活动状态快照，并返回取消订阅函数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 返回 useSyncExternalStore 所需的当前不可变快照。 */
  getSnapshot = (): AgentActivitySnapshot => this.snapshot;

  /** 开始一轮请求，并清掉上一轮可能残留的 UI 状态。 */
  begin(requestId: string): void {
    this.setSnapshot({ requestId, phase: 'working', tools: [] });
  }

  /** 只处理属于当前 requestId 的事件，隔离过期请求。 */
  publish(requestId: string, event: AgentStreamEvent): void {
    if (requestId !== this.snapshot.requestId) return;

    switch (event.type) {
      case 'tool_execution_start':
        this.setSnapshot({
          ...this.snapshot,
          phase: 'working',
          tools: [
            ...this.snapshot.tools.filter(
              (tool) => tool.toolCallId !== event.toolCallId,
            ),
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            },
          ],
        });
        return;
      case 'tool_execution_end':
        this.setSnapshot({
          ...this.snapshot,
          phase: 'working',
          tools: this.snapshot.tools.filter(
            (tool) => tool.toolCallId !== event.toolCallId,
          ),
        });
        return;
      case 'message_update':
        if (this.snapshot.phase === 'responding') return;
        this.setSnapshot({ ...this.snapshot, phase: 'responding' });
        return;
      case 'done':
      case 'error':
        this.clear(requestId);
        return;
      default:
        this.setSnapshot({ ...this.snapshot, phase: 'working' });
    }
  }

  /** 只清除匹配的运行，避免旧请求取消时清掉新请求状态。 */
  clear(requestId: string): void {
    if (requestId !== this.snapshot.requestId) return;
    this.setSnapshot({ requestId: null, phase: 'idle', tools: [] });
  }

  /** 替换状态快照并通知所有 UI 订阅者。 */
  private setSnapshot(snapshot: AgentActivitySnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

/** 向常驻 Agent 页面提供当前运行的事件状态。 */
export const agentEventBus = new AgentEventBus();
