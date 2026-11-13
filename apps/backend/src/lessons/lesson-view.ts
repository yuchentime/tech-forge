import { truncateChars } from './transcript-format';
import type { LessonEntity } from './lesson.entity';
import type { LessonStatus, LessonSummaryStatus } from './lesson.types';

/** Longest summary preview the landing list returns; the full text has its own endpoint. */
const SUMMARY_PREVIEW_CHARS = 160;

/** One lesson's lifecycle as the classroom API returns it (dates as ISO strings). */
export interface LessonView {
  id: string;
  status: LessonStatus;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summaryStatus: LessonSummaryStatus;
  summaryGeneratedAt: string | null;
}

/** One landing-page row: lifecycle plus a short summary preview. */
export interface LessonListEntry extends LessonView {
  summaryPreview: string | null;
}

/** Landing payload; the UI partitions `active` and `ended` rows itself. */
export interface LessonListView {
  lessons: LessonListEntry[];
}

/** Full summary of one ended lesson. */
export interface LessonSummaryView {
  lessonId: string;
  status: LessonStatus;
  summaryStatus: LessonSummaryStatus;
  summary: string | null;
  error: string | null;
  generatedAt: string | null;
}

/** Maps the stored row to the wire shape and narrows the free-form status column. */
export function toLessonView(lesson: LessonEntity): LessonView {
  return {
    id: lesson.id,
    status: readLessonStatus(lesson.status),
    endedAt: lesson.endedAt ? lesson.endedAt.toISOString() : null,
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString(),
    summaryStatus: readSummaryStatus(lesson.summaryStatus),
    summaryGeneratedAt: lesson.summaryGeneratedAt
      ? lesson.summaryGeneratedAt.toISOString()
      : null,
  };
}

/** Adds the list-only preview without shipping the full Markdown. */
export function toLessonListEntry(lesson: LessonEntity): LessonListEntry {
  return {
    ...toLessonView(lesson),
    summaryPreview: summarizePreview(lesson.summaryMarkdown),
  };
}

/** Full summary payload; the view keeps the error separate from the Markdown. */
export function toLessonSummaryView(lesson: LessonEntity): LessonSummaryView {
  return {
    lessonId: lesson.id,
    status: readLessonStatus(lesson.status),
    summaryStatus: readSummaryStatus(lesson.summaryStatus),
    summary: lesson.summaryMarkdown,
    error: lesson.summaryError,
    generatedAt: lesson.summaryGeneratedAt
      ? lesson.summaryGeneratedAt.toISOString()
      : null,
  };
}

/** Strips Markdown markers and collapses whitespace into one line for the landing card. */
export function summarizePreview(markdown: string | null): string | null {
  const text = markdown
    ?.replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return truncateChars(text, SUMMARY_PREVIEW_CHARS);
}

/** Narrows the stored status; an unknown value is an integrity error, not a silent default. */
export function readLessonStatus(status: string): LessonStatus {
  if (status === 'active' || status === 'ended') return status;
  throw new Error(`Lesson status is invalid: ${status}.`);
}

/** Narrows the stored summary status, failing loudly on an unexpected value. */
export function readSummaryStatus(status: string): LessonSummaryStatus {
  if (
    status === 'none' ||
    status === 'generating' ||
    status === 'ready' ||
    status === 'failed'
  ) {
    return status;
  }
  throw new Error(`Lesson summary status is invalid: ${status}.`);
}
