import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ConversationEntity } from '../conversations/conversation.entity';
import { LlmService } from '../llm/llm.service';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
} from '../logging/structured-logger';
import {
  buildBudgetedKnowledgeFactsPrompt,
  KnowledgeFactBudgetError,
} from './conversation-knowledge-facts.budget';
import {
  KNOWLEDGE_FACTS_SYSTEM_PROMPT,
} from './conversation-knowledge-facts.prompts';
import type {
  ConversationKnowledgeFactListItem,
  ConversationKnowledgeFactView,
  ConversationKnowledgeFactsListView,
  ConversationKnowledgeFactsView,
  FactEvaluation,
  FactInputSnapshot,
  FactPromptSelection,
  KnowledgeFactContent,
  KnowledgeFactGenerationStatus,
  KnowledgeFactMasteryLevel,
  KnowledgePointDetail,
} from './conversation-knowledge-facts.types';
import {
  KnowledgeFactValidationError,
  parseKnowledgeFactResponse,
} from './conversation-knowledge-facts.validation';
import { ConversationKnowledgeFactEntity } from './conversation-knowledge-fact.entity';
import { GENERATE_TIMEOUT_MS, MAX_GENERATE_ATTEMPTS } from './rehearsal.constants';
import { readPlan, readReport } from './rehearsal-digest';
import { parseJsonObject } from '../llm/model-json';
import { RehearsalEntity } from './rehearsal.entity';
import type { MasteryStatus } from './rehearsal.types';

/** Reports a stored input that cannot be turned into trustworthy evidence. */
class KnowledgeFactInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeFactInputError';
  }
}

/** Statuses accepted from the wire and from the database. */
const GENERATION_STATUSES: readonly KnowledgeFactGenerationStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
];

/** Mastery levels accepted from the wire and from the database. */
const MASTERY_LEVELS: readonly KnowledgeFactMasteryLevel[] = [
  'proficient',
  'basic',
  'needs_improvement',
];

/** Report statuses accepted from stored overall evaluations. */
const MASTERY_STATUSES: readonly MasteryStatus[] = [
  'mastered',
  'partial',
  'weak',
  'unverified',
];

/** Reads a parsed JSON array from a database text column, rejecting corruption. */
function readJsonArray(value: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new KnowledgeFactInputError(`${label} 不是有效 JSON。`);
  }
  if (!Array.isArray(parsed)) {
    throw new KnowledgeFactInputError(`${label} 不是数组。`);
  }
  return parsed;
}

/** Normalizes a persisted date-like value for the API. */
function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Converts a stored report string array into safe model input. */
function readReportStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Truncates an error summary by Unicode code points so the DB value stays bounded. */
function clipLastError(message: string): string {
  const clipped = Array.from(message).slice(0, 500).join('');
  return clipped || '生成失败，已保留上次结果。';
}

/**
 * Owns conversation-level knowledge-fact generation, persistence and reads.
 *
 * Generation is a single-process background worker: one model call at a time, one durable
 * pending/running row per conversation. The row itself is the queue signal, so a crash or a new
 * report arriving mid-call can be recovered without an extra task table.
 */
@Injectable()
export class ConversationKnowledgeFactsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConversationKnowledgeFactsService.name);

  /** Periodic compensation for commits whose wake was lost and releases racing an enqueue. */
  private scanIntervalMs = 5_000;

  /** Coalesces all wakeups and scans into one serialized worker loop. */
  private drainPromise: Promise<void> | null = null;

  private scanTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private currentConversationId: string | null = null;
  private currentController: AbortController | null = null;
  private currentWakeRequested = false;
  private readonly queue: string[] = [];
  private readonly queuedConversationIds = new Set<string>();

  /** Injects persistence and the shared non-streamed model boundary. */
  constructor(
    private readonly dataSource: DataSource,
    private readonly llm: LlmService,
  ) {}

  /** Recovers interrupted runs before accepting work, then starts the compensation scan. */
  async onModuleInit(): Promise<void> {
    await this.recoverInterruptedRuns();
    this.scanTimer = setInterval(() => {
      void this.drain();
    }, this.scanIntervalMs);
    // A backend process should not stay alive only because this timer exists.
    this.scanTimer.unref?.();
    void this.drain();
  }

  /** Stops claiming work and best-effort aborts the current model call for restart recovery. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.scanTimer);
    this.currentController?.abort();
    if (this.drainPromise) {
      // The provider may ignore abort; never let shutdown hang on it.
      const timeout = Promise.withResolvers<void>();
      setTimeout(timeout.resolve, 2_000);
      await Promise.race([
        this.drainPromise.catch(() => undefined),
        timeout.promise,
      ]);
    }
  }

  /**
   * Marks one conversation pending inside the caller's report transaction.
   *
   * Existing published content is preserved; only the signal and the old error are changed.
   * A running row is deliberately downgraded to pending so its in-flight result cannot publish.
   */
  async markPending(
    manager: EntityManager,
    conversationId: string,
  ): Promise<void> {
    const now = new Date();
    await manager
      .createQueryBuilder()
      .insert()
      .into(ConversationKnowledgeFactEntity)
      .values({
        conversationId,
        summary: null,
        knowledgePointDetailsJson: null,
        tagsJson: null,
        masteryLevel: null,
        generationStatus: 'pending',
        lastError: null,
        generatedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .orUpdate(['generationStatus', 'lastError', 'updatedAt'])
      .execute();
  }

  /** Wakes the worker without blocking the report response; failures fall back to the scan. */
  wake(conversationId: string): void {
    if (this.stopped) return;
    if (this.currentConversationId === conversationId) {
      this.currentWakeRequested = true;
      return;
    }
    if (!this.queuedConversationIds.has(conversationId)) {
      this.queuedConversationIds.add(conversationId);
      this.queue.push(conversationId);
    }
    void this.drain();
  }

  /** Waits until the current serialized worker loop has no more work. */
  waitForIdle(): Promise<void> {
    return this.drainPromise ?? Promise.resolve();
  }

  /** Runs one compensation scan; used by the periodic timer and by deterministic tests. */
  async scanPending(): Promise<void> {
    await this.drain();
  }

  /** Reads the conversation and its current fact from one consistent SQLite snapshot. */
  async getForConversation(
    conversationId: string,
  ): Promise<ConversationKnowledgeFactsView> {
    return this.dataSource.transaction(async (manager) => {
      const conversation = await manager.findOne(ConversationEntity, {
        where: { id: conversationId },
      });
      if (!conversation) {
        throw new NotFoundException('没有找到这个会话，它可能已经被删除。');
      }
      const row = await manager.findOne(ConversationKnowledgeFactEntity, {
        where: { conversationId },
      });
      return {
        conversationId,
        fact: row ? this.toView(row) : null,
      };
    });
  }

  /**
   * Returns every stored fact ordered by most recent status/content change.
   *
   * The query selects only list columns; `knowledgePointDetailsJson` never leaves SQLite, so the
   * collection stays cheap even when published details are large.
   */
  async listAll(): Promise<ConversationKnowledgeFactsListView> {
    const rows = await this.dataSource
      .getRepository(ConversationKnowledgeFactEntity)
      .createQueryBuilder('fact')
      .select([
        'fact.conversationId',
        'fact.summary',
        'fact.tagsJson',
        'fact.masteryLevel',
        'fact.generationStatus',
        'fact.lastError',
        'fact.generatedAt',
        'fact.createdAt',
        'fact.updatedAt',
      ])
      .orderBy('fact.updatedAt', 'DESC')
      .addOrderBy('fact.conversationId', 'ASC')
      .getMany();
    return { items: rows.map((row) => this.toListItem(row)) };
  }

  /** Reads the common status/date fields and enforces the published-content state invariant. */
  private readFactEnvelope(row: ConversationKnowledgeFactEntity): {
    generationStatus: KnowledgeFactGenerationStatus;
    lastError: string | null;
    generatedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } {
    const generationStatus = row.generationStatus as KnowledgeFactGenerationStatus;
    if (!GENERATION_STATUSES.includes(generationStatus)) {
      throw new InternalServerErrorException('知识事实状态无法读取。');
    }
    const generatedAt = toIsoString(row.generatedAt);
    const createdAt = toIsoString(row.createdAt);
    const updatedAt = toIsoString(row.updatedAt);
    if (!createdAt || !updatedAt) {
      throw new InternalServerErrorException('知识事实时间无法读取。');
    }

    const lastError =
      generationStatus === 'failed' ? row.lastError?.trim() : null;
    if (generationStatus === 'failed' && !lastError) {
      throw new InternalServerErrorException('知识事实错误状态无法读取。');
    }
    if (
      row.masteryLevel !== null &&
      !MASTERY_LEVELS.includes(row.masteryLevel as KnowledgeFactMasteryLevel)
    ) {
      throw new InternalServerErrorException('知识事实等级损坏，无法读取。');
    }
    if (
      generatedAt === null &&
      (row.summary !== null || row.tagsJson !== null || row.masteryLevel !== null)
    ) {
      throw new InternalServerErrorException('知识事实内容状态不一致。');
    }

    return {
      generationStatus,
      lastError: lastError ?? null,
      generatedAt,
      createdAt,
      updatedAt,
    };
  }

  /** Maps one partial row (no details column) into the collection contract. */
  private toListItem(
    row: ConversationKnowledgeFactEntity,
  ): ConversationKnowledgeFactListItem {
    const envelope = this.readFactEnvelope(row);
    if (envelope.generatedAt === null) {
      return {
        conversationId: row.conversationId,
        summary: null,
        tags: null,
        masteryLevel: null,
        generationStatus: envelope.generationStatus,
        lastError: envelope.lastError,
        generatedAt: null,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
      };
    }
    if (row.summary === null || row.tagsJson === null) {
      throw new InternalServerErrorException('知识事实内容不完整。');
    }

    let tags: unknown[];
    try {
      tags = readJsonArray(row.tagsJson, 'tags');
    } catch {
      throw new InternalServerErrorException('知识事实数据损坏，无法读取。');
    }
    if (!tags.every((tag): tag is string => typeof tag === 'string')) {
      throw new InternalServerErrorException('知识事实标签损坏，无法读取。');
    }

    return {
      conversationId: row.conversationId,
      summary: row.summary,
      tags,
      masteryLevel: row.masteryLevel as KnowledgeFactMasteryLevel | null,
      generationStatus: envelope.generationStatus,
      lastError: envelope.lastError,
      generatedAt: envelope.generatedAt,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
    };
  }

  /** Converts one durable row into the closed single-conversation HTTP contract. */
  private toView(row: ConversationKnowledgeFactEntity): ConversationKnowledgeFactView {
    const envelope = this.readFactEnvelope(row);

    if (envelope.generatedAt === null) {
      if (row.knowledgePointDetailsJson !== null) {
        throw new InternalServerErrorException('知识事实内容状态不一致。');
      }
      return {
        summary: null,
        knowledgePointDetails: null,
        tags: null,
        masteryLevel: null,
        ...envelope,
        generatedAt: null,
      };
    }

    if (
      row.summary === null ||
      row.knowledgePointDetailsJson === null ||
      row.tagsJson === null
    ) {
      throw new InternalServerErrorException('知识事实内容不完整。');
    }

    let details: unknown[];
    let tags: unknown[];
    try {
      details = readJsonArray(row.knowledgePointDetailsJson, 'knowledgePointDetails');
      tags = readJsonArray(row.tagsJson, 'tags');
    } catch {
      throw new InternalServerErrorException('知识事实数据损坏，无法读取。');
    }
    if (!tags.every((tag): tag is string => typeof tag === 'string')) {
      throw new InternalServerErrorException('知识事实标签损坏，无法读取。');
    }

    return {
      summary: row.summary,
      knowledgePointDetails: details as unknown as KnowledgePointDetail[],
      tags,
      masteryLevel: row.masteryLevel as KnowledgeFactMasteryLevel | null,
      ...envelope,
    };
  }

  /** Resets rows left running by a previous process before this one claims anything. */
  private async recoverInterruptedRuns(): Promise<void> {
    const result = await this.dataSource
      .getRepository(ConversationKnowledgeFactEntity)
      .update(
        { generationStatus: 'running' },
        { generationStatus: 'pending', updatedAt: new Date() },
      );
    if (result.affected) {
      writeStructuredEvent(this.logger, 'log', 'knowledge_facts.recovered', {
        recoveredCount: result.affected,
      });
    }
  }

  /** Serializes all worker activity; the promise is installed before the first await. */
  private drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain()
      .catch((error: unknown) => {
        // A scan/claim storage failure must be logged and release the serialized worker; the
        // periodic scan retries only pending rows, so no failed row is retried in a hot loop.
        writeStructuredEvent(
          this.logger,
          'error',
          'knowledge_facts.worker.failed',
          getSafeErrorLogFields(error),
        );
      })
      .finally(() => {
        this.drainPromise = null;
        if (!this.stopped && this.queue.length > 0) void this.drain();
      });
    return this.drainPromise;
  }

  /** Processes queued conversations and pending scans until neither has work. */
  private async runDrain(): Promise<void> {
    while (!this.stopped) {
      const queued = this.queue.shift();
      if (queued) this.queuedConversationIds.delete(queued);
      const conversationId = queued ?? (await this.findNextPendingConversation());
      if (!conversationId) {
        // A wake can land while the scan await is in flight; re-check before exiting.
        if (this.queue.length > 0) continue;
        return;
      }

      this.currentConversationId = conversationId;
      this.currentWakeRequested = false;
      const controller = new AbortController();
      this.currentController = controller;
      let retry = false;
      try {
        retry = await this.processConversation(conversationId, controller.signal);
      } catch (error) {
        // A storage failure must still release the worker and stay visible in logs.
        writeStructuredEvent(
          this.logger,
          'error',
          'knowledge_facts.worker.failed',
          {
            conversationId,
            ...getSafeErrorLogFields(error),
          },
        );
      } finally {
        this.currentController = null;
        this.currentConversationId = null;
      }
      if (this.stopped) return;

      const wakeRequested = this.currentWakeRequested;
      this.currentWakeRequested = false;
      if (retry || wakeRequested) {
        if (!this.queuedConversationIds.has(conversationId)) {
          this.queuedConversationIds.add(conversationId);
          this.queue.push(conversationId);
        }
      }
    }
  }

  /** Finds the oldest pending row so continuous reruns cannot monopolize the worker. */
  private async findNextPendingConversation(): Promise<string | null> {
    const row = await this.dataSource
      .getRepository(ConversationKnowledgeFactEntity)
      .findOne({
        where: { generationStatus: 'pending' },
        order: { updatedAt: 'ASC', conversationId: 'ASC' },
      });
    return row?.conversationId ?? null;
  }

  /**
   * Claims one conversation and reads its input snapshot in the same short transaction.
   *
   * The claim is a conditional update: only `pending` can become `running`, so a second worker
   * (or a previous in-flight call) can never claim or publish the same row concurrently.
   */
  private async claimConversation(
    conversationId: string,
  ): Promise<{
    snapshot: FactInputSnapshot | null;
    snapshotError: Error | null;
  } | null> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(ConversationKnowledgeFactEntity);
      const row = await repository.findOne({ where: { conversationId } });
      if (!row || row.generationStatus !== 'pending') return null;
      const claimed = await repository.update(
        { conversationId, generationStatus: 'pending' },
        {
          generationStatus: 'running',
          lastError: null,
          updatedAt: new Date(),
        },
      );
      if (!claimed.affected) return null;

      try {
        return {
          snapshot: await this.loadSnapshot(manager, conversationId),
          snapshotError: null,
        };
      } catch (error) {
        // Converting this to failed happens after the claim commits, so corrupt stored input cannot
        // leave the row pending forever and retry in a hot loop.
        return {
          snapshot: null,
          snapshotError:
            error instanceof Error ? error : new Error(String(error)),
        };
      }
    });
  }

  /** Loads the previous fact and every completed evaluation in deterministic evidence order. */
  private async loadSnapshot(
    manager: EntityManager,
    conversationId: string,
  ): Promise<FactInputSnapshot> {
    const fact = await manager.findOne(ConversationKnowledgeFactEntity, {
      where: { conversationId },
    });
    const existingFact = fact ? this.readPublishedFact(fact) : null;

    const rehearsals = await manager
      .getRepository(RehearsalEntity)
      .createQueryBuilder('rehearsal')
      .where('rehearsal.conversationId = :conversationId', { conversationId })
      .andWhere('rehearsal.status = :status', { status: 'completed' })
      .orderBy('rehearsal.endedAt', 'ASC')
      .addOrderBy('rehearsal.createdAt', 'ASC')
      .addOrderBy('rehearsal.id', 'ASC')
      .getMany();

    if (rehearsals.length === 0) {
      throw new KnowledgeFactInputError('没有可供归纳的已完成评估。');
    }
    return {
      existingFact,
      evaluations: rehearsals.map((rehearsal) => this.toEvaluation(rehearsal)),
    };
  }

  /** Reads the last published content; a half-written or corrupt row must fail generation. */
  private readPublishedFact(
    row: ConversationKnowledgeFactEntity,
  ): (KnowledgeFactContent & { generatedAt: string }) | null {
    if (row.generatedAt === null) {
      if (
        row.summary !== null ||
        row.knowledgePointDetailsJson !== null ||
        row.tagsJson !== null ||
        row.masteryLevel !== null
      ) {
        throw new KnowledgeFactInputError('事实行内容状态不一致。');
      }
      return null;
    }
    const generatedAt = toIsoString(row.generatedAt);
    if (
      !generatedAt ||
      row.summary === null ||
      row.knowledgePointDetailsJson === null ||
      row.tagsJson === null
    ) {
      throw new KnowledgeFactInputError('旧事实内容不完整。');
    }
    let details: KnowledgePointDetail[];
    let tags: string[];
    try {
      details = readJsonArray(
        row.knowledgePointDetailsJson,
        'knowledgePointDetails',
      ) as unknown as KnowledgePointDetail[];
      tags = readJsonArray(row.tagsJson, 'tags') as unknown as string[];
    } catch {
      throw new KnowledgeFactInputError('旧事实 JSON 损坏。');
    }
    if (!tags.every((tag) => typeof tag === 'string')) {
      throw new KnowledgeFactInputError('旧事实标签损坏。');
    }
    if (
      row.masteryLevel !== null &&
      !MASTERY_LEVELS.includes(row.masteryLevel as KnowledgeFactMasteryLevel)
    ) {
      throw new KnowledgeFactInputError('旧事实等级损坏。');
    }
    return {
      summary: row.summary,
      knowledgePointDetails: details,
      tags,
      masteryLevel: row.masteryLevel as KnowledgeFactMasteryLevel | null,
      generatedAt,
    };
  }

  /** Joins one completed report with its plan labels and validates the stored evidence mapping. */
  private toEvaluation(rehearsal: RehearsalEntity): FactEvaluation {
    const plan = readPlan(rehearsal.planJson);
    if (!plan) {
      throw new KnowledgeFactInputError(
        `演练 ${rehearsal.id} 的计划损坏或缺失。`,
      );
    }
    const report = readReport(rehearsal.overallEvaluationJson);
    if (!report) {
      throw new KnowledgeFactInputError(
        `演练 ${rehearsal.id} 的报告损坏或缺失。`,
      );
    }
    const endedAt = toIsoString(rehearsal.endedAt);
    if (!endedAt) {
      throw new KnowledgeFactInputError(`演练 ${rehearsal.id} 缺少结束时间。`);
    }
    const planPoints = new Map(
      plan.knowledgePoints.map((point) => [point.id, point]),
    );
    const seenPointIds = new Set<string>();
    const knowledgePoints = (report.knowledgePointMastery ?? []).map((entry) => {
      if (!entry || typeof entry.pointId !== 'string') {
        throw new KnowledgeFactInputError(
          `演练 ${rehearsal.id} 的报告知识点映射损坏。`,
        );
      }
      const point = planPoints.get(entry.pointId);
      if (!point) {
        throw new KnowledgeFactInputError(
          `演练 ${rehearsal.id} 的报告引用了计划外的知识点。`,
        );
      }
      if (!MASTERY_STATUSES.includes(entry.status)) {
        throw new KnowledgeFactInputError(
          `演练 ${rehearsal.id} 的报告等级无效。`,
        );
      }
      if (seenPointIds.has(entry.pointId)) {
        throw new KnowledgeFactInputError(
          `演练 ${rehearsal.id} 的报告包含重复知识点。`,
        );
      }
      seenPointIds.add(entry.pointId);
      return {
        pointId: entry.pointId,
        name: point.label,
        status: entry.status,
        evidence: typeof entry.evidence === 'string' ? entry.evidence : '',
      };
    });

    return {
      rehearsalId: rehearsal.id,
      endedAt,
      topic: plan.topic,
      knowledgePoints,
      report: {
        summary: report.summary,
        strengths: readReportStrings(report.strengths),
        gaps: readReportStrings(report.gaps),
        suggestions: readReportStrings(report.suggestions),
        recommendedReview: readReportStrings(report.recommendedReview),
        disclaimer: report.disclaimer,
      },
    };
  }

  /**
   * Calls the model with the largest budgeted evidence window and repairs invalid structure twice.
   *
   * The prompt is built inside `generate` after the provider/model is resolved, so the budget uses
   * the same context window as the actual call. Provider/transport failures are not retried here.
   */
  private async generateContent(
    snapshot: FactInputSnapshot,
    signal: AbortSignal,
    conversationId: string,
  ): Promise<KnowledgeFactContent> {
    const current = snapshot.evaluations[snapshot.evaluations.length - 1];
    if (!current) {
      throw new KnowledgeFactInputError('没有当前评估。');
    }
    let repairNote: string | null = null;

    for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt += 1) {
      let selection: FactPromptSelection | null = null;
      const text = await this.llm.generate('', {
        systemPromptAppend: KNOWLEDGE_FACTS_SYSTEM_PROMPT,
        tools: [],
        timeoutMs: GENERATE_TIMEOUT_MS,
        signal,
        buildPrompt: ({ contextWindow }) => {
          const built = buildBudgetedKnowledgeFactsPrompt({
            contextWindow,
            snapshot,
            current,
          });
          selection = built;
          // Log only shape/metrics: evaluation text and the final prompt stay out of logs.
          writeStructuredEvent(this.logger, 'log', 'knowledge_facts.input.built', {
            conversationId,
            attempt,
            historyCount: built.retainedHistoryCount,
            omittedHistoryCount: built.omittedHistoryCount,
            historyTruncated: built.omittedHistoryCount > 0,
            estimatedTokenUpperBound: built.estimatedTokenUpperBound,
            availableTokens: built.availableTokens,
          });
          if (!repairNote) return built.prompt;
          return (
            `${built.prompt}\n\n上一次输出不符合要求：${repairNote}` +
            '。请重新只输出符合要求的 JSON 对象，不要附加解释或额外字段。'
          );
        },
      });

      try {
        if (!selection) {
          throw new KnowledgeFactValidationError('模型输入没有完成构造。');
        }
        const retained = (selection as FactPromptSelection).retainedHistoryCount;
        const promptEvaluations = snapshot.evaluations.slice(
          snapshot.evaluations.length - 1 - retained,
        );
        return parseKnowledgeFactResponse(parseJsonObject(text), {
          allEvaluations: snapshot.evaluations,
          promptEvaluations,
          existingFact: snapshot.existingFact,
        });
      } catch (error) {
        if (error instanceof KnowledgeFactBudgetError) throw error;
        if (attempt >= MAX_GENERATE_ATTEMPTS) {
          throw error instanceof KnowledgeFactValidationError
            ? error
            : new KnowledgeFactValidationError(
                error instanceof Error ? error.message : String(error),
              );
        }
        repairNote = clipLastError(
          error instanceof Error ? error.message : String(error),
        );
        writeStructuredEvent(
          this.logger,
          'warn',
          'knowledge_facts.output.invalid',
          {
            attempt,
            message: repairNote,
          },
        );
      }
    }

    throw new KnowledgeFactValidationError('模型输出无法通过校验。');
  }

  /** Processes one claimed conversation and reports whether a newer event requires a rerun. */
  private async processConversation(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const claim = await this.claimConversation(conversationId);
    if (!claim) return false;

    if (claim.snapshotError || !claim.snapshot) {
      if (signal.aborted) return false;
      const error = claim.snapshotError ?? new KnowledgeFactInputError('输入快照读取失败。');
      writeStructuredEvent(
        this.logger,
        'error',
        'knowledge_facts.input.failed',
        {
          conversationId,
          ...getSafeErrorLogFields(error),
        },
      );
      return this.finishFailed(conversationId, this.describeFailure(error));
    }

    let content: KnowledgeFactContent;
    try {
      content = await this.generateContent(
        claim.snapshot,
        signal,
        conversationId,
      );
    } catch (error) {
      if (signal.aborted) {
        // Shutdown leaves the durable running row for startup recovery rather than lying "failed".
        return false;
      }
      writeStructuredEvent(
        this.logger,
        'error',
        'knowledge_facts.generation.failed',
        {
          conversationId,
          ...getSafeErrorLogFields(error),
        },
      );
      return this.finishFailed(conversationId, this.describeFailure(error));
    }

    const now = new Date();
    try {
      const published = await this.dataSource
        .getRepository(ConversationKnowledgeFactEntity)
        .update(
          { conversationId, generationStatus: 'running' },
          {
            summary: content.summary,
            knowledgePointDetailsJson: JSON.stringify(
              content.knowledgePointDetails,
            ),
            tagsJson: JSON.stringify(content.tags),
            masteryLevel: content.masteryLevel,
            generationStatus: 'completed',
            lastError: null,
            generatedAt: now,
            updatedAt: now,
          },
        );
      if (!published.affected) {
        return this.isPending(conversationId);
      }
      writeStructuredEvent(
        this.logger,
        'log',
        'knowledge_facts.published',
        {
          conversationId,
          knowledgePointCount: content.knowledgePointDetails.length,
          elapsedUntil: now.toISOString(),
        },
      );
      return false;
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'error',
        'knowledge_facts.publish.failed',
        {
          conversationId,
          ...getSafeErrorLogFields(error),
        },
      );
      // Best effort: if the failure was transient, persist the failed state; if not, the running
      // row is recovered to pending on the next process start.
      return this.finishFailed(
        conversationId,
        '数据库写入失败，已保留上次结果。',
      );
    }
  }

  /** Records a sanitized failure only while the row is still running; pending wins over failure. */
  private async finishFailed(
    conversationId: string,
    message: string,
  ): Promise<boolean> {
    try {
      const result = await this.dataSource
        .getRepository(ConversationKnowledgeFactEntity)
        .update(
          { conversationId, generationStatus: 'running' },
          {
            generationStatus: 'failed',
            lastError: clipLastError(message),
            updatedAt: new Date(),
          },
        );
      if (!result.affected) return this.isPending(conversationId);
      writeStructuredEvent(this.logger, 'warn', 'knowledge_facts.failed', {
        conversationId,
        message: clipLastError(message),
      });
      return false;
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'error',
        'knowledge_facts.failure_write.failed',
        {
          conversationId,
          ...getSafeErrorLogFields(error),
        },
      );
      return false;
    }
  }

  /** Returns true when a newer report already set pending while the previous call was running. */
  private async isPending(conversationId: string): Promise<boolean> {
    try {
      const row = await this.dataSource
        .getRepository(ConversationKnowledgeFactEntity)
        .findOne({ where: { conversationId } });
      return row?.generationStatus === 'pending';
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'error',
        'knowledge_facts.state_read.failed',
        {
          conversationId,
          ...getSafeErrorLogFields(error),
        },
      );
      return false;
    }
  }

  /** Maps internal failures to bounded user-facing text without provider or SQL detail. */
  private describeFailure(error: unknown): string {
    if (error instanceof KnowledgeFactBudgetError) {
      return '模型上下文预算不足，已保留上次结果。';
    }
    if (error instanceof KnowledgeFactInputError) {
      return '历史评估数据不完整，已保留上次结果。';
    }
    if (error instanceof KnowledgeFactValidationError) {
      return '模型输出未通过校验，已保留上次结果。';
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out|timeout/i.test(message)) {
      return '生成超时，已保留上次结果。';
    }
    if (/cancelled|aborted/i.test(message)) {
      return '生成已取消，已保留上次结果。';
    }
    return '生成失败，已保留上次结果。';
  }
}
