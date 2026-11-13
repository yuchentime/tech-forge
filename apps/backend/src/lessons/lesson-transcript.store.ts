import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SettingsService } from '../settings/settings.service';
import { isClassroomStudentId } from './classroom-students';
import { LessonCorruptError } from './lesson.errors';
import type { LessonMessage } from './lesson.types';

const TRANSCRIPT_FILE_NAME = 'messages.jsonl';

/** One transcript read, including the lines that could not be parsed. */
export interface LessonTranscript {
  messages: LessonMessage[];
  /** 1-based line numbers of unusable lines; the file itself is never rewritten. */
  corruptLineNumbers: number[];
}

/**
 * Owns the per-lesson JSONL transcript: file I/O, line parsing and the write queue.
 *
 * It knows nothing about lesson rows or active status; callers run their state checks inside
 * `runExclusive()` so a status change and a write can never interleave. Message content stays out
 * of SQLite on purpose: it is append-only, replayed in full, and never queried.
 */
export class LessonTranscriptStore {
  /** One promise chain per lesson, so appends and status changes cannot interleave. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly settings: SettingsService) {}

  /** Number of lessons with a queued operation; used by tests to prove cleanup. */
  get pendingQueueCount(): number {
    return this.queues.size;
  }

  /**
   * Runs one task after every earlier task for the same lesson.
   *
   * A failed predecessor must not block the queue: it only fails its own caller.
   */
  runExclusive<T>(lessonId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(lessonId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(lessonId, settled);
    void settled.then(() => {
      if (this.queues.get(lessonId) === settled) {
        this.queues.delete(lessonId);
      }
    });
    return result;
  }

  /**
   * Reads the full transcript, keeping usable lines and reporting damaged ones.
   *
   * A missing file means the lesson has no messages yet. A malformed line is skipped here so the
   * classroom UI can still show the rest of the lesson, but the line number is returned and the
   * file is left untouched: the read API reports `degraded`, and `readStrict()` still refuses.
   */
  async read(lessonId: string): Promise<LessonTranscript> {
    const path = join(this.settings.getLessonDirectory(lessonId), TRANSCRIPT_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { messages: [], corruptLineNumbers: [] };
      }
      throw error;
    }

    const messages: LessonMessage[] = [];
    const corruptLineNumbers: number[] = [];
    const lines = raw.split('\n');
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        corruptLineNumbers.push(index + 1);
        continue;
      }
      const message = parseStoredMessage(value);
      if (message) {
        messages.push(message);
      } else {
        corruptLineNumbers.push(index + 1);
      }
    }
    return { messages, corruptLineNumbers };
  }

  /** Reads the transcript for a turn that will append to it; damaged lines are fatal. */
  async readStrict(lessonId: string): Promise<LessonMessage[]> {
    const transcript = await this.read(lessonId);
    if (transcript.corruptLineNumbers.length > 0) {
      throw new LessonCorruptError(transcript.corruptLineNumbers);
    }
    return transcript.messages;
  }

  /** Removes the lesson's transcript directory; missing directories are ignored. */
  async remove(lessonId: string): Promise<void> {
    await rm(this.settings.getLessonDirectory(lessonId), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Appends one already-validated message.
   *
   * Must be called inside `runExclusive()` for the lesson: it performs no active or integrity
   * check of its own, so a caller cannot skip the queue and still be safe.
   */
  async append(lessonId: string, message: LessonMessage): Promise<void> {
    const directory = this.settings.getLessonDirectory(lessonId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(
      join(directory, TRANSCRIPT_FILE_NAME),
      `${JSON.stringify(message)}\n`,
      'utf8',
    );
  }

}

/** Validates one stored JSONL line; returns null so the caller can report the line number. */
function parseStoredMessage(value: unknown): LessonMessage | null {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const speaker = record?.speaker;
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.text !== 'string' ||
    typeof record.createdAt !== 'string' ||
    (speaker !== 'teacher' && !isClassroomStudentId(speaker))
  ) {
    return null;
  }
  return {
    id: record.id,
    speaker: speaker as LessonMessage['speaker'],
    text: record.text,
    createdAt: record.createdAt,
  };
}
