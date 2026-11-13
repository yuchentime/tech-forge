import { readBackendErrorMessage } from '../../api/backend-error';
import { isRecord } from '../../api/json';
import { hasDesktopBridge } from '../../types/desktop-bridge';

export type LessonStatus = 'active' | 'ended';
export type LessonSummaryStatus = 'none' | 'generating' | 'ready' | 'failed';
export type LessonSpeaker = 'teacher' | 'su' | 'lin' | 'gu';

export interface LessonView {
  id: string;
  status: LessonStatus;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summaryStatus: LessonSummaryStatus;
  summaryGeneratedAt: string | null;
}

export interface LessonListEntry extends LessonView {
  summaryPreview: string | null;
}

export interface LessonMessageView {
  id: string;
  speaker: LessonSpeaker;
  role: 'teacher' | 'student';
  name: string;
  text: string;
  createdAt: string;
}

export interface LessonMessagesView {
  lessonId: string;
  status: LessonStatus;
  integrity: {
    status: 'ok' | 'degraded';
    corruptLineCount: number;
    corruptLineNumbers: number[];
  };
  messages: LessonMessageView[];
}

export interface LessonSummaryView {
  lessonId: string;
  status: LessonStatus;
  summaryStatus: LessonSummaryStatus;
  summary: string | null;
  error: string | null;
  generatedAt: string | null;
}

/** Thrown when a classroom request cannot be completed; the message is user-facing. */
export class ClassroomApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassroomApiError';
  }
}

const LESSON_STATUSES: Record<string, true> = { active: true, ended: true };
const SUMMARY_STATUSES: Record<string, true> = {
  none: true,
  generating: true,
  ready: true,
  failed: true,
};
const SPEAKERS: Record<string, true> = {
  teacher: true,
  su: true,
  lin: true,
  gu: true,
};

/** Lists lessons newest first; the home page asks for active and ended separately. */
export async function listLessons(
  status?: LessonStatus,
): Promise<LessonListEntry[]> {
  const query = status ? `?status=${status}` : '';
  const response = await request(`/api/lessons${query}`);
  if (
    response.status !== 200 ||
    !isRecord(response.data) ||
    !Array.isArray(response.data.lessons) ||
    !response.data.lessons.every(isLessonListEntry)
  ) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '读取课堂列表失败，请重试。'),
    );
  }
  return response.data.lessons;
}

/** Creates an empty classroom; the caller enters it immediately. */
export async function createLesson(): Promise<LessonView> {
  const response = await request('/api/lessons', 'POST');
  if (response.status !== 201 || !isLessonView(response.data)) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '创建课堂失败，请重试。'),
    );
  }
  return response.data;
}

/** Ends a lesson; ending an already-ended lesson is a no-op on the backend. */
export async function endLesson(lessonId: string): Promise<LessonView> {
  const response = await request(
    `/api/lessons/${encodeURIComponent(lessonId)}/end`,
    'POST',
  );
  if (response.status !== 200 || !isLessonView(response.data)) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '结束课堂失败，请重试。'),
    );
  }
  return response.data;
}

/** Loads the full transcript with speaker identity and integrity information. */
export async function loadLessonMessages(
  lessonId: string,
): Promise<LessonMessagesView> {
  const response = await request(
    `/api/lessons/${encodeURIComponent(lessonId)}/messages`,
  );
  if (response.status !== 200 || !isLessonMessagesView(response.data)) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '读取课堂记录失败，请重试。'),
    );
  }
  return response.data;
}

/** Sends one teacher message and returns the transcript after the student replies. */
export async function sendLessonTurn(
  lessonId: string,
  text: string,
): Promise<LessonMessagesView> {
  const response = await request(
    `/api/lessons/${encodeURIComponent(lessonId)}/turns`,
    'POST',
    { text },
  );
  if (response.status !== 200 || !isLessonMessagesView(response.data)) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '学生回应失败，请重试。'),
    );
  }
  return response.data;
}

/** Deletes one history lesson: row, summary and transcript. */
export async function deleteLesson(lessonId: string): Promise<void> {
  const response = await request(
    `/api/lessons/${encodeURIComponent(lessonId)}`,
    'DELETE',
  );
  if (response.status !== 200) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '删除课堂记录失败，请重试。'),
    );
  }
}

/** Reads the stored summary and its generation status. */
export async function loadLessonSummary(
  lessonId: string,
): Promise<LessonSummaryView> {
  const response = await request(
    `/api/lessons/${encodeURIComponent(lessonId)}/summary`,
  );
  if (response.status !== 200 || !isLessonSummaryView(response.data)) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '读取课堂总结失败，请重试。'),
    );
  }
  return response.data;
}

/** Generates or regenerates the summary; only ended lessons accept this. */
export async function generateLessonSummary(
  lessonId: string,
): Promise<LessonSummaryView> {
  const response = await request(
    `/api/lessons/${encodeURIComponent(lessonId)}/summary`,
    'POST',
  );
  if (response.status !== 200 || !isLessonSummaryView(response.data)) {
    throw new ClassroomApiError(
      readBackendErrorMessage(response.data, '生成课堂总结失败，请重试。'),
    );
  }
  return response.data;
}

/** Sends one request through the desktop bridge; browser previews cannot reach the backend. */
async function request(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
) {
  if (!hasDesktopBridge()) {
    throw new ClassroomApiError('请通过 TeachForge 桌面应用使用课堂模式。');
  }
  return window.teachforge.request<unknown>(
    body === undefined ? { method, path } : { method, path, body },
  );
}

/** Validates the lifecycle row shared by every lesson response. */
function isLessonView(value: unknown): value is LessonView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    LESSON_STATUSES[value.status] === true &&
    (value.endedAt === null || typeof value.endedAt === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.summaryStatus === 'string' &&
    SUMMARY_STATUSES[value.summaryStatus] === true &&
    (value.summaryGeneratedAt === null ||
      typeof value.summaryGeneratedAt === 'string')
  );
}

/** Validates one landing row, which adds the summary preview. */
function isLessonListEntry(value: unknown): value is LessonListEntry {
  if (!isRecord(value)) return false;
  const preview = value.summaryPreview;
  if (preview !== null && typeof preview !== 'string') return false;
  return isLessonView(value);
}

/** Validates the transcript envelope and every message. */
function isLessonMessagesView(value: unknown): value is LessonMessagesView {
  return (
    isRecord(value) &&
    typeof value.lessonId === 'string' &&
    typeof value.status === 'string' &&
    LESSON_STATUSES[value.status] === true &&
    isRecord(value.integrity) &&
    (value.integrity.status === 'ok' || value.integrity.status === 'degraded') &&
    typeof value.integrity.corruptLineCount === 'number' &&
    Array.isArray(value.integrity.corruptLineNumbers) &&
    Array.isArray(value.messages) &&
    value.messages.every(isLessonMessageView)
  );
}

/** Validates one transcript line with its speaker identity. */
function isLessonMessageView(value: unknown): value is LessonMessageView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.speaker === 'string' &&
    SPEAKERS[value.speaker] === true &&
    (value.role === 'teacher' || value.role === 'student') &&
    typeof value.name === 'string' &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'string'
  );
}

/** Validates the summary envelope. */
function isLessonSummaryView(value: unknown): value is LessonSummaryView {
  return (
    isRecord(value) &&
    typeof value.lessonId === 'string' &&
    typeof value.status === 'string' &&
    LESSON_STATUSES[value.status] === true &&
    typeof value.summaryStatus === 'string' &&
    SUMMARY_STATUSES[value.summaryStatus] === true &&
    (value.summary === null || typeof value.summary === 'string') &&
    (value.error === null || typeof value.error === 'string') &&
    (value.generatedAt === null || typeof value.generatedAt === 'string')
  );
}
