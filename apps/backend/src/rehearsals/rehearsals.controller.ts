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
import { ConversationsService } from '../conversations/conversations.service';
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
  KnowledgeCardView,
  KnowledgeCardsView,
} from './rehearsal.types';

const KNOWLEDGE_CARD_MOCKS: readonly NonNullable<KnowledgeCardView['fact']>[] = [
  {
    summary:
      '能结合实际场景说明 Redis 的用途；选择方案时，还可以补充适用边界和取舍理由。',
    knowledgePointDetails: [
      {
        name: 'Redis 应用场景',
        masteryLevel: 'needs_improvement',
        evidenceStatus: 'sufficient',
        details:
          '能说明 Redis 常用于缓存、计数和短期状态保存；选择方案时对适用边界的说明还不够充分。',
        changeDescription: '本次为 mock 评估，没有纵向变化结论。',
        lastAssessedAt: '2026-11-09T10:00:00.000Z',
        evidenceRefs: [],
      },
    ],
    tags: ['Redis', '应用场景'],
    masteryLevel: 'needs_improvement',
    generationStatus: 'completed',
    lastError: null,
    generatedAt: '2026-11-09T10:05:00.000Z',
    createdAt: '2026-11-09T10:05:00.000Z',
    updatedAt: '2026-11-09T10:05:00.000Z',
  },
  {
    summary:
      '能够说明主要机制，也能联系常见场景；个别细节还可以再梳理。',
    knowledgePointDetails: [
      {
        name: 'Redis 实现原理',
        masteryLevel: 'basic',
        evidenceStatus: 'sufficient',
        details:
          '对 Redis 的内存存储和单线程命令处理等核心概念已有基本认识。',
        changeDescription:
          '可以继续梳理持久化方式、过期键处理及其在高并发场景下的影响。',
        lastAssessedAt: '2026-11-08T10:00:00.000Z',
        evidenceRefs: [],
      },
    ],
    tags: ['Redis', '实现原理'],
    masteryLevel: 'basic',
    generationStatus: 'completed',
    lastError: null,
    generatedAt: '2026-11-08T10:05:00.000Z',
    createdAt: '2026-11-08T10:05:00.000Z',
    updatedAt: '2026-11-08T10:05:00.000Z',
  },
  {
    summary:
      '能清楚说明消息队列的核心用途，并联系实际例子解释其价值。',
    knowledgePointDetails: [
      {
        name: '消息队列的作用',
        masteryLevel: 'proficient',
        evidenceStatus: 'sufficient',
        details:
          '能结合异步解耦、削峰填谷和消息缓冲解释消息队列解决的问题。',
        changeDescription:
          '能够说明生产者、消费者与队列之间的关系；可继续比较不同投递语义和消费失败处理。',
        lastAssessedAt: '2026-11-07T10:00:00.000Z',
        evidenceRefs: [],
      },
    ],
    tags: ['消息队列', '核心概念'],
    masteryLevel: 'proficient',
    generationStatus: 'completed',
    lastError: null,
    generatedAt: '2026-11-07T10:05:00.000Z',
    createdAt: '2026-11-07T10:05:00.000Z',
    updatedAt: '2026-11-07T10:05:00.000Z',
  },
];

const KNOWLEDGE_CARD_STATUS_ORDER = {
  needs_improvement: 0,
  basic: 1,
  proficient: 2,
} as const;

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

/** Exposes rehearsal actions, detail reads, and the mock knowledge-profile card contract. */
@Controller('rehearsals')
export class RehearsalsController {
  private readonly logger = new Logger(RehearsalsController.name);

  /** Injects rehearsal use cases and the existing read-only conversation summary service. */
  constructor(
    private readonly rehearsals: RehearsalsService,
    private readonly conversations: ConversationsService,
  ) {}

  /** Returns mock fact responses associated with current conversations for the profile grid. */
  @Get('knowledge-cards')
  async getKnowledgeCards(): Promise<KnowledgeCardsView> {
    const conversations = await this.conversations.listConversations({
      requestId: randomUUID(),
    });

    // Fixed evaluation fixtures make the fact response usable before assessment aggregation exists.
    // Only real conversations are included so every item can navigate to an existing session.
    const items: KnowledgeCardView[] = conversations.map((conversation, index) => ({
      conversationId: conversation.id,
      fact: KNOWLEDGE_CARD_MOCKS[index % KNOWLEDGE_CARD_MOCKS.length]!,
    }));

    return { items: this.sortKnowledgeCards(items) };
  }

  /** Orders by mastery priority, then by the latest evidenced assessment timestamp. */
  private sortKnowledgeCards(items: KnowledgeCardView[]): KnowledgeCardView[] {
    return [...items].sort((left, right) => {
      const leftLevel = left.fact?.masteryLevel;
      const rightLevel = right.fact?.masteryLevel;
      const leftRank = leftLevel ? KNOWLEDGE_CARD_STATUS_ORDER[leftLevel] : 3;
      const rightRank = rightLevel ? KNOWLEDGE_CARD_STATUS_ORDER[rightLevel] : 3;
      if (leftRank !== rightRank) return leftRank - rightRank;

      const leftAssessedAt = this.latestAssessmentTimestamp(left);
      const rightAssessedAt = this.latestAssessmentTimestamp(right);
      if (leftAssessedAt === rightAssessedAt) return 0;
      return rightAssessedAt > leftAssessedAt ? 1 : -1;
    });
  }

  /** Returns the newest valid knowledge-point assessment timestamp, or negative infinity. */
  private latestAssessmentTimestamp(item: KnowledgeCardView): number {
    const timestamps = item.fact?.knowledgePointDetails
      ?.map((point) =>
        point.lastAssessedAt ? Date.parse(point.lastAssessedAt) : Number.NaN,
      )
      .filter(Number.isFinite);
    return timestamps?.length ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
  }

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

  /** Discards a rehearsal with no answers after the zero-answer end confirmation. */
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

  /** Deletes a finished rehearsal together with its report, turns and transcript. */
  @Delete(':rehearsalId/report')
  @HttpCode(HttpStatus.OK)
  deleteReport(
    @Param('rehearsalId', new ParseUUIDPipe({ version: '4' }))
    rehearsalId: string,
  ): Promise<{ rehearsalId: string; deleted: true }> {
    const requestId = randomUUID();
    return this.rehearsals.deleteReport(rehearsalId, {
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
