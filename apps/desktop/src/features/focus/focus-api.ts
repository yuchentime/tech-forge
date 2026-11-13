import { readBackendErrorMessage } from '../../api/backend-error';
import { isRecord } from '../../api/json';
import { hasDesktopBridge } from '../../types/desktop-bridge';

/** One saved assistant-message excerpt as the 重点关注 page renders it. */
export interface FocusItemView {
  id: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  messageIndex: number;
  quote: string;
  /** User-written study note; null when there is no note. */
  note: string | null;
  createdAt: string;
}

/** Thrown when a focus-item request cannot be completed; the message is user-facing. */
export class FocusApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FocusApiError';
  }
}

/** Lists saved excerpts newest first. */
export async function listFocusItems(): Promise<FocusItemView[]> {
  const response = await request('/api/focus-items');
  if (
    response.status !== 200 ||
    !isRecord(response.data) ||
    !Array.isArray(response.data.items) ||
    !response.data.items.every(isFocusItemView)
  ) {
    throw new FocusApiError(
      readBackendErrorMessage(response.data, '读取重点关注失败，请重试。'),
    );
  }
  return response.data.items;
}

/** Saves one excerpt; the backend returns the existing row when the quote was saved already. */
export async function createFocusItem(input: {
  conversationId: string;
  messageId: string;
  quote: string;
  messageIndex: number;
  /** Optional study note typed in the add dialog; omitted means "no note". */
  note?: string;
}): Promise<FocusItemView> {
  const response = await request('/api/focus-items', 'POST', input);
  if (response.status !== 201 || !isFocusItemView(response.data)) {
    throw new FocusApiError(
      readBackendErrorMessage(response.data, '添加重点关注失败，请重试。'),
    );
  }
  return response.data;
}

/** Replaces one excerpt's study note; an empty note clears it. */
export async function updateFocusItemNote(
  id: string,
  note: string,
): Promise<FocusItemView> {
  const response = await request(
    `/api/focus-items/${encodeURIComponent(id)}`,
    'PATCH',
    { note },
  );
  if (response.status !== 200 || !isFocusItemView(response.data)) {
    throw new FocusApiError(
      readBackendErrorMessage(response.data, '保存备注失败，请重试。'),
    );
  }
  return response.data;
}

/** Deletes one saved excerpt. */
export async function deleteFocusItem(id: string): Promise<void> {
  const response = await request(
    `/api/focus-items/${encodeURIComponent(id)}`,
    'DELETE',
  );
  if (response.status !== 200) {
    throw new FocusApiError(
      readBackendErrorMessage(response.data, '删除重点关注失败，请重试。'),
    );
  }
}

/** Sends one request through the desktop bridge; browser previews cannot reach the backend. */
async function request(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
) {
  if (!hasDesktopBridge()) {
    throw new FocusApiError('请通过 TeachForge 桌面应用使用重点关注。');
  }
  return window.teachforge.request<unknown>(
    body === undefined ? { method, path } : { method, path, body },
  );
}

/** Validates one saved excerpt before it reaches the page. */
function isFocusItemView(value: unknown): value is FocusItemView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.conversationId === 'string' &&
    typeof value.conversationTitle === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.messageIndex === 'number' &&
    Number.isInteger(value.messageIndex) &&
    value.messageIndex >= 1 &&
    typeof value.quote === 'string' &&
    (value.note === null || typeof value.note === 'string') &&
    typeof value.createdAt === 'string'
  );
}
