import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
} from '../logging/structured-logger';
import {
  AnswerRehearsalDto,
  ListRehearsalsQueryDto,
  SaveRehearsalPersonaDto,
  SkipRehearsalDto,
  StartRehearsalDto,
} from './rehearsals.dto';
import { RehearsalsService } from './rehearsals.service';
import type {
  RehearsalDetailView,
  RehearsalListView,
  RehearsalPreparingView,
  RehearsalTurnResultView,
} from './rehearsal.types';

/** Exposes conversation-scoped rehearsal start, latest and history reads. */
@Controller('conversations/:conversationId/rehearsals')
export class ConversationRehearsalsController {
  private readonly logger = new Logger(ConversationRehearsalsController.name);

  /** Injects the rehearsal domain service. */
  constructor(private readonly rehearsals: RehearsalsService) {}

  /** Starts one batch from the current conversation history. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async start(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
    @Body() input: StartRehearsalDto,
  ): Promise<RehearsalDetailView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    writeStructuredEvent(
      this.logger,
      'log',
      'rehearsal.http.start.accepted',
      { requestId, conversationId },
    );
    try {
      const result = await this.rehearsals.start(conversationId, input, {
        requestId,
        conversationId,
      });
      writeStructuredEvent(
        this.logger,
        'log',
        'rehearsal.http.start.completed',
        {
          requestId,
          conversationId,
          rehearsalId: result.rehearsalId,
          elapsedMs: Date.now() - startedAt,
        },
      );
      return result;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'rehearsal.http.start.failed', {
        requestId,
        conversationId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Returns the read-only phase of an in-flight start; null when nothing is preparing. */
  @Get('preparing')
  preparing(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
  ): RehearsalPreparingView | null {
    return this.rehearsals.getPreparingPhase(conversationId);
  }

  /** Returns the latest rehearsal for the conversation, or null. */
  @Get('latest')
  latest(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
  ): Promise<RehearsalDetailView | null> {
    const requestId = randomUUID();
    return this.rehearsals.getLatest(conversationId, {
      requestId,
      conversationId,
    });
  }

  /** Returns one paginated history page without turns or full reports. */
  @Get()
  list(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
    @Query() query: ListRehearsalsQueryDto,
  ): Promise<RehearsalListView> {
    const requestId = randomUUID();
    return this.rehearsals.list(conversationId, query, {
      requestId,
      conversationId,
    });
  }
}

/** Exposes one rehearsal's detail, answers, skip and end actions. */
@Controller('rehearsals')
export class RehearsalsController {
  private readonly logger = new Logger(RehearsalsController.name);

  /** Injects the rehearsal domain service. */
  constructor(private readonly rehearsals: RehearsalsService) {}

  /** Returns one rehearsal with turns and report for session/report/history views. */
  @Get(':rehearsalId')
  get(
    @Param('rehearsalId', new ParseUUIDPipe({ version: '4' }))
    rehearsalId: string,
  ): Promise<RehearsalDetailView> {
    const requestId = randomUUID();
    return this.rehearsals.getById(rehearsalId, { requestId, rehearsalId });
  }

  /** Evaluates one answer and returns the next question or the final report. */
  @Post(':rehearsalId/answers')
  @HttpCode(HttpStatus.OK)
  async answer(
    @Param('rehearsalId', new ParseUUIDPipe({ version: '4' }))
    rehearsalId: string,
    @Body() input: AnswerRehearsalDto,
  ): Promise<RehearsalTurnResultView> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      return await this.rehearsals.answer(rehearsalId, input, {
        requestId,
        rehearsalId,
      });
    } finally {
      writeStructuredEvent(this.logger, 'log', 'rehearsal.http.answer.finished', {
        requestId,
        rehearsalId,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  /** Skips the current question and returns a new base question. */
  @Post(':rehearsalId/skip')
  @HttpCode(HttpStatus.OK)
  skip(
    @Param('rehearsalId', new ParseUUIDPipe({ version: '4' }))
    rehearsalId: string,
    @Body() input: SkipRehearsalDto,
  ): Promise<RehearsalTurnResultView> {
    const requestId = randomUUID();
    return this.rehearsals.skip(rehearsalId, input, {
      requestId,
      rehearsalId,
    });
  }

  /** Ends the rehearsal early and returns the generated report. */
  @Post(':rehearsalId/end')
  @HttpCode(HttpStatus.OK)
  end(
    @Param('rehearsalId', new ParseUUIDPipe({ version: '4' }))
    rehearsalId: string,
  ): Promise<RehearsalDetailView> {
    const requestId = randomUUID();
    return this.rehearsals.end(rehearsalId, {
      requestId,
      rehearsalId,
    });
  }

  /** Discards a rehearsal with no answers after the user confirms ending. */
  @Delete(':rehearsalId')
  @HttpCode(HttpStatus.OK)
  discard(
    @Param('rehearsalId', new ParseUUIDPipe({ version: '4' }))
    rehearsalId: string,
  ): Promise<{ rehearsalId: string; discarded: true }> {
    const requestId = randomUUID();
    return this.rehearsals.discard(rehearsalId, {
      requestId,
      rehearsalId,
    });
  }
}

/**
 * Exposes the student persona shared by every conversation's drill.
 *
 * It is a single local text file, not per-rehearsal state, so these routes carry no conversation id
 * and stay outside the `:rehearsalId` route space.
 */
@Controller('rehearsal-persona')
export class RehearsalPersonaController {
  private readonly logger = new Logger(RehearsalPersonaController.name);

  /** Injects the rehearsal domain service that owns the persona file. */
  constructor(private readonly rehearsals: RehearsalsService) {}

  /** Reads the saved persona; a missing file returns an empty string. */
  @Get()
  get(): Promise<{ persona: string }> {
    return this.rehearsals.getPersona();
  }

  /** Replaces the saved persona; an empty string clears it. */
  @Put()
  save(@Body() input: SaveRehearsalPersonaDto): Promise<{ persona: string }> {
    const requestId = randomUUID();
    writeStructuredEvent(this.logger, 'log', 'rehearsal.persona.save.accepted', {
      requestId,
      characters: input.persona.trim().length,
    });
    return this.rehearsals.savePersona(input.persona, { requestId });
  }
}
