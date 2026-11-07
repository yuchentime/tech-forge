import { hasDesktopBridge } from '../../types/desktop-bridge';

/** Describes one lightweight Conversation row displayed in the sidebar. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Describes one visible message returned for a selected Conversation. */
export interface ConversationHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'failed' | 'cancelled';
  createdAt: string;
}

/** Exposes conversation list state to the Agent page and streamed adapter. */
export interface ConversationStoreSnapshot {
  conversations: readonly ConversationSummary[];
  activeConversationId: string | null;
  listStatus: 'idle' | 'loading' | 'ready' | 'error';
  listError: string | null;
}

const ACTIVE_CONVERSATION_STORAGE_KEY = 'teachforge.agent.activeConversationId';

/** Reads the active Conversation ID without requiring browser storage to exist. */
function readStoredConversationId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Shares list refresh and active selection across the page and stream adapter. */
export class ConversationStore {
  private readonly listeners = new Set<() => void>();
  private listRequestVersion = 0;
  private snapshot: ConversationStoreSnapshot = {
    conversations: [],
    activeConversationId: readStoredConversationId(),
    listStatus: 'idle',
    listError: null,
  };

  /** Subscribes to immutable snapshots consumed by React. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the current immutable conversation state. */
  getSnapshot = (): ConversationStoreSnapshot => this.snapshot;

  /** Persists and publishes the active conversation ID for later Agent turns. */
  setActiveConversationId(conversationId: string | null): void {
    try {
      if (conversationId) {
        localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
      } else {
        localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      }
    } catch {
      // Keep the in-memory selection usable when browser storage is unavailable.
    }

    this.update({ activeConversationId: conversationId });
  }

  /** Loads the latest ordered summaries and retains the last good list on error. */
  async refresh(): Promise<void> {
    const requestVersion = ++this.listRequestVersion;
    this.update({ listStatus: 'loading', listError: null });

    if (!hasDesktopBridge()) {
      console.error('[TeachForge][conversation.list] desktop_bridge_unavailable');
      this.update({
        listStatus: 'error',
        listError: '浏览器预览无法读取本地会话，请通过 TeachForge 桌面应用打开。',
      });
      return;
    }

    let httpStatus: number | null = null;
    try {
      const response = await window.teachforge.request<ConversationSummary[]>({
        method: 'GET',
        path: '/api/conversations',
      });
      httpStatus = response.status;
      if (response.status !== 200 || !Array.isArray(response.data)) {
        throw new Error('会话列表加载失败。');
      }
      if (requestVersion !== this.listRequestVersion) return;

      this.update({
        conversations: response.data,
        listStatus: 'ready',
        listError: null,
      });
    } catch (error) {
      if (requestVersion !== this.listRequestVersion) return;
      console.error('[TeachForge][conversation.list] request_failed', {
        httpStatus,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      this.update({
        listStatus: 'error',
        listError:
          httpStatus === null
            ? '会话列表加载失败，请重试。'
            : `会话列表加载失败（HTTP ${httpStatus}），请重试。`,
      });
    }
  }

  /** Replaces one snapshot and notifies all active Agent page subscribers. */
  private update(patch: Partial<ConversationStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Shares the single active Conversation and list state for this renderer. */
export const conversationStore = new ConversationStore();
