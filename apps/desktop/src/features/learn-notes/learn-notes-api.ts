import { requestBackend } from '../../api/backend-request';
import { readBackendErrorMessage } from '../../api/backend-error';
import { isRecord } from '../../api/json';

/** One saved assistant-message excerpt as the 学习笔记 page renders it. */
export interface LearnNoteView {
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

/** Thrown when a learn-notes request cannot be completed; the message is user-facing. */
export class LearnNotesApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearnNotesApiError';
  }
}

/** Lists saved excerpts newest first. */
export async function listLearnNotes(): Promise<LearnNoteView[]> {
  const response = await requestBackend('/api/learn-notes');
  if (
    response.status !== 200 ||
    !isRecord(response.data) ||
    !Array.isArray(response.data.items) ||
    !response.data.items.every(isLearnNoteView)
  ) {
    throw new LearnNotesApiError(
      readBackendErrorMessage(response.data, '读取学习笔记失败，请重试。'),
    );
  }
  return response.data.items;
}

/** Saves one excerpt; the backend returns the existing row when the quote was saved already. */
export async function createLearnNote(input: {
  conversationId: string;
  messageId: string;
  quote: string;
  messageIndex: number;
  /** Optional study note typed in the add dialog; omitted means "no note". */
  note?: string;
}): Promise<LearnNoteView> {
  const response = await requestBackend('/api/learn-notes', 'POST', input);
  if (response.status !== 201 || !isLearnNoteView(response.data)) {
    throw new LearnNotesApiError(
      readBackendErrorMessage(response.data, '添加学习笔记失败，请重试。'),
    );
  }
  return response.data;
}

/** Replaces one excerpt's study note; an empty note clears it. */
export async function updateLearnNote(
  id: string,
  note: string,
): Promise<LearnNoteView> {
  const response = await requestBackend(
    `/api/learn-notes/${encodeURIComponent(id)}`,
    'PATCH',
    { note },
  );
  if (response.status !== 200 || !isLearnNoteView(response.data)) {
    throw new LearnNotesApiError(
      readBackendErrorMessage(response.data, '保存备注失败，请重试。'),
    );
  }
  return response.data;
}

/** Deletes one saved excerpt. */
export async function deleteLearnNote(id: string): Promise<void> {
  const response = await requestBackend(
    `/api/learn-notes/${encodeURIComponent(id)}`,
    'DELETE',
  );
  if (response.status !== 200) {
    throw new LearnNotesApiError(
      readBackendErrorMessage(response.data, '删除学习笔记失败，请重试。'),
    );
  }
}

/** Validates one saved excerpt before it reaches the page. */
function isLearnNoteView(value: unknown): value is LearnNoteView {
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
