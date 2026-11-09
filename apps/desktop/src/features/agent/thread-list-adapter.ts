import type { RemoteThreadListAdapter, ThreadMessage } from '@assistant-ui/react';
import type { AssistantStream } from 'assistant-stream';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import type { ConversationSummary } from './conversation-store';

/** Converts the persisted conversation summaries into assistant-ui remote thread metadata. */
function toThread(summary: ConversationSummary) {
  return {
    remoteId: summary.id,
    title: summary.title,
    lastMessageAt: new Date(summary.updatedAt),
    status: 'regular' as const,
  };
}

/** Throws a small safe error for renderer requests that did not produce the expected response. */
function requireStatus(status: number, expected: number, action: string): void {
  if (status !== expected) throw new Error(`${action}失败（HTTP ${status}）。`);
}

/** The backend owns titles, so assistant-ui receives a deliberately empty title stream. */
async function emptyTitleStream(): Promise<AssistantStream> {
  return new ReadableStream();
}

/**
 * Stable remote-thread adapter for the desktop Agent page.
 *
 * It intentionally does not keep a second list cache: assistant-ui owns list identity while every
 * refresh merges fresh metadata into the existing thread bodies.
 */
export const threadListAdapter: RemoteThreadListAdapter = {
  async list() {
    if (!hasDesktopBridge()) throw new Error('浏览器预览无法读取本地会话，请通过 TeachForge 桌面应用打开。');
    const response = await window.teachforge.request<ConversationSummary[]>({
      method: 'GET',
      path: '/api/conversations',
    });
    requireStatus(response.status, 200, '加载对话列表');
    if (!Array.isArray(response.data)) throw new Error('对话列表响应格式异常。');
    return { threads: response.data.map(toThread) };
  },

  async initialize() {
    if (!hasDesktopBridge()) throw new Error('浏览器预览无法创建本地会话，请通过 TeachForge 桌面应用打开。');
    const response = await window.teachforge.request<{ conversationId?: string }>({
      method: 'POST',
      path: '/api/conversations',
    });
    requireStatus(response.status, 201, '创建会话');
    if (!response.data?.conversationId) throw new Error('创建会话响应格式异常。');
    return { remoteId: response.data.conversationId };
  },

  async fetch(threadId) {
    const { threads } = await this.list();
    const thread = threads.find((candidate) => candidate.remoteId === threadId);
    if (!thread) throw new Error('该会话已不存在。');
    return thread;
  },

  async delete(remoteId) {
    if (!hasDesktopBridge()) throw new Error('浏览器预览无法删除本地会话，请通过 TeachForge 桌面应用打开。');
    const response = await window.teachforge.request<unknown>({
      method: 'DELETE',
      path: `/api/conversations/${encodeURIComponent(remoteId)}`,
    });
    requireStatus(response.status, 200, '删除会话');
  },

  async rename() {
    // Titles are derived by the backend from the first user message; no UI exposes rename.
  },

  async archive() {
    throw new Error('当前版本不支持归档会话。');
  },

  generateTitle(_remoteId: string, _messages: readonly ThreadMessage[]) {
    return emptyTitleStream();
  },
};
