import type { ClassroomStudentId } from './classroom-students';
import { CLASSROOM_STUDENTS } from './classroom-students';
import { truncateChars } from './transcript-format';
import type { LessonMessage, LessonStatus } from './lesson.types';

/** One transcript line as the classroom UI renders it: speaker identity plus text. */
export interface LessonMessageView {
  id: string;
  /** Stable speaker key the UI keys avatars and styles on. */
  speaker: 'teacher' | ClassroomStudentId;
  /** Whether the line belongs to the teacher or a student. */
  role: 'teacher' | 'student';
  /** Display name: 老师 / 苏小满 / 林澈 / 顾知夏. */
  name: string;
  text: string;
  createdAt: string;
}

/** Health of one transcript read; `degraded` means some lines could not be parsed. */
export interface LessonTranscriptIntegrity {
  status: 'ok' | 'degraded';
  /** Number of unusable lines; the file is left untouched so nothing is silently rewritten. */
  corruptLineCount: number;
  /** 1-based line numbers of those lines, for diagnostics and the "start a new lesson" banner. */
  corruptLineNumbers: number[];
}

/** The common clean-read shape, shared so every response builds it once. */
export const OK_INTEGRITY: LessonTranscriptIntegrity = Object.freeze({
  status: 'ok',
  corruptLineCount: 0,
  corruptLineNumbers: [],
});

/** Builds the integrity envelope from the line numbers reported by a tolerant read. */
export function toIntegrity(
  corruptLineNumbers: readonly number[],
): LessonTranscriptIntegrity {
  return corruptLineNumbers.length === 0
    ? OK_INTEGRITY
    : {
        status: 'degraded',
        corruptLineCount: corruptLineNumbers.length,
        corruptLineNumbers: [...corruptLineNumbers],
      };
}

/** Full transcript of one lesson, including the lifecycle status and integrity the UI needs. */
export interface LessonMessagesView {
  lessonId: string;
  status: LessonStatus;
  integrity: LessonTranscriptIntegrity;
  messages: LessonMessageView[];
}

/** Adds the human-readable speaker identity to one stored message. */
export function toLessonMessageView(message: LessonMessage): LessonMessageView {
  const student =
    message.speaker === 'teacher' ? undefined : CLASSROOM_STUDENTS[message.speaker];
  return {
    id: message.id,
    speaker: message.speaker,
    role: student ? 'student' : 'teacher',
    name: student?.name ?? '老师',
    text: message.text,
    createdAt: message.createdAt,
  };
}
