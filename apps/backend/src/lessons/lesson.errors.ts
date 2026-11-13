/** Raised when a requested lesson row does not exist. */
export class LessonNotFoundError extends Error {
  constructor(lessonId: string) {
    super(`Lesson not found: ${lessonId}.`);
    this.name = 'LessonNotFoundError';
  }
}

/** Raised when an active lesson is deleted without being ended first. */
export class LessonStillActiveError extends Error {
  constructor(lessonId: string) {
    super(`Lesson is still active: ${lessonId}.`);
    this.name = 'LessonStillActiveError';
  }
}

/** Raised when a lesson no longer accepts turns. */
export class LessonEndedError extends Error {
  constructor(lessonId: string) {
    super(`Lesson is not active: ${lessonId}.`);
    this.name = 'LessonEndedError';
  }
}

/**
 * Raised when the JSONL transcript has unusable lines.
 *
 * It carries the line numbers so the read API can report them and the turn/summary paths can give
 * the user a recovery action instead of a generic failure.
 */
export class LessonCorruptError extends Error {
  constructor(readonly lineNumbers: readonly number[]) {
    super(`Lesson transcript is corrupt at line(s) ${lineNumbers.join(', ')}.`);
    this.name = 'LessonCorruptError';
  }
}
