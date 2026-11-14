import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { getSafeErrorLogFields } from '../../logging/structured-logger';
import { LessonCorruptError } from '../../lessons/lesson.errors';
import type { LessonEntity } from '../../lessons/lesson.entity';
import { LessonsService } from '../../lessons/lessons.service';
import { formatTranscript } from '../../lessons/transcript-format';
import {
  buildSummaryPrompt,
  CLASSROOM_SUMMARY_SYSTEM_PROMPT,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_MESSAGE_LIMIT,
  SUMMARY_TIMEOUT_MS,
} from '../prompts/classroom-summary.prompt';
import { CommonAgent } from './CommonAgent';

/** Raised when a second generation is requested while one is still running. */
export class LessonSummaryBusyError extends Error {
  constructor(lessonId: string) {
    super(`Lesson summary is already generating: ${lessonId}.`);
    this.name = 'LessonSummaryBusyError';
  }
}

/**
 * Generates and stores one ended lesson's summary.
 *
 * The model call goes through `CommonAgent.generate()`: no conversation, no snapshot, no tools
 * and no memory. Failure is a stored status (`failed` + user-safe reason) rather than an HTTP
 * error — the classroom remains readable and the UI can offer a retry.
 */
@Injectable()
export class ClassroomSummariesAgent implements OnModuleInit {
  private readonly logger = new Logger(ClassroomSummariesAgent.name);
  /** Lessons currently generating in this process; prevents duplicate writes from double clicks. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly lessons: LessonsService,
    private readonly commonAgent: CommonAgent,
  ) {}

  /** Fails summaries orphaned by a previous process so the UI never spins forever. */
  async onModuleInit(): Promise<void> {
    const reset = await this.lessons.resetInterruptedSummaries();
    if (reset > 0) {
      this.logger.warn({
        event: 'classroom.summary.reset_interrupted',
        count: reset,
      });
    }
  }

  /** Whether this process is currently generating the summary of one lesson. */
  isGenerating(lessonId: string): boolean {
    return this.inFlight.has(lessonId);
  }

  /**
   * Generates the summary for one ended lesson and returns the refreshed row.
   *
   * A damaged transcript fails the summary without calling the model: the record is the only input,
   * and silently summarizing a partial record would hide the damage. The caller decides whether the
   * lesson is eligible (ended) before calling.
   */
  async generate(lessonId: string, requestId?: string): Promise<LessonEntity> {
    if (this.inFlight.has(lessonId)) {
      throw new LessonSummaryBusyError(lessonId);
    }
    this.inFlight.add(lessonId);
    const startedAt = Date.now();

    try {
      await this.lessons.markSummaryGenerating(lessonId);

      let transcript: string;
      try {
        transcript = formatTranscript(
          await this.lessons.readMessages(lessonId),
          { limit: SUMMARY_MESSAGE_LIMIT, charLimit: SUMMARY_CHAR_LIMIT },
        );
      } catch (error) {
        if (error instanceof LessonCorruptError) {
          return this.lessons.failSummary(
            lessonId,
            '课堂记录损坏，无法生成总结。',
          );
        }
        // Permissions / disk failures are not corruption; do not tell the user to start over.
        await this.lessons.failSummary(lessonId, '总结生成失败，请重试。');
        throw error;
      }

      try {
        const markdown = (
          await this.commonAgent.generate(buildSummaryPrompt(transcript), {
            requestId,
            systemPromptAppend: CLASSROOM_SUMMARY_SYSTEM_PROMPT,
            tools: [],
            loadMemory: false,
            timeoutMs: SUMMARY_TIMEOUT_MS,
          })
        ).trim();
        const lesson = await this.lessons.saveSummary(lessonId, markdown);
        this.logger.log({
          event: 'classroom.summary.completed',
          lessonId,
          summaryChars: Array.from(markdown).length,
          elapsedMs: Date.now() - startedAt,
        });
        return lesson;
      } catch (error) {
        this.logger.error({
          event: 'classroom.summary.failed',
          lessonId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        });
        return this.lessons.failSummary(lessonId, '总结生成失败，请重试。');
      }
    } finally {
      this.inFlight.delete(lessonId);
    }
  }
}
