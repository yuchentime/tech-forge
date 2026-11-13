import type { ClassroomStudentId } from './classroom-students';

/** Lifecycle of one classroom lesson. Message content is never stored here. */
export type LessonStatus = 'active' | 'ended';

/** Generation state of one ended lesson's summary. */
export type LessonSummaryStatus = 'none' | 'generating' | 'ready' | 'failed';

/**
 * One line of the local classroom transcript.
 *
 * It is stored as JSON Lines under `<configDir>/lessons/<lessonId>/messages.jsonl`; SQLite keeps
 * only the lesson row, because the transcript is local runtime state, not queryable business data.
 */
export interface LessonMessage {
  id: string;
  speaker: 'teacher' | ClassroomStudentId;
  text: string;
  createdAt: string;
}

/** Result of one teacher turn: the lesson it belongs to and the full transcript after it. */
export interface ClassroomTurnResult {
  lessonId: string;
  messages: LessonMessage[];
}
