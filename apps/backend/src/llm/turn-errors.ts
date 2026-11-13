import {
  LessonCorruptError,
  LessonEndedError,
  LessonNotFoundError,
} from '../lessons/lesson.errors';

/**
 * Wraps model/session failures so the HTTP layer can map them to 502.
 *
 * Lesson-domain failures (missing, ended, corrupt) stay as their own types; file-system and
 * database failures are also left untouched so they surface as 500 instead of "retry the student".
 */
export class ClassroomTurnError extends Error {
  constructor(readonly original: unknown) {
    super(
      original instanceof Error
        ? original.message
        : 'Classroom turn failed without an error message.',
    );
    this.name = 'ClassroomTurnError';
  }
}

/** Whether one error belongs to the lesson domain and must keep its HTTP mapping. */
export function isLessonError(error: unknown): boolean {
  return (
    error instanceof LessonCorruptError ||
    error instanceof LessonEndedError ||
    error instanceof LessonNotFoundError
  );
}
