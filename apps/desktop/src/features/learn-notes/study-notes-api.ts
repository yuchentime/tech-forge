import { requestBackend } from '../../api/backend-request';
import { readBackendErrorMessage } from '../../api/backend-error';
import { isRecord } from '../../api/json';

/** One note the user wrote themselves, as the 学习笔记 page renders it. */
export interface StudyNoteView {
  id: string;
  /** Conversation the note refers to; null when the note stands alone. */
  conversationId: string | null;
  /** Current conversation title; null without a conversation. */
  conversationTitle: string | null;
  content: string;
  createdAt: string;
}

/** Thrown when a study-note request cannot be completed; the message is user-facing. */
export class StudyNoteApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudyNoteApiError';
  }
}

/** Lists user-written notes newest first. */
export async function listStudyNotes(): Promise<StudyNoteView[]> {
  const response = await requestBackend('/api/study-notes');
  if (
    response.status !== 200 ||
    !isRecord(response.data) ||
    !Array.isArray(response.data.items) ||
    !response.data.items.every(isStudyNoteView)
  ) {
    throw new StudyNoteApiError(
      readBackendErrorMessage(response.data, '读取学习笔记失败，请重试。'),
    );
  }
  return response.data.items;
}

/** Saves one note; the conversation link is optional. */
export async function createStudyNote(input: {
  content: string;
  conversationId?: string;
}): Promise<StudyNoteView> {
  const response = await requestBackend('/api/study-notes', 'POST', input);
  if (response.status !== 201 || !isStudyNoteView(response.data)) {
    throw new StudyNoteApiError(
      readBackendErrorMessage(response.data, '保存笔记失败，请重试。'),
    );
  }
  return response.data;
}

/** Replaces one note's text and conversation link; `null` clears the link. */
export async function updateStudyNote(
  id: string,
  input: { content: string; conversationId: string | null },
): Promise<StudyNoteView> {
  const response = await requestBackend(
    `/api/study-notes/${encodeURIComponent(id)}`,
    'PATCH',
    input,
  );
  if (response.status !== 200 || !isStudyNoteView(response.data)) {
    throw new StudyNoteApiError(
      readBackendErrorMessage(response.data, '保存笔记失败，请重试。'),
    );
  }
  return response.data;
}

/** Deletes one note. */
export async function deleteStudyNote(id: string): Promise<void> {
  const response = await requestBackend(
    `/api/study-notes/${encodeURIComponent(id)}`,
    'DELETE',
  );
  if (response.status !== 200) {
    throw new StudyNoteApiError(
      readBackendErrorMessage(response.data, '删除笔记失败，请重试。'),
    );
  }
}

/** Validates one note before it reaches the page. */
function isStudyNoteView(value: unknown): value is StudyNoteView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.conversationId === null || typeof value.conversationId === 'string') &&
    (value.conversationTitle === null ||
      typeof value.conversationTitle === 'string') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string'
  );
}
