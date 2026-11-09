import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DataSource, In, type EntityManager } from 'typeorm';
import {
  ConversationsService,
  type ConversationHistoryMessage,
  type RestorableConversationHistory,
} from '../conversations/conversations.service';
import { LlmService, type LlmConversationContext } from '../llm/llm.service';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';
import { SettingsService } from '../settings/settings.service';
import {
  ACTIVE_REHEARSAL_STATUSES,
  DIGEST_SUMMARY_CHARS,
  GENERATE_TIMEOUT_MS,
  MAX_FOLLOW_UPS,
  MAX_TOTAL_QUESTIONS,
  RECONCILE_STALE_MS,
} from './rehearsal.constants';
import {
  renderPriorRehearsalSummaries,
  renderRehearsalDigest,
  renderTranscriptMarkdown,
  readAssessment,
  readPlan,
  readReport,
  type RehearsalDigestItem,
} from './rehearsal-digest';
import {
  parseDecisionResponse,
  parseJsonObject,
  parsePlanResponse,
  parseReportResponse,
  parseSkipResponse,
  type ParsedPlan,
} from './rehearsal-json';
import {
  buildAnswerPrompt,
  buildDrillSystemPrompt,
  buildPlanPrompt,
  buildReportPrompt,
  buildSkipPrompt,
} from './rehearsal-prompts';
import { RehearsalRunRegistry } from './rehearsal-run-registry';
import { RehearsalTurnEntity } from './rehearsal-turn.entity';
import { RehearsalEntity } from './rehearsal.entity';
import type {
  RehearsalDetailView,
  RehearsalEndReason,
  RehearsalListView,
  RehearsalPlan,
  RehearsalPlanUpdate,
  RehearsalProgress,
  RehearsalQuestionView,
  RehearsalReport,
  RehearsalStatus,
  RehearsalSummaryView,
  RehearsalTurnKind,
  RehearsalTurnResultView,
  RehearsalTurnStatus,
  RehearsalTurnView,
} from './rehearsal.types';
import type {
  AnswerRehearsalDto,
  ListRehearsalsQueryDto,
  SkipRehearsalDto,
  StartRehearsalDto,
} from './rehearsals.dto';

/** Default page size for the history list. */
const DEFAULT_LIST_LIMIT = 20;

/** Proves the conversation has something to drill before a model call is made. */
function hasUserAndAssistant(
  history: readonly ConversationHistoryMessage[],
): boolean {
  let hasUser = false;
  let hasAssistant = false;
  for (const message of history) {
    if (message.role === 'user') hasUser = true;
    if (message.role === 'assistant') hasAssistant = true;
    if (hasUser && hasAssistant) return true;
  }
  return false;
}

/** Merges model plan updates into the stored plan without inventing new points. */
function applyPlanUpdates(
  plan: RehearsalPlan,
  updates: readonly RehearsalPlanUpdate[],
): RehearsalPlan {
  if (updates.length === 0) return plan;
  const byId = new Map(updates.map((update) => [update.id, update]));
  return {
    ...plan,
    knowledgePoints: plan.knowledgePoints.map((point) => {
      const update = byId.get(point.id);
      return update
        ? { ...point, status: update.status, note: update.note ?? point.note }
        : point;
    }),
  };
}

/** Builds a deterministic report when there is no evaluated answer to send to the model. */
function buildEvidenceFreeReport(plan: RehearsalPlan | null): RehearsalReport {
  return {
    summary: '本次没有足够的回答证据，无法评估掌握情况。',
    knowledgePointMastery: (plan?.knowledgePoints ?? []).map((point) => ({
      pointId: point.id,
      status: 'unverified',
      evidence: '',
    })),
    strengths: [],
    gaps: ['没有有效回答'],
    suggestions: ['先用自己的话解释核心概念，再开始演练。'],
    recommendedReview: (plan?.knowledgePoints ?? []).map((point) => point.label),
    disclaimer: '本次演练只反映已作答内容，不等于全面掌握。',
  };
}

/** Maps a stored status to the UI's active bucket. */
function isActiveStatus(status: string): boolean {
  return (ACTIVE_REHEARSAL_STATUSES as readonly string[]).includes(status);
}

/** Converts a Date/null into the ISO shape used by the API. */
function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Owns the rehearsal lifecycle, its model calls and the normal-chat digest. */
@Injectable()
export class RehearsalsService {
  private readonly logger = new Logger(RehearsalsService.name);

  /** Injects persistence, conversation history, model generation and the per-rehearsal lock. */
  constructor(
    private readonly dataSource: DataSource,
    private readonly conversations: ConversationsService,
    private readonly llm: LlmService,
    private readonly settings: SettingsService,
    private readonly runs: RehearsalRunRegistry,
  ) {}

  /**
   * Starts one batch: plan from normal history, then persist the first question.
   *
   * The same `startRequestId` replays the existing row. A failed start with no turns is retried
   * in place so a transient provider error does not leave an unusable history entry.
   */
  async start(
    conversationId: string,
    input: StartRehearsalDto,
    logContext: RequestLogContext,
  ): Promise<RehearsalDetailView> {
    const startedAt = Date.now();
    const personaText = input.persona?.trim() || null;
    writeStructuredEvent(this.logger, 'log', 'rehearsal.start.started', {
      ...logContext,
      conversationId,
      hasPersona: Boolean(personaText),
    });

    try {
      await this.reconcileConversation(conversationId, logContext);
      const repository = this.dataSource.getRepository(RehearsalEntity);
      const existing = await repository.findOneBy({
        conversationId,
        startRequestId: input.startRequestId,
      });
      if (existing) {
        if (existing.status === 'failed') {
          const turnCount = await this.dataSource
            .getRepository(RehearsalTurnEntity)
            .countBy({ rehearsalId: existing.id });
          if (turnCount === 0) {
            const active = await repository.findOne({
              where: {
                conversationId,
                status: In([...ACTIVE_REHEARSAL_STATUSES]),
              },
            });
            if (active && active.id !== existing.id) {
              throw new ConflictException('已有进行中的演练，请先完成或结束。');
            }
            let detail: RehearsalDetailView;
            try {
              detail = await this.planAndCreateFirstTurn(
                existing,
                personaText ?? existing.personaText,
                logContext,
              );
            } catch (error) {
              await repository.update(
                { id: existing.id },
                { status: 'failed', endReason: 'failed' },
              );
              throw error;
            }
            writeStructuredEvent(
              this.logger,
              'log',
              'rehearsal.start.completed',
              {
                ...logContext,
                conversationId,
                rehearsalId: existing.id,
                retried: true,
                elapsedMs: Date.now() - startedAt,
              },
            );
            return detail;
          }
        }
        return this.getById(existing.id, logContext);
      }

      const active = await repository.findOne({
        where: {
          conversationId,
          status: In([...ACTIVE_REHEARSAL_STATUSES]),
        },
      });
      if (active) {
        throw new ConflictException('已有进行中的演练，请先完成或结束。');
      }

      const restorable = await this.conversations.getRestorableHistory(
        conversationId,
        undefined,
        logContext,
      );
      if (!hasUserAndAssistant(restorable.history)) {
        throw new UnprocessableEntityException(
          '当前对话还没有足够的学习内容，先聊几轮再开始演练。',
        );
      }

      const rehearsal = repository.create({
        id: randomUUID(),
        conversationId,
        status: 'preparing',
        startRequestId: input.startRequestId,
        personaText,
        contextUpToSequenceNo: restorable.maxSequenceNo,
        planJson: null,
        askedQuestionCount: 0,
        baseQuestionCount: 0,
        skippedCount: 0,
        overallEvaluationJson: null,
        endReason: null,
        startedAt: null,
        endedAt: null,
      });
      try {
        await repository.save(rehearsal);
      } catch (error) {
        writeStructuredEvent(
          this.logger,
          'warn',
          'rehearsal.start.insert.conflict',
          {
            ...logContext,
            conversationId,
            ...getSafeErrorLogFields(error),
          },
        );
        throw new ConflictException('已有进行中的演练，请先完成或结束。');
      }

      let detail: RehearsalDetailView;
      try {
        detail = await this.planAndCreateFirstTurn(
          rehearsal,
          personaText,
          logContext,
          restorable,
        );
      } catch (error) {
        await repository.update(
          { id: rehearsal.id },
          { status: 'failed', endReason: 'failed' },
        );
        throw error;
      }
      writeStructuredEvent(this.logger, 'log', 'rehearsal.start.completed', {
        ...logContext,
        conversationId,
        rehearsalId: rehearsal.id,
        elapsedMs: Date.now() - startedAt,
      });
      return detail;
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        error instanceof HttpException ? 'warn' : 'error',
        'rehearsal.start.failed',
        {
          ...logContext,
          conversationId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    }
  }

  /** Returns the latest rehearsal for a conversation, or null when there is none. */
  async getLatest(
    conversationId: string,
    logContext: RequestLogContext,
  ): Promise<RehearsalDetailView | null> {
    await this.reconcileConversation(conversationId, logContext);
    const rehearsal = await this.dataSource
      .getRepository(RehearsalEntity)
      .findOne({
        where: { conversationId },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
    return rehearsal ? this.getById(rehearsal.id, logContext) : null;
  }

  /** Returns one rehearsal with its ordered turns, reconciling a stale in-flight state first. */
  async getById(
    rehearsalId: string,
    logContext: RequestLogContext,
  ): Promise<RehearsalDetailView> {
    await this.reconcileRehearsal(rehearsalId, logContext);
    const rehearsal = await this.dataSource
      .getRepository(RehearsalEntity)
      .findOneBy({ id: rehearsalId });
    if (!rehearsal) {
      throw new NotFoundException('演练记录不存在。');
    }
    const turns = await this.loadTurns(rehearsalId);
    return this.toDetailView(rehearsal, turns);
  }

  /** Lists a conversation's rehearsal summaries with an opaque id cursor. */
  async list(
    conversationId: string,
    query: ListRehearsalsQueryDto,
    logContext: RequestLogContext,
  ): Promise<RehearsalListView> {
    const startedAt = Date.now();
    const exists = await this.conversations.conversationExists(conversationId);
    if (!exists) {
      throw new NotFoundException('演练记录不存在。');
    }
    await this.reconcileConversation(conversationId, logContext);

    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const repository = this.dataSource.getRepository(RehearsalEntity);
    let cursor: RehearsalEntity | null = null;
    if (query.cursor) {
      cursor = await repository.findOneBy({
        id: query.cursor,
        conversationId,
      });
      if (!cursor) {
        throw new BadRequestException('cursor 不属于当前会话。');
      }
    }

    const builder = repository
      .createQueryBuilder('rehearsal')
      .where('rehearsal.conversationId = :conversationId', { conversationId })
      .orderBy('rehearsal.createdAt', 'DESC')
      .addOrderBy('rehearsal.id', 'DESC')
      .take(limit + 1);

    if (query.status && query.status !== 'all') {
      if (query.status === 'active') {
        builder.andWhere('rehearsal.status IN (:...activeStatuses)', {
          activeStatuses: [...ACTIVE_REHEARSAL_STATUSES],
        });
      } else {
        builder.andWhere('rehearsal.status = :status', {
          status: query.status,
        });
      }
    }
    if (cursor) {
      builder.andWhere(
        '(rehearsal.createdAt < :cursorCreatedAt OR (rehearsal.createdAt = :cursorCreatedAt AND rehearsal.id < :cursorId))',
        {
          cursorCreatedAt: cursor.createdAt,
          cursorId: cursor.id,
        },
      );
    }

    const rows = await builder.getMany();
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit ? page[page.length - 1]?.id ?? null : null;
    const counts = await this.countByStatus(conversationId);
    const result: RehearsalListView = {
      items: page.map((rehearsal) => this.toSummaryView(rehearsal)),
      counts,
      nextCursor,
    };
    writeStructuredEvent(this.logger, 'log', 'rehearsal.list.completed', {
      ...logContext,
      conversationId,
      itemCount: result.items.length,
      hasMore: nextCursor !== null,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  }

  /** Evaluates one answer, enforces limits and either creates the next turn or finishes. */
  async answer(
    rehearsalId: string,
    input: AnswerRehearsalDto,
    logContext: RequestLogContext,
  ): Promise<RehearsalTurnResultView> {
    const lease = this.runs.begin(rehearsalId);
    if (!lease) {
      throw new ConflictException('当前题目正在处理，请稍后重试。');
    }
    const startedAt = Date.now();
    try {
      const rehearsal = await this.requireRehearsal(rehearsalId);
      const turns = await this.loadTurns(rehearsalId);
      const current = turns.find((turn) => turn.id === input.turnId);
      if (!current) {
        throw new ConflictException('当前题目已变化，请刷新后重试。');
      }

      if (current.status === 'evaluated') {
        if (current.answerRequestId !== input.answerRequestId) {
          throw new ConflictException('当前题目已经回答，请刷新后重试。');
        }
        return this.toAnswerResult(rehearsal, turns, current);
      }

      const retryable =
        current.status === 'answer_saved' || current.status === 'failed';
      const sameRequest =
        retryable && current.answerRequestId === input.answerRequestId;
      const sameStoredAnswer = retryable && current.answer === input.answer;
      if (!retryable) {
        if (current.status !== 'awaiting_answer') {
          throw new ConflictException('当前题目不能回答，请刷新后重试。');
        }
        if (rehearsal.status !== 'awaiting_answer') {
          throw new ConflictException('当前演练不处于可回答状态。');
        }
        await this.saveAnswer(rehearsalId, current.id, input);
      } else if (!sameRequest && !sameStoredAnswer) {
        throw new ConflictException('当前题目已有不同的回答，请刷新后重试。');
      } else if (!sameRequest) {
        // A process restart loses the in-memory idempotency key. Re-evaluating the same stored
        // answer with a fresh key is safe because the per-rehearsal lease is the concurrency guard.
        await this.adoptAnswerRequestId(current.id, input.answerRequestId);
      }

      const evaluating = await this.requireRehearsal(rehearsalId);
      const plan = readPlan(evaluating.planJson);
      if (!plan) {
        throw new ConflictException('演练计划不存在，请重新开始。');
      }
      const latestTurns = await this.loadTurns(rehearsalId);
      const answeredTurn =
        latestTurns.find((turn) => turn.id === current.id) ?? current;
      if (!answeredTurn.answer) {
        throw new ConflictException('当前题目没有可评估的回答。');
      }

      let decision;
      try {
        decision = await this.generateValidated(
          buildAnswerPrompt({
            plan,
            turns: latestTurns,
            currentTurn: answeredTurn,
            answer: answeredTurn.answer,
            askedCount: evaluating.askedQuestionCount,
          }),
          parseDecisionResponse,
          {
            systemPromptAppend: buildDrillSystemPrompt(evaluating.personaText),
            requestId: logContext.requestId,
            logContext,
            label: 'answer',
            signal: lease.controller.signal,
          },
        );
      } catch (error) {
        await this.markAnswerEvaluationFailed(rehearsalId, current.id);
        throw this.mapModelError(error);
      }

      const completeByLimit =
        evaluating.askedQuestionCount >= MAX_TOTAL_QUESTIONS;
      const followUp =
        !completeByLimit &&
        decision.action === 'follow_up' &&
        answeredTurn.followUpDepth < MAX_FOLLOW_UPS;
      const nextQuestion = decision.nextQuestion;
      const now = new Date();
      let nextTurn: RehearsalTurnEntity | null = null;

      await this.dataSource.transaction(async (manager) => {
        const turnRepository = manager.getRepository(RehearsalTurnEntity);
        const rehearsalRepository = manager.getRepository(RehearsalEntity);
        const updatedPlan = applyPlanUpdates(plan, decision.planUpdates);
        await turnRepository.update(
          { id: answeredTurn.id },
          {
            evaluationJson: JSON.stringify(decision.assessment),
            status: 'evaluated',
            evaluatedAt: now,
          },
        );

        if (completeByLimit) {
          await rehearsalRepository.update(
            { id: rehearsalId },
            {
              planJson: JSON.stringify(updatedPlan),
              status: 'reporting',
              endReason: 'limit',
            },
          );
          return;
        }

        const nextSequence = await this.nextTurnSequence(manager, rehearsalId);
        nextTurn = turnRepository.create({
          id: randomUUID(),
          rehearsalId,
          sequenceNo: nextSequence,
          kind: followUp ? 'follow_up' : 'base',
          baseSequenceNo: followUp
            ? answeredTurn.baseSequenceNo
            : nextSequence,
          followUpDepth: followUp ? answeredTurn.followUpDepth + 1 : 0,
          pointId: null,
          question: nextQuestion,
          answer: null,
          evaluationJson: null,
          status: 'awaiting_answer',
          answerRequestId: null,
          askedAt: now,
          answeredAt: null,
          evaluatedAt: null,
        });
        await turnRepository.save(nextTurn);
        await rehearsalRepository.update(
          { id: rehearsalId },
          {
            planJson: JSON.stringify(updatedPlan),
            status: 'awaiting_answer',
            askedQuestionCount: evaluating.askedQuestionCount + 1,
            baseQuestionCount:
              evaluating.baseQuestionCount + (followUp ? 0 : 1),
          },
        );
      });

      const finalTurns = await this.loadTurns(rehearsalId);
      const finalRehearsal = await this.requireRehearsal(rehearsalId);
      let report: RehearsalReport | null = null;
      if (completeByLimit) {
        report = await this.finishRehearsal(
          finalRehearsal,
          finalTurns,
          'limit',
          logContext,
          lease.controller.signal,
        );
      }
      writeStructuredEvent(this.logger, 'log', 'rehearsal.answer.completed', {
        ...logContext,
        conversationId: finalRehearsal.conversationId,
        rehearsalId,
        asked: finalRehearsal.askedQuestionCount,
        followUp,
        completed: completeByLimit,
        elapsedMs: Date.now() - startedAt,
      });
      return this.toAnswerResult(
        finalRehearsal,
        finalTurns,
        finalTurns.find((turn) => turn.id === answeredTurn.id) ??
          answeredTurn,
        report,
      );
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        error instanceof HttpException ? 'warn' : 'error',
        'rehearsal.answer.failed',
        {
          ...logContext,
          rehearsalId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    } finally {
      lease.finish();
    }
  }

  /** Skips the current question without evaluating it and generates a new base question. */
  async skip(
    rehearsalId: string,
    input: SkipRehearsalDto,
    logContext: RequestLogContext,
  ): Promise<RehearsalTurnResultView> {
    const lease = this.runs.begin(rehearsalId);
    if (!lease) {
      throw new ConflictException('当前题目正在处理，请稍后重试。');
    }
    const startedAt = Date.now();
    try {
      const rehearsal = await this.requireRehearsal(rehearsalId);
      const turns = await this.loadTurns(rehearsalId);
      const current = turns.find((turn) => turn.id === input.turnId);
      if (!current) {
        throw new ConflictException('当前题目已变化，请刷新后重试。');
      }

      const laterTurn = turns.find(
        (turn) => turn.sequenceNo > current.sequenceNo,
      );
      if (current.status === 'skipped') {
        if (rehearsal.status === 'completed') {
          return this.toCompletedResult(
            rehearsal,
            turns,
            current.id,
            readReport(rehearsal.overallEvaluationJson),
          );
        }
        if (laterTurn) {
          return this.toSkipResult(
            rehearsal,
            turns,
            current.id,
            laterTurn,
          );
        }
        if (
          rehearsal.status !== 'preparing_next' &&
          rehearsal.status !== 'awaiting_answer'
        ) {
          throw new ConflictException('当前演练不处于可跳过状态。');
        }
      } else {
        if (current.status !== 'awaiting_answer') {
          throw new ConflictException('当前题目不能跳过，请刷新后重试。');
        }
        if (rehearsal.status !== 'awaiting_answer') {
          throw new ConflictException('当前演练不处于可跳过状态。');
        }
        await this.dataSource.transaction(async (manager) => {
          await manager
            .getRepository(RehearsalTurnEntity)
            .update({ id: current.id }, { status: 'skipped' });
          await manager.getRepository(RehearsalEntity).update(
            { id: rehearsalId },
            {
              status: 'preparing_next',
              skippedCount: rehearsal.skippedCount + 1,
            },
          );
        });
      }

      const refreshed = await this.requireRehearsal(rehearsalId);
      const latestTurns = await this.loadTurns(rehearsalId);
      if (refreshed.askedQuestionCount >= MAX_TOTAL_QUESTIONS) {
        await this.dataSource
          .getRepository(RehearsalEntity)
          .update(
            { id: rehearsalId },
            { status: 'reporting', endReason: 'limit' },
          );
        const report = await this.finishRehearsal(
          refreshed,
          latestTurns,
          'limit',
          logContext,
          lease.controller.signal,
        );
        return this.toCompletedResult(
          refreshed,
          latestTurns,
          current.id,
          report,
        );
      }

      const plan = readPlan(refreshed.planJson);
      if (!plan) {
        throw new ConflictException('演练计划不存在，请重新开始。');
      }
      let decision;
      try {
        decision = await this.generateValidated(
          buildSkipPrompt({
            plan,
            turns: latestTurns,
            skippedTurn: current,
            askedCount: refreshed.askedQuestionCount,
          }),
          parseSkipResponse,
          {
            systemPromptAppend: buildDrillSystemPrompt(refreshed.personaText),
            requestId: logContext.requestId,
            logContext,
            label: 'skip',
            signal: lease.controller.signal,
          },
        );
      } catch (error) {
        throw this.mapModelError(error);
      }

      const now = new Date();
      let nextTurn: RehearsalTurnEntity | null = null;
      await this.dataSource.transaction(async (manager) => {
        const turnRepository = manager.getRepository(RehearsalTurnEntity);
        const rehearsalRepository = manager.getRepository(RehearsalEntity);
        const updatedPlan = applyPlanUpdates(plan, decision.planUpdates);
        const nextSequence = await this.nextTurnSequence(manager, rehearsalId);
        nextTurn = turnRepository.create({
          id: randomUUID(),
          rehearsalId,
          sequenceNo: nextSequence,
          kind: 'base',
          baseSequenceNo: nextSequence,
          followUpDepth: 0,
          pointId: null,
          question: decision.nextQuestion,
          answer: null,
          evaluationJson: null,
          status: 'awaiting_answer',
          answerRequestId: null,
          askedAt: now,
          answeredAt: null,
          evaluatedAt: null,
        });
        await turnRepository.save(nextTurn);
        await rehearsalRepository.update(
          { id: rehearsalId },
          {
            planJson: JSON.stringify(updatedPlan),
            status: 'awaiting_answer',
            askedQuestionCount: refreshed.askedQuestionCount + 1,
            baseQuestionCount: refreshed.baseQuestionCount + 1,
          },
        );
      });

      const finalTurns = await this.loadTurns(rehearsalId);
      const finalRehearsal = await this.requireRehearsal(rehearsalId);
      writeStructuredEvent(this.logger, 'log', 'rehearsal.skip.completed', {
        ...logContext,
        conversationId: finalRehearsal.conversationId,
        rehearsalId,
        asked: finalRehearsal.askedQuestionCount,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        turnId: current.id,
        assessment: null,
        action: 'next_question',
        question: nextTurn ? this.toQuestionView(nextTurn) : null,
        completed: false,
        report: null,
        progress: this.buildProgress(finalRehearsal, finalTurns),
      };
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        error instanceof HttpException ? 'warn' : 'error',
        'rehearsal.skip.failed',
        {
          ...logContext,
          rehearsalId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    } finally {
      lease.finish();
    }
  }

  /** Ends the rehearsal, aborts an in-flight call and generates the overall report. */
  async end(
    rehearsalId: string,
    logContext: RequestLogContext,
  ): Promise<RehearsalDetailView> {
    const startedAt = Date.now();
    const existing = await this.requireRehearsal(rehearsalId);
    if (existing.status === 'completed') {
      return this.getById(rehearsalId, logContext);
    }
    if (existing.status === 'reporting') {
      throw new ConflictException('报告正在生成，请稍后刷新。');
    }
    const turnsBeforeEnd = await this.loadTurns(rehearsalId);
    if (!turnsBeforeEnd.some((turn) => turn.answer?.trim())) {
      throw new ConflictException('还没有回答任何问题，请确认丢弃这次演练。');
    }

    if (this.runs.isActive(rehearsalId)) {
      this.runs.abort(rehearsalId);
      await this.runs.wait(rehearsalId);
    }
    const lease = this.runs.begin(rehearsalId);
    if (!lease) {
      throw new ConflictException('演练正在处理中，请稍后重试。');
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        const turnRepository = manager.getRepository(RehearsalTurnEntity);
        await turnRepository.update(
          { rehearsalId, status: 'awaiting_answer' },
          { status: 'unanswered' },
        );
        await manager
          .getRepository(RehearsalEntity)
          .update(
            { id: rehearsalId },
            { status: 'reporting', endReason: 'manual' },
          );
      });
      const rehearsal = await this.requireRehearsal(rehearsalId);
      const turns = await this.loadTurns(rehearsalId);
      await this.finishRehearsal(
        rehearsal,
        turns,
        'manual',
        logContext,
        lease.controller.signal,
      );
      writeStructuredEvent(this.logger, 'log', 'rehearsal.end.completed', {
        ...logContext,
        conversationId: rehearsal.conversationId,
        rehearsalId,
        asked: rehearsal.askedQuestionCount,
        elapsedMs: Date.now() - startedAt,
      });
      return this.getById(rehearsalId, logContext);
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        error instanceof HttpException ? 'warn' : 'error',
        'rehearsal.end.failed',
        {
          ...logContext,
          rehearsalId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw this.mapModelError(error);
    } finally {
      lease.finish();
    }
  }

  /** Discards a rehearsal that has no answers; used after the zero-answer end confirmation. */
  async discard(
    rehearsalId: string,
    logContext: RequestLogContext,
  ): Promise<{ rehearsalId: string; discarded: true }> {
    const startedAt = Date.now();
    const repository = this.dataSource.getRepository(RehearsalEntity);
    const existing = await repository.findOneBy({ id: rehearsalId });
    if (!existing) {
      return { rehearsalId, discarded: true };
    }

    if (this.runs.isActive(rehearsalId)) {
      this.runs.abort(rehearsalId);
      await this.runs.wait(rehearsalId);
    }
    const lease = this.runs.begin(rehearsalId);
    if (!lease) {
      throw new ConflictException('演练正在处理中，请稍后重试。');
    }

    try {
      const turns = await this.loadTurns(rehearsalId);
      if (turns.some((turn) => turn.answer?.trim())) {
        throw new ConflictException('已经有回答，请结束演练并生成评估。');
      }
      await this.dataSource.transaction(async (manager) => {
        await manager
          .getRepository(RehearsalTurnEntity)
          .delete({ rehearsalId });
        await manager
          .getRepository(RehearsalEntity)
          .delete({ id: rehearsalId });
      });
      this.removeTranscript(existing);
      writeStructuredEvent(this.logger, 'log', 'rehearsal.discard.completed', {
        ...logContext,
        conversationId: existing.conversationId,
        rehearsalId,
        asked: existing.askedQuestionCount,
        elapsedMs: Date.now() - startedAt,
      });
      return { rehearsalId, discarded: true };
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        error instanceof HttpException ? 'warn' : 'error',
        'rehearsal.discard.failed',
        {
          ...logContext,
          rehearsalId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    } finally {
      lease.finish();
    }
  }

  /**
   * Builds the normal-chat digest for rehearsals that have not been delivered yet.
   *
   * A failure here never blocks the chat turn: the caller logs it and continues without the digest.
   * The caller marks the returned ids as delivered once they enter the context.
   */
  async buildConversationDigest(
    conversationId: string,
    logContext: RequestLogContext,
  ): Promise<{ text: string; refsJson: string | null; rehearsalIds: string[] }> {
    try {
      const items = await this.loadDigestItems(conversationId, {
        undeliveredOnly: true,
      });
      const result = renderRehearsalDigest(items);
      for (const item of items) {
        this.ensureTranscript(item.rehearsal, item.turns);
      }
      const refsJson =
        result.rehearsalIds.length > 0
          ? JSON.stringify({
              rehearsals: {
                rehearsalIds: result.rehearsalIds,
                characters: result.characters,
              },
            })
          : null;
      if (result.text) {
        writeStructuredEvent(
          this.logger,
          'log',
          'rehearsal.digest.completed',
          {
            ...logContext,
            conversationId,
            rehearsalCount: result.rehearsalIds.length,
            characters: result.characters,
          },
        );
      }
      return {
        text: result.text,
        refsJson,
        rehearsalIds: result.rehearsalIds,
      };
    } catch (error) {
      writeStructuredEvent(this.logger, 'warn', 'rehearsal.digest.failed', {
        ...logContext,
        conversationId,
        ...getSafeErrorLogFields(error),
      });
      return { text: '', refsJson: null, rehearsalIds: [] };
    }
  }

  /**
   * Marks rehearsals whose evaluation entered the Pi context, so it is never appended twice.
   *
   * A failed update only logs: the worst case is one duplicated digest on the next turn.
   */
  async markDigestDelivered(
    rehearsalIds: readonly string[],
    logContext: RequestLogContext,
  ): Promise<void> {
    if (rehearsalIds.length === 0) return;
    try {
      await this.dataSource
        .getRepository(RehearsalEntity)
        .update({ id: In([...rehearsalIds]) }, { loadedContext: true });
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'warn',
        'rehearsal.digest.mark_delivered_failed',
        {
          ...logContext,
          rehearsalCount: rehearsalIds.length,
          ...getSafeErrorLogFields(error),
        },
      );
    }
  }

  /** Runs the planning call and writes the first question. */
  private async planAndCreateFirstTurn(
    rehearsal: RehearsalEntity,
    personaText: string | null,
    logContext: RequestLogContext,
    knownHistory?: RestorableConversationHistory,
  ): Promise<RehearsalDetailView> {
    const history =
      knownHistory ??
      (await this.conversations.getRestorableHistory(
        rehearsal.conversationId,
        rehearsal.contextUpToSequenceNo ?? undefined,
        logContext,
      ));
    if (!hasUserAndAssistant(history.history)) {
      throw new UnprocessableEntityException(
        '当前对话还没有足够的学习内容，先聊几轮再开始演练。',
      );
    }
    const prior = await this.loadDigestItems(rehearsal.conversationId);
    const planPrompt = buildPlanPrompt({
      priorSummaries: renderPriorRehearsalSummaries(prior),
      personaText,
    });

    let plan: ParsedPlan;
    try {
      plan = await this.generateValidated(
        planPrompt,
        parsePlanResponse,
        {
          systemPromptAppend: buildDrillSystemPrompt(personaText),
          conversation: {
            id: rehearsal.conversationId,
            history: history.history,
          },
          requestId: logContext.requestId,
          logContext,
          label: 'plan',
        },
      );
    } catch (error) {
      await this.dataSource
        .getRepository(RehearsalEntity)
        .update(
          { id: rehearsal.id },
          { status: 'failed', endReason: 'failed' },
        );
      writeStructuredEvent(this.logger, 'warn', 'rehearsal.plan.failed', {
        ...logContext,
        conversationId: rehearsal.conversationId,
        rehearsalId: rehearsal.id,
        ...getSafeErrorLogFields(error),
      });
      throw this.mapModelError(error);
    }

    const planJson = JSON.stringify({
      ...plan,
      generatedAt: new Date().toISOString(),
    });
    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      const rehearsalRepository = manager.getRepository(RehearsalEntity);
      const turnRepository = manager.getRepository(RehearsalTurnEntity);
      await rehearsalRepository.update(
        { id: rehearsal.id },
        {
          status: 'awaiting_answer',
          personaText,
          contextUpToSequenceNo:
            rehearsal.contextUpToSequenceNo ?? history.maxSequenceNo,
          planJson,
          askedQuestionCount: 1,
          baseQuestionCount: 1,
          skippedCount: 0,
          overallEvaluationJson: null,
          endReason: null,
          startedAt: now,
          endedAt: null,
        },
      );
      await turnRepository.delete({ rehearsalId: rehearsal.id });
      await turnRepository.save(
        turnRepository.create({
          id: randomUUID(),
          rehearsalId: rehearsal.id,
          sequenceNo: 1,
          kind: 'base',
          baseSequenceNo: 1,
          followUpDepth: 0,
          pointId: null,
          question: plan.firstQuestion,
          answer: null,
          evaluationJson: null,
          status: 'awaiting_answer',
          answerRequestId: null,
          askedAt: now,
          answeredAt: null,
          evaluatedAt: null,
        }),
      );
    });

    return this.getById(rehearsal.id, logContext);
  }

  /** Calls the model, parses JSON and retries once with a repair instruction. */
  private async generateValidated<T>(
    prompt: string,
    parse: (value: unknown) => T,
    options: {
      systemPromptAppend: string;
      conversation?: LlmConversationContext;
      requestId?: string;
      logContext: RequestLogContext;
      label: string;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const baseOptions = {
      systemPromptAppend: options.systemPromptAppend,
      tools: [] as readonly string[],
      loadMemory: false,
      timeoutMs: GENERATE_TIMEOUT_MS,
      requestId: options.requestId,
      signal: options.signal,
      ...(options.conversation
        ? { conversation: options.conversation }
        : {}),
    };
    const first = await this.llm.generate(prompt, baseOptions);
    try {
      return parse(parseJsonObject(first));
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'warn',
        'rehearsal.model.json_invalid',
        {
          ...options.logContext,
          label: options.label,
          ...getSafeErrorLogFields(error),
        },
      );
    }

    const repairPrompt = `${prompt}\n\n上一轮输出不是合法 JSON 或字段不完整。请只输出符合要求的 JSON 对象。`;
    const second = await this.llm.generate(repairPrompt, baseOptions);
    try {
      return parse(parseJsonObject(second));
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'error',
        'rehearsal.model.json_invalid',
        {
          ...options.logContext,
          label: options.label,
          ...getSafeErrorLogFields(error),
        },
      );
      throw new UnprocessableEntityException('演练生成结果不完整，请重试。');
    }
  }

  /** Generates and stores the overall report, then writes the transcript. */
  private async finishRehearsal(
    rehearsal: RehearsalEntity,
    turns: readonly RehearsalTurnEntity[],
    endReason: 'manual' | 'limit',
    logContext: RequestLogContext,
    signal?: AbortSignal,
  ): Promise<RehearsalReport> {
    const evaluated = turns.filter((turn) => turn.status === 'evaluated');
    let report: RehearsalReport;
    if (evaluated.length === 0) {
      report = buildEvidenceFreeReport(readPlan(rehearsal.planJson));
    } else {
      const plan = readPlan(rehearsal.planJson);
      if (!plan) {
        await this.dataSource
          .getRepository(RehearsalEntity)
          .update(
            { id: rehearsal.id },
            { status: 'failed', endReason: 'failed' },
          );
        throw new ConflictException('演练计划不存在，无法生成报告。');
      }
      try {
        report = await this.generateValidated(
          buildReportPrompt({ plan, turns, endReason }),
          parseReportResponse,
          {
            systemPromptAppend: buildDrillSystemPrompt(rehearsal.personaText),
            requestId: logContext.requestId,
            logContext,
            label: 'report',
            signal,
          },
        );
      } catch (error) {
        await this.dataSource
          .getRepository(RehearsalEntity)
          .update(
            { id: rehearsal.id },
            { status: 'failed', endReason: 'failed' },
          );
        writeStructuredEvent(this.logger, 'error', 'rehearsal.report.failed', {
          ...logContext,
          conversationId: rehearsal.conversationId,
          rehearsalId: rehearsal.id,
          ...getSafeErrorLogFields(error),
        });
        throw this.mapModelError(error);
      }
    }

    await this.dataSource.getRepository(RehearsalEntity).update(
      { id: rehearsal.id },
      {
        status: 'completed',
        overallEvaluationJson: JSON.stringify(report),
        endReason,
        endedAt: new Date(),
      },
    );
    const completed = await this.requireRehearsal(rehearsal.id);
    this.ensureTranscript(completed, turns, true);
    writeStructuredEvent(this.logger, 'log', 'rehearsal.report.completed', {
      ...logContext,
      conversationId: rehearsal.conversationId,
      rehearsalId: rehearsal.id,
      endReason,
      evaluatedTurnCount: evaluated.length,
    });
    return report;
  }

  /** Replaces a lost idempotency key when re-evaluating the same stored answer. */
  private async adoptAnswerRequestId(
    turnId: string,
    answerRequestId: string,
  ): Promise<void> {
    await this.dataSource
      .getRepository(RehearsalTurnEntity)
      .update(
        { id: turnId },
        { answerRequestId, status: 'answer_saved' },
      );
  }

  /** Saves an answer and moves the rehearsal into evaluating. */
  private async saveAnswer(
    rehearsalId: string,
    turnId: string,
    input: AnswerRehearsalDto,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const turnRepository = manager.getRepository(RehearsalTurnEntity);
      const rehearsalRepository = manager.getRepository(RehearsalEntity);
      const turnResult = await turnRepository.update(
        { id: turnId, status: 'awaiting_answer' },
        {
          answer: input.answer,
          answerRequestId: input.answerRequestId,
          answeredAt: new Date(),
          status: 'answer_saved',
        },
      );
      if (turnResult.affected === 0) {
        throw new ConflictException('当前题目已提交，请刷新后重试。');
      }
      await rehearsalRepository.update(
        { id: rehearsalId },
        { status: 'evaluating' },
      );
    });
  }

  /** Marks an answer evaluation as failed while keeping the submitted answer for retry. */
  private async markAnswerEvaluationFailed(
    rehearsalId: string,
    turnId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(RehearsalTurnEntity)
        .update({ id: turnId }, { status: 'failed' });
      await manager
        .getRepository(RehearsalEntity)
        .update({ id: rehearsalId }, { status: 'awaiting_answer' });
    });
  }

  /** Loads one rehearsal or throws a domain 404. */
  private async requireRehearsal(
    rehearsalId: string,
  ): Promise<RehearsalEntity> {
    const rehearsal = await this.dataSource
      .getRepository(RehearsalEntity)
      .findOneBy({ id: rehearsalId });
    if (!rehearsal) throw new NotFoundException('演练记录不存在。');
    return rehearsal;
  }

  /** Loads turns in display order. */
  private loadTurns(rehearsalId: string): Promise<RehearsalTurnEntity[]> {
    return this.dataSource.getRepository(RehearsalTurnEntity).find({
      where: { rehearsalId },
      order: { sequenceNo: 'ASC' },
    });
  }

  /**
   * Loads completed rehearsals and their turns for digest/summary generation.
   *
   * `undeliveredOnly` serves the normal-chat digest: a rehearsal that already entered the Pi
   * context is never appended again. The drill's own opening plan reads every prior batch, because
   * its summary is prompt material, not delivered context.
   */
  private async loadDigestItems(
    conversationId: string,
    options: { undeliveredOnly?: boolean } = {},
  ): Promise<RehearsalDigestItem[]> {
    const rehearsals = await this.dataSource
      .getRepository(RehearsalEntity)
      .find({
        where: {
          conversationId,
          status: 'completed',
          ...(options.undeliveredOnly ? { loadedContext: false } : {}),
        },
        order: { endedAt: 'DESC', createdAt: 'DESC' },
        take: 3,
      });
    const items: RehearsalDigestItem[] = [];
    for (const rehearsal of rehearsals) {
      items.push({
        rehearsal,
        turns: await this.loadTurns(rehearsal.id),
        transcriptPath: this.transcriptPath(rehearsal),
      });
    }
    return items;
  }

  /** Counts active/completed/failed rehearsals for the history badge. */
  private async countByStatus(
    conversationId: string,
  ): Promise<RehearsalListView['counts']> {
    const rows = await this.dataSource
      .getRepository(RehearsalEntity)
      .createQueryBuilder('rehearsal')
      .select('rehearsal.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('rehearsal.conversationId = :conversationId', { conversationId })
      .groupBy('rehearsal.status')
      .getRawMany<{ status: string; count: string }>();
    const counts = { completed: 0, active: 0, failed: 0 };
    for (const row of rows) {
      const count = Number(row.count);
      if (row.status === 'completed') counts.completed += count;
      else if (row.status === 'failed') counts.failed += count;
      else if (isActiveStatus(row.status)) counts.active += count;
    }
    return counts;
  }

  /** Returns the next turn sequence inside one transaction. */
  private async nextTurnSequence(
    manager: EntityManager,
    rehearsalId: string,
  ): Promise<number> {
    const result = await manager
      .getRepository(RehearsalTurnEntity)
      .createQueryBuilder('turn')
      .select('MAX(turn.sequenceNo)', 'maximum')
      .where('turn.rehearsalId = :rehearsalId', { rehearsalId })
      .getRawOne<{ maximum: number | string | null }>();
    return Number(result?.maximum ?? 0) + 1;
  }

  /** Builds the detail DTO from a row and its turns. */
  private toDetailView(
    rehearsal: RehearsalEntity,
    turns: RehearsalTurnEntity[],
  ): RehearsalDetailView {
    const plan = readPlan(rehearsal.planJson);
    const canAnswer =
      rehearsal.status === 'awaiting_answer' ||
      rehearsal.status === 'evaluating';
    const current = canAnswer
      ? turns.find(
          (turn) =>
            turn.status === 'awaiting_answer' ||
            turn.status === 'answer_saved' ||
            turn.status === 'failed',
        ) ?? null
      : null;
    return {
      rehearsalId: rehearsal.id,
      conversationId: rehearsal.conversationId,
      status: rehearsal.status as RehearsalStatus,
      topic: plan?.topic ?? null,
      persona: rehearsal.personaText,
      plan,
      progress: this.buildProgress(rehearsal, turns),
      currentQuestion: current ? this.toQuestionView(current) : null,
      turns: turns.map((turn) => this.toTurnView(turn)),
      report: readReport(rehearsal.overallEvaluationJson),
      endReason: (rehearsal.endReason as RehearsalEndReason | null) ?? null,
      startedAt: toIso(rehearsal.startedAt),
      endedAt: toIso(rehearsal.endedAt),
      createdAt: rehearsal.createdAt.toISOString(),
    };
  }

  /** Builds one history-list row without loading turns. */
  private toSummaryView(rehearsal: RehearsalEntity): RehearsalSummaryView {
    const plan = readPlan(rehearsal.planJson);
    const report = readReport(rehearsal.overallEvaluationJson);
    return {
      rehearsalId: rehearsal.id,
      status: rehearsal.status as RehearsalStatus,
      topic: plan?.topic ?? null,
      persona: rehearsal.personaText,
      createdAt: rehearsal.createdAt.toISOString(),
      startedAt: toIso(rehearsal.startedAt),
      endedAt: toIso(rehearsal.endedAt),
      endReason: (rehearsal.endReason as RehearsalEndReason | null) ?? null,
      progress: this.buildProgress(rehearsal, []),
      overallSummary: report?.summary
        ? report.summary.slice(0, DIGEST_SUMMARY_CHARS)
        : null,
      hasReport: Boolean(report),
    };
  }

  /** Builds the answer/skip response from the current turn and optional next turn. */
  private toAnswerResult(
    rehearsal: RehearsalEntity,
    turns: RehearsalTurnEntity[],
    turn: RehearsalTurnEntity,
    report?: RehearsalReport | null,
  ): RehearsalTurnResultView {
    const nextTurn = turns.find(
      (candidate) => candidate.sequenceNo > turn.sequenceNo,
    );
    const completed =
      rehearsal.status === 'completed' || Boolean(report);
    return {
      turnId: turn.id,
      assessment: readAssessment(turn.evaluationJson),
      action: completed
        ? null
        : nextTurn?.kind === 'follow_up'
          ? 'follow_up'
          : 'next_question',
      question: !completed && nextTurn ? this.toQuestionView(nextTurn) : null,
      completed,
      report:
        report ?? readReport(rehearsal.overallEvaluationJson),
      progress: this.buildProgress(rehearsal, turns),
    };
  }

  /** Builds an idempotent skip response that points at the existing replacement question. */
  private toSkipResult(
    rehearsal: RehearsalEntity,
    turns: RehearsalTurnEntity[],
    skipTurnId: string,
    questionTurn: RehearsalTurnEntity,
  ): RehearsalTurnResultView {
    return {
      turnId: skipTurnId,
      assessment: null,
      action: 'next_question',
      question: this.toQuestionView(questionTurn),
      completed: false,
      report: null,
      progress: this.buildProgress(rehearsal, turns),
    };
  }

  /** Builds a completed skip response. */
  private toCompletedResult(
    rehearsal: RehearsalEntity,
    turns: RehearsalTurnEntity[],
    turnId: string,
    report: RehearsalReport | null,
  ): RehearsalTurnResultView {
    return {
      turnId,
      assessment: null,
      action: null,
      question: null,
      completed: true,
      report,
      progress: this.buildProgress(rehearsal, turns),
    };
  }

  /** Maps one stored turn to the API shape. */
  private toTurnView(turn: RehearsalTurnEntity): RehearsalTurnView {
    return {
      turnId: turn.id,
      sequenceNo: turn.sequenceNo,
      baseSequenceNo: turn.baseSequenceNo,
      followUpDepth: turn.followUpDepth,
      kind: turn.kind as RehearsalTurnKind,
      pointId: turn.pointId,
      question: turn.question,
      answer: turn.answer,
      assessment: readAssessment(turn.evaluationJson),
      status: turn.status as RehearsalTurnStatus,
      askedAt: turn.askedAt.toISOString(),
      answeredAt: toIso(turn.answeredAt),
      evaluatedAt: toIso(turn.evaluatedAt),
    };
  }

  /** Maps one turn to the question-only shape. */
  private toQuestionView(turn: RehearsalTurnEntity): RehearsalQuestionView {
    return {
      turnId: turn.id,
      sequenceNo: turn.sequenceNo,
      baseSequenceNo: turn.baseSequenceNo,
      followUpDepth: turn.followUpDepth,
      kind: turn.kind as RehearsalTurnKind,
      text: turn.question,
    };
  }

  /** Builds progress counters; `currentFollowUpDepth` is 0 when no turn is active. */
  private buildProgress(
    rehearsal: RehearsalEntity,
    turns: readonly RehearsalTurnEntity[],
  ): RehearsalProgress {
    const current = turns.find(
      (turn) =>
        turn.status === 'awaiting_answer' ||
        turn.status === 'answer_saved' ||
        turn.status === 'failed',
    );
    return {
      asked: rehearsal.askedQuestionCount,
      limit: MAX_TOTAL_QUESTIONS,
      remaining: Math.max(
        0,
        MAX_TOTAL_QUESTIONS - rehearsal.askedQuestionCount,
      ),
      baseQuestions: rehearsal.baseQuestionCount,
      skipped: rehearsal.skippedCount,
      currentFollowUpDepth: current?.followUpDepth ?? 0,
    };
  }

  /** Reconciles one stale in-flight row when its process-local run is gone. */
  private async reconcileRehearsal(
    rehearsalId: string,
    logContext: RequestLogContext,
  ): Promise<void> {
    if (this.runs.isActive(rehearsalId)) return;
    const repository = this.dataSource.getRepository(RehearsalEntity);
    const rehearsal = await repository.findOneBy({ id: rehearsalId });
    if (!rehearsal) return;
    const stale =
      Date.now() - rehearsal.updatedAt.getTime() >= RECONCILE_STALE_MS;
    let nextStatus: RehearsalStatus | null = null;
    let endReason: RehearsalEndReason | null = rehearsal.endReason as
      | RehearsalEndReason
      | null;
    if (rehearsal.status === 'evaluating' || rehearsal.status === 'preparing_next') {
      // Answer/skip calls hold a lease. No active run therefore means the previous process
      // died; restore the saved question immediately so a restart can show/retry it.
      nextStatus = 'awaiting_answer';
    } else if (rehearsal.status === 'reporting') {
      // End and the limit path hold a lease; no active run means the report call died.
      nextStatus = 'failed';
      endReason = 'failed';
    } else if (rehearsal.status === 'preparing') {
      // Start does not hold a lease; wait long enough for a legitimate planning call.
      if (!stale) return;
      nextStatus = 'failed';
      endReason = 'failed';
    }
    if (!nextStatus) return;
    await repository.update(
      { id: rehearsalId },
      { status: nextStatus, endReason },
    );
    writeStructuredEvent(this.logger, 'warn', 'rehearsal.reconciled', {
      ...logContext,
      rehearsalId,
      previousStatus: rehearsal.status,
      nextStatus,
      endReason,
    });
  }

  /** Reconciles stale active rows for one conversation before reading or starting. */
  private async reconcileConversation(
    conversationId: string,
    logContext: RequestLogContext,
  ): Promise<void> {
    const rows = await this.dataSource.getRepository(RehearsalEntity).find({
      where: {
        conversationId,
        status: In([...ACTIVE_REHEARSAL_STATUSES]),
      },
    });
    for (const row of rows) {
      await this.reconcileRehearsal(row.id, logContext);
    }
  }

  /** Removes a discarded rehearsal's transcript; failure is logged and does not block deletion. */
  private removeTranscript(rehearsal: RehearsalEntity): void {
    try {
      rmSync(this.transcriptPath(rehearsal), { force: true });
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'warn',
        'rehearsal.transcript.remove_failed',
        {
          conversationId: rehearsal.conversationId,
          rehearsalId: rehearsal.id,
          ...getSafeErrorLogFields(error),
        },
      );
    }
  }

  /** Writes the transcript when missing, or when forced after a report update; errors never fail the report. */
  private ensureTranscript(
    rehearsal: RehearsalEntity,
    turns: readonly RehearsalTurnEntity[],
    force = false,
  ): void {
    try {
      const path = this.transcriptPath(rehearsal);
      if (!force && existsSync(path)) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        renderTranscriptMarkdown(rehearsal, turns),
        'utf8',
      );
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'warn',
        'rehearsal.transcript.failed',
        {
          conversationId: rehearsal.conversationId,
          rehearsalId: rehearsal.id,
          ...getSafeErrorLogFields(error),
        },
      );
    }
  }

  /** Returns the transcript path under the conversation session directory. */
  private transcriptPath(rehearsal: RehearsalEntity): string {
    return join(
      this.settings.getSessionDirectory(rehearsal.conversationId),
      'rehearsals',
      `${rehearsal.id}.md`,
    );
  }

  /** Maps model/provider failures to stable HTTP errors without leaking provider text. */
  private mapModelError(error: unknown): HttpException {
    if (error instanceof HttpException) return error;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('timed out')) {
      return new GatewayTimeoutException('演练生成超时，请重试。');
    }
    if (message.includes('cancelled')) {
      return new ConflictException('演练已结束或已取消。');
    }
    return new BadGatewayException('模型服务暂不可用，请重试。');
  }
}
