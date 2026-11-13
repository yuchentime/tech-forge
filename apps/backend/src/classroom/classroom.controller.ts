import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { getSafeErrorLogFields, writeStructuredEvent } from '../logging/structured-logger';
import {
  LessonCorruptError,
  LessonEndedError,
  LessonNotFoundError,
  LessonStillActiveError,
} from '../lessons/lesson.errors';
import type {
  LessonMessagesView,
  LessonMessageView,
} from '../lessons/lesson-message-view';
import {
  OK_INTEGRITY,
  toIntegrity,
  toLessonMessageView,
} from '../lessons/lesson-message-view';
import type {
  LessonListView,
  LessonSummaryView,
  LessonView,
} from '../lessons/lesson-view';
import {
  readLessonStatus,
  toLessonListEntry,
  toLessonSummaryView,
  toLessonView,
} from '../lessons/lesson-view';
import { LessonsService } from '../lessons/lessons.service';
import { ClassroomTurnError } from '../llm/turn-errors';
import {
  ClassroomSummariesAgent,
  LessonSummaryBusyError,
} from '../llm/agents/ClassroomSummariesAgent';
import { ListLessonsQueryDto, SendLessonTurnDto } from './classroom.dto';
import {
  ClassroomTurnsService,
  LessonTurnBusyError,
} from './classroom-turns.service';

/**
 * Exposes classroom lessons to the desktop UI: open/end, landing list, transcript, turns and summary.
 *
 * The controller only validates, maps domain errors to HTTP, and delegates. The global token hook
 * in `main.ts` protects every route.
 */
@Controller('lessons')
export class ClassroomController {
  private readonly logger = new Logger(ClassroomController.name);

  constructor(
    private readonly lessons: LessonsService,
    private readonly summaries: ClassroomSummariesAgent,
    private readonly turns: ClassroomTurnsService,
  ) {}

  /**
   * Starts a new classroom: closes the previous active lesson and creates a new one.
   *
   * Always returns a new id, so the stage's "start a new classroom" recovery actually leaves a
   * damaged record. The closed lesson stays in the history list.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createLesson(): Promise<LessonView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const lesson = await this.lessons.startNewLesson();
      this.logger.log({
        event: 'classroom.lesson.created',
        requestId,
        lessonId: lesson.id,
        elapsedMs: Date.now() - startedAt,
      });
      return toLessonView(lesson);
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'classroom.lesson.create.failed', {
        requestId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Ends a lesson. Ending an already-ended lesson is a no-op, so the UI can retry safely. */
  @Post(':lessonId/end')
  @HttpCode(HttpStatus.OK)
  async endLesson(
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<LessonView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const lesson = await this.lessons.findLesson(lessonId);
      if (!lesson) {
        throw new NotFoundException('课堂不存在。');
      }
      const ended = await this.lessons.endLesson(lessonId);
      this.logger.log({
        event: 'classroom.lesson.ended',
        requestId,
        lessonId,
        elapsedMs: Date.now() - startedAt,
      });
      return toLessonView(ended);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      writeStructuredEvent(this.logger, 'error', 'classroom.lesson.end.failed', {
        requestId,
        lessonId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Deletes one history lesson: its row, summary and transcript directory. */
  @Delete(':lessonId')
  @HttpCode(HttpStatus.OK)
  async deleteLesson(
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<{ lessonId: string }> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const lesson = await this.lessons.findLesson(lessonId);
      if (!lesson) {
        throw new NotFoundException('课堂不存在。');
      }
      if (lesson.status === 'active') {
        throw new ConflictException('进行中的课堂不能删除，请先结束课堂。');
      }
      if (this.summaries.isGenerating(lessonId)) {
        throw new ConflictException('总结正在生成，请稍后再删除。');
      }
      await this.lessons.deleteLesson(lessonId);
      this.logger.log({
        event: 'classroom.lesson.deleted',
        requestId,
        lessonId,
        elapsedMs: Date.now() - startedAt,
      });
      return { lessonId };
    } catch (error) {
      if (error instanceof LessonStillActiveError) {
        throw new ConflictException('进行中的课堂不能删除，请先结束课堂。');
      }
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      writeStructuredEvent(this.logger, 'error', 'classroom.lesson.delete.failed', {
        requestId,
        lessonId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Returns recent lessons for the classroom landing page, newest first. */
  @Get()
  async listLessons(
    @Query() query: ListLessonsQueryDto,
  ): Promise<LessonListView> {
    const lessons = await this.lessons.listLessons({
      status: query.status,
      limit: query.limit ?? 30,
    });
    return { lessons: lessons.map(toLessonListEntry) };
  }

  /**
   * Runs one classroom turn: append the teacher's text, pick a student, append their reply.
   *
   * The response is the full transcript after the turn (same shape as the read endpoint), so the
   * UI can replace its list without a second request. A second concurrent turn for the same lesson
   * is rejected with 409 instead of being queued.
   */
  @Post(':lessonId/turns')
  @HttpCode(HttpStatus.OK)
  async sendTurn(
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
    @Body() body: SendLessonTurnDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LessonMessagesView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    // A closed connection must abort the provider run; otherwise the lesson lock outlives the UI.
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    reply.raw.once('close', onClose);
    try {
      const lesson = await this.lessons.findLesson(lessonId);
      if (!lesson) {
        throw new NotFoundException('课堂不存在。');
      }
      if (lesson.status !== 'active') {
        throw new ConflictException('课堂已结束，不能继续发言。');
      }
      const text = body.text.trim();
      if (!text) {
        throw new BadRequestException('讲解内容不能为空。');
      }

      const result = await this.turns.runTurn(lessonId, text, {
        requestId,
        signal: abort.signal,
      });
      this.logger.log({
        event: 'classroom.turn.completed',
        requestId,
        lessonId,
        messageCount: result.messages.length,
        elapsedMs: Date.now() - startedAt,
      });
      // The turn read the transcript strictly before appending, so it is known to be clean.
      return {
        lessonId,
        status: readLessonStatus(lesson.status),
        integrity: OK_INTEGRITY,
        messages: result.messages.map(toLessonMessageView),
      };
    } catch (error) {
      if (error instanceof LessonTurnBusyError) {
        throw new ConflictException('这一轮还没结束，请稍候。');
      }
      if (error instanceof LessonNotFoundError) {
        throw new NotFoundException('课堂不存在。');
      }
      if (error instanceof LessonEndedError) {
        throw new ConflictException('课堂已结束，不能继续发言。');
      }
      if (error instanceof LessonCorruptError) {
        throw new ConflictException('课堂记录损坏，请开始新课堂。');
      }
      if (error instanceof ClassroomTurnError) {
        writeStructuredEvent(this.logger, 'error', 'classroom.turn.failed', {
          requestId,
          lessonId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error.original),
        });
        // The provider's text is diagnostic only; the UI gets a stable, retryable message.
        throw new BadGatewayException('学生回应失败，请重试。');
      }
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      writeStructuredEvent(this.logger, 'error', 'classroom.turn.failed', {
        requestId,
        lessonId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  }

  /** Returns one lesson's transcript with each line attributed to its speaker. */
  @Get(':lessonId/messages')
  async listMessages(
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<LessonMessagesView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const lesson = await this.lessons.findLesson(lessonId);
      if (!lesson) {
        throw new NotFoundException('课堂不存在。');
      }

      const transcript = await this.lessons.readTranscript(lessonId);
      const messages: LessonMessageView[] = transcript.messages.map(
        toLessonMessageView,
      );

      this.logger.log({
        event: 'classroom.messages.listed',
        requestId,
        lessonId,
        status: lesson.status,
        messageCount: messages.length,
        corruptLineCount: transcript.corruptLineNumbers.length,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        lessonId: lesson.id,
        status: readLessonStatus(lesson.status),
        integrity: {
          status:
            transcript.corruptLineNumbers.length > 0 ? 'degraded' : 'ok',
          corruptLineCount: transcript.corruptLineNumbers.length,
          corruptLineNumbers: transcript.corruptLineNumbers,
        },
        messages,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      writeStructuredEvent(
        this.logger,
        'error',
        'classroom.messages.list.failed',
        {
          requestId,
          lessonId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    }
  }

  /** Returns the stored summary and its generation status. */
  @Get(':lessonId/summary')
  async getSummary(
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<LessonSummaryView> {
    const lesson = await this.lessons.findLesson(lessonId);
    if (!lesson) {
      throw new NotFoundException('课堂不存在。');
    }
    return toLessonSummaryView(lesson);
  }

  /**
   * Generates (or regenerates) the summary of one ended lesson.
   *
   * A model failure is not an HTTP failure: the response carries `summaryStatus: "failed"` with a
   * user-safe reason, because the classroom itself is still readable and the UI can retry.
   */
  @Post(':lessonId/summary')
  @HttpCode(HttpStatus.OK)
  async generateSummary(
    @Param('lessonId', new ParseUUIDPipe()) lessonId: string,
  ): Promise<LessonSummaryView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const lesson = await this.lessons.findLesson(lessonId);
      if (!lesson) {
        throw new NotFoundException('课堂不存在。');
      }
      if (lesson.status !== 'ended') {
        throw new ConflictException('课堂尚未结束，不能生成总结。');
      }
      const updated = await this.summaries.generate(lessonId, requestId);
      this.logger.log({
        event: 'classroom.summary.requested',
        requestId,
        lessonId,
        summaryStatus: updated.summaryStatus,
        elapsedMs: Date.now() - startedAt,
      });
      return toLessonSummaryView(updated);
    } catch (error) {
      if (error instanceof LessonSummaryBusyError) {
        throw new ConflictException('总结正在生成，请稍候。');
      }
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      writeStructuredEvent(
        this.logger,
        'error',
        'classroom.summary.request.failed',
        {
          requestId,
          lessonId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    }
  }
}
