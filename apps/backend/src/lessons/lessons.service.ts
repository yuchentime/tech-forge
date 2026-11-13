import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import {
  LessonCorruptError,
  LessonEndedError,
  LessonNotFoundError,
  LessonStillActiveError,
} from './lesson.errors';
import { LessonEntity } from './lesson.entity';
import {
  LessonTranscriptStore,
  type LessonTranscript,
} from './lesson-transcript.store';
import type { LessonMessage, LessonStatus } from './lesson.types';

/**
 * Owns one classroom lesson's lifecycle row and its local JSONL transcript.
 *
 * Message content stays out of SQLite on purpose: this is single-user, local-first state that is
 * append-only and replayed in full, so a per-lesson file is both simpler and cheaper than rows.
 * SQLite keeps only what queries need (`id`, `status`, timestamps).
 */
@Injectable()
export class LessonsService {
  private readonly logger = new Logger(LessonsService.name);
  /** File I/O, line parsing and the per-lesson write queue. */
  private readonly transcript: LessonTranscriptStore;

  constructor(
    @InjectRepository(LessonEntity)
    private readonly repository: Repository<LessonEntity>,
    settings: SettingsService,
  ) {
    this.transcript = new LessonTranscriptStore(settings);
  }

  /** Returns the single active lesson, if one exists. */
  async findActiveLesson(): Promise<LessonEntity | null> {
    return this.repository.findOne({ where: { status: 'active' } });
  }

  /**
   * Ends the current active lesson and creates a new one.
   *
   * "Start a new classroom" must always produce a new lesson: the stage's damaged-record recovery
   * depends on the id actually changing. The previous lesson is closed first (through the same
   * per-lesson queue as turns), so it becomes visible history; the partial unique index still
   * guarantees only one active row, and a lost race is retried once.
   */
  async startNewLesson(): Promise<LessonEntity> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const active = await this.findActiveLesson();
      if (active) {
        await this.endLesson(active.id);
      }
      try {
        return await this.startLesson();
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }
    }
    throw new Error('Could not start a new lesson.');
  }

  /** Creates one active lesson. Its transcript directory appears with the first message. */
  async startLesson(): Promise<LessonEntity> {
    const lesson = this.repository.create({
      id: randomUUID(),
      status: 'active',
      endedAt: null,
    });
    return this.repository.save(lesson);
  }

  /** Returns one lesson regardless of status; the read API serves ended lessons too. */
  async findLesson(lessonId: string): Promise<LessonEntity | null> {
    return this.repository.findOne({ where: { id: lessonId } });
  }

  /** Lists lessons newest first; the landing page requests active and ended separately. */
  async listLessons(options: {
    status?: LessonStatus;
    limit: number;
  }): Promise<LessonEntity[]> {
    return this.repository.find({
      where: options.status ? { status: options.status } : {},
      order: { createdAt: 'DESC' },
      take: options.limit,
    });
  }

  /** Marks a summary as being generated and clears any previous error. */
  async markSummaryGenerating(lessonId: string): Promise<void> {
    await this.repository.update(
      { id: lessonId },
      { summaryStatus: 'generating', summaryError: null },
    );
  }

  /** Stores the generated Markdown and marks the summary ready. */
  async saveSummary(lessonId: string, markdown: string): Promise<LessonEntity> {
    await this.repository.update(
      { id: lessonId },
      {
        summaryStatus: 'ready',
        summaryMarkdown: markdown,
        summaryError: null,
        summaryGeneratedAt: new Date(),
      },
    );
    const lesson = await this.findLesson(lessonId);
    if (!lesson) {
      throw new Error(`Lesson not found after saving summary: ${lessonId}.`);
    }
    return lesson;
  }

  /** Records a failed generation with a user-safe reason; the previous summary is kept. */
  async failSummary(lessonId: string, message: string): Promise<LessonEntity> {
    await this.repository.update(
      { id: lessonId },
      { summaryStatus: 'failed', summaryError: message },
    );
    const lesson = await this.findLesson(lessonId);
    if (!lesson) {
      throw new Error(`Lesson not found after failing summary: ${lessonId}.`);
    }
    return lesson;
  }

  /**
   * Fails summaries left `generating` by a previous process.
   *
   * Generation runs in-process; after a crash or restart nothing would ever finish the row, so the
   * UI would show an endless spinner. Failing them lets the user retry.
   */
  async resetInterruptedSummaries(): Promise<number> {
    const result = await this.repository.update(
      { summaryStatus: 'generating' },
      { summaryStatus: 'failed', summaryError: '生成被中断，请重试。' },
    );
    return result.affected ?? 0;
  }

  /**
   * Deletes one ended lesson and its transcript.
   *
   * Only history is deletable: an active lesson must be ended first so a running turn cannot lose
   * its row. The row goes first; an orphaned transcript directory is harmless and logged, while a
   * row pointing at a missing transcript would look like a corrupt lesson.
   */
  async deleteLesson(lessonId: string): Promise<void> {
    const lesson = await this.findLesson(lessonId);
    if (!lesson) {
      throw new LessonNotFoundError(lessonId);
    }
    if (lesson.status === 'active') {
      throw new LessonStillActiveError(lessonId);
    }
    await this.repository.delete({ id: lessonId });
    try {
      await this.transcript.remove(lessonId);
    } catch (error) {
      this.logger.error({
        event: 'lessons.transcript.delete.failed',
        lessonId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Returns one lesson, failing when it is missing or no longer accepts messages. */
  async requireActiveLesson(lessonId: string): Promise<LessonEntity> {
    const lesson = await this.findLesson(lessonId);
    if (!lesson) {
      throw new LessonNotFoundError(lessonId);
    }
    if (lesson.status !== 'active') {
      throw new LessonEndedError(lessonId);
    }
    return lesson;
  }

  /**
   * Marks a lesson as ended. Ending an already-ended lesson is a no-op, so recovery can retry.
   *
   * It shares the per-lesson queue with appends: a turn either finishes its append before the end
   * is written, or sees the ended status inside the queue. Ending outside the queue could let a
   * message pass the active check and then be written into an already-ended lesson.
   */
  async endLesson(lessonId: string): Promise<LessonEntity> {
    return this.transcript.runExclusive(lessonId, async () => {
      const lesson = await this.findLesson(lessonId);
      if (!lesson) {
        throw new LessonNotFoundError(lessonId);
      }
      if (lesson.status === 'ended') return lesson;
      lesson.status = 'ended';
      lesson.endedAt = new Date();
      return this.repository.save(lesson);
    });
  }

  /**
   * Appends one message to the lesson transcript.
   *
   * The active check and the integrity check run inside the per-lesson queue: a concurrent
   * `endLesson()` must either run before this append (rejected here) or after it, never between the
   * check and the write. A damaged file is never appended to — one bad line must not be buried
   * under new messages; the caller starts a new lesson instead.
   */
  appendMessage(
    lessonId: string,
    speaker: LessonMessage['speaker'],
    text: string,
  ): Promise<LessonMessage> {
    const content = text.trim();
    if (!content) {
      throw new Error('Lesson message must not be empty.');
    }
    const message: LessonMessage = {
      id: randomUUID(),
      speaker,
      text: content,
      createdAt: new Date().toISOString(),
    };

    return this.transcript.runExclusive(lessonId, async () => {
      await this.requireActiveLesson(lessonId);
      const transcript = await this.transcript.read(lessonId);
      if (transcript.corruptLineNumbers.length > 0) {
        throw new LessonCorruptError(transcript.corruptLineNumbers);
      }
      await this.transcript.append(lessonId, message);
      return message;
    });
  }

  /** Reads the transcript with damaged lines reported; used by the read API. */
  readTranscript(lessonId: string): Promise<LessonTranscript> {
    return this.transcript.read(lessonId);
  }

  /**
   * Reads the transcript for a turn that will append to it.
   *
   * A damaged file must not receive new lines: mixing fresh messages into a file whose ordering is
   * already broken would make the damage invisible to later readers. Callers turn this into a user
   * action (start a new classroom) instead of repairing the file automatically.
   */
  readMessages(lessonId: string): Promise<LessonMessage[]> {
    return this.transcript.readStrict(lessonId);
  }

}
