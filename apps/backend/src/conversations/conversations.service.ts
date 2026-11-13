import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { DataSource, type EntityManager } from 'typeorm';
import { rmSync } from 'node:fs';
import { SettingsService } from '../settings/settings.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import type { ArtifactSummaryDto } from '../artifacts/artifacts.dto';
import {
  createAssistantTurnMarker,
  createRecoveredToolResult,
  getPersistedToolCalls,
  isAssistantTurnMarker,
  parsePersistedPiMessage,
  parseToolExecution,
  recoverInterruptedPiMessage,
  serializePersistedPiMessage,
  serializeToolExecution,
  type PersistedToolExecution,
} from './conversation-transcript';
import { ConversationEntity } from './conversation.entity';
import { MessageEntity } from './message.entity';
import { ConversationRunRegistry } from './conversation-run-registry';
import type {
  ConversationAttachmentDto,
  ConversationGeneratedFileDto,
  ConversationMessagesDto,
  ConversationMessageDto,
  ConversationSummaryDto,
  ConversationToolActivityDto,
} from './conversation-query.dto';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';

/** User-supplied sidebar titles are short labels, counted in Unicode code points. */
const CONVERSATION_TITLE_MAX_CHARACTERS = 20;

/** Carries the ordered history and turn marker for one Agent request. */
export interface ConversationTurn {
  conversationId: string;
  history: ConversationHistoryMessage[];
  assistantTurnId: string;
  /** Row id of this turn's user message, so callers can record what was injected for it. */
  userMessageId: string;
  /**
   * Chunk ids already present in the conversation's stored context refs.
   * Dedupe is derived from the history itself, so it survives restarts and cannot drift from what the
   * model actually received.
   */
  loadedChunkIds: string[];
  /**
   * Attachments recorded on earlier turns.
   * Their text is not replayed, but later turns need a path they can page through.
   */
  attachedDocuments: ConversationAttachmentRef[];
}

/** Provides one previous user, assistant, or Pi tool-result row for restoration. */
export interface ConversationHistoryMessage {
  id: string;
  role: string;
  contentJson: string;
  status: string;
  createdAt: Date;
}

/** Read-only history plus the parent cutoff used to freeze a rehearsal's background. */
export interface RestorableConversationHistory {
  history: ConversationHistoryMessage[];
  maxSequenceNo: number;
}

/** One attachment recorded on an earlier turn of this conversation. */
export interface ConversationAttachmentRef {
  attachmentId: string;
  name: string;
  /** Whether the attachment provides text or vision input; absent on older rows. */
  kind?: 'text' | 'image';
  /** Characters of extracted text, when the recorded turn knew it. */
  characters?: number;
  /** Characters injected into some earlier prompt, so the model knows what it has already seen. */
  injectedCharacters?: number;
}

/** Explicit knowledge scope for one conversation; empty means the default range applies. */
export interface ConversationKnowledgeScope {
  documentIds: string[];
}

/** Defines terminal statuses for a request-level assistant turn marker. */
export type ConversationAssistantStatus = 'completed' | 'failed' | 'cancelled';

/** Owns ordered conversation rows and durable Pi message/tool state. */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  /** Injects TypeORM for short writes and the config paths used for session files. */
  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly artifacts: ArtifactsService,
    private readonly conversationRuns: ConversationRunRegistry = new ConversationRunRegistry(),
  ) {}

  /** Creates an empty persisted conversation for a draft thread's first send. */
  async createConversation(logContext?: RequestLogContext): Promise<{ conversationId: string }> {
    const conversationId = randomUUID();
    await this.dataSource.getRepository(ConversationEntity).save({
      id: conversationId,
      title: null,
      metadataJson: null,
    });
    writeStructuredEvent(this.logger, 'log', 'conversations.create.completed', {
      ...logContext,
      conversationId,
    });
    return { conversationId };
  }

  /**
   * Replaces the stored sidebar title of one conversation.
   *
   * The stored title outranks the derived first-prompt title in `listConversations()`, so a rename
   * survives later turns. Whitespace is collapsed and the length bound is applied in Unicode code
   * points, so one emoji counts once; an empty or oversized title is rejected instead of truncated.
   */
  async renameConversation(
    conversationId: string,
    title: string,
    logContext?: RequestLogContext,
  ): Promise<{ id: string; title: string }> {
    const startedAt = Date.now();
    const normalized = title.trim().replace(/\s+/g, ' ');
    const characters = Array.from(normalized);
    if (characters.length === 0) {
      throw new BadRequestException('会话名称不能为空。');
    }
    if (characters.length > CONVERSATION_TITLE_MAX_CHARACTERS) {
      throw new BadRequestException(
        `会话名称最多 ${CONVERSATION_TITLE_MAX_CHARACTERS} 个字符。`,
      );
    }

    let affected: number | null | undefined;
    try {
      const result = await this.dataSource
        .getRepository(ConversationEntity)
        .update({ id: conversationId }, { title: normalized });
      affected = result.affected;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.rename.failed', {
        ...logContext,
        conversationId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }

    if (!affected) {
      writeStructuredEvent(this.logger, 'warn', 'conversations.rename.not_found', {
        ...logContext,
        conversationId,
        elapsedMs: Date.now() - startedAt,
      });
      throw new NotFoundException('Conversation was not found.');
    }
    writeStructuredEvent(this.logger, 'log', 'conversations.rename.completed', {
      ...logContext,
      conversationId,
      characterCount: characters.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { id: conversationId, title: normalized };
  }

  /** Loads lightweight sidebar summaries and derives titles from first prompts. */
  async listConversations(
    logContext?: RequestLogContext,
  ): Promise<ConversationSummaryDto[]> {
    const startedAt = Date.now();
    writeStructuredEvent(this.logger, 'log', 'conversations.list.started', {
      ...logContext,
    });
    try {
      const conversations = await this.dataSource
        .getRepository(ConversationEntity)
        .find({
          order: {
            updatedAt: 'DESC',
            createdAt: 'DESC',
          },
        });
      if (conversations.length === 0) {
        writeStructuredEvent(this.logger, 'log', 'conversations.list.completed', {
          ...logContext,
          conversationCount: 0,
          elapsedMs: Date.now() - startedAt,
        });
        return [];
      }

      const titleByConversationId = await this.loadDerivedTitles();
      const result = conversations.map((conversation) => ({
        id: conversation.id,
        title:
          normalizeDisplayTitle(conversation.title) ??
          titleByConversationId.get(conversation.id) ??
          '新对话',
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      }));
      writeStructuredEvent(this.logger, 'log', 'conversations.list.completed', {
        ...logContext,
        conversationCount: result.length,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.list.failed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /**
   * Resolves the displayed sidebar title for a small set of conversations.
   *
   * The 学习笔记 list uses this to reflect renames and the first-prompt fallback without storing a
   * stale title snapshot on every focus row.
   */
  async getConversationDisplayTitles(
    conversationIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(conversationIds)];
    if (ids.length === 0) return new Map();

    const conversations = await this.dataSource
      .getRepository(ConversationEntity)
      .createQueryBuilder('conversation')
      .where('conversation.id IN (:...ids)', { ids })
      .getMany();
    const derived = await this.loadDerivedTitles(ids);
    return new Map(
      conversations.map((conversation) => [
        conversation.id,
        normalizeDisplayTitle(conversation.title) ??
          derived.get(conversation.id) ??
          '新对话',
      ]),
    );
  }

  /**
   * Derives first-prompt titles, optionally restricted to the given conversations.
   *
   * Omitting the ids keeps the sidebar's original one-query behavior; the focus list passes only the
   * conversations it renders.
   */
  private async loadDerivedTitles(
    conversationIds?: readonly string[],
  ): Promise<Map<string, string | undefined>> {
    if (conversationIds !== undefined && conversationIds.length === 0) {
      return new Map();
    }

    const query = this.dataSource
      .getRepository(MessageEntity)
      .createQueryBuilder('message')
      .select('message.conversationId', 'conversationId')
      .addSelect('message.contentJson', 'contentJson')
      .where('message.role = :userRole', { userRole: 'user' })
      .andWhere(
        `message.sequenceNo = (
          SELECT MIN(firstUser.sequenceNo)
          FROM messages firstUser
          WHERE firstUser.conversationId = message.conversationId
            AND firstUser.role = :userRole
        )`,
      );
    if (conversationIds !== undefined) {
      query.andWhere('message.conversationId IN (:...conversationIds)', {
        conversationIds: [...conversationIds],
      });
    }

    const firstUserMessages = await query.getRawMany<{
      conversationId: string;
      contentJson: string;
    }>();
    return new Map(
      firstUserMessages.map(({ conversationId, contentJson }) => [
        conversationId,
        extractDisplayTitle(contentJson),
      ]),
    );
  }

  /**
   * Returns every visible message of one conversation in order.
   *
   * The local app loads the whole transcript so 学习笔记 can scroll to an old message. Tool
   * executions stay out of the visible list but are projected onto their user message.
   */
  async getConversationMessages(
    conversationId: string,
    logContext?: RequestLogContext,
  ): Promise<ConversationMessagesDto> {
    const startedAt = Date.now();
    const context = { ...logContext, conversationId };
    writeStructuredEvent(
      this.logger,
      'log',
      'conversations.messages.query.started',
      context,
    );
    try {
      const conversation = await this.dataSource
        .getRepository(ConversationEntity)
        .findOneBy({ id: conversationId });
      if (!conversation) {
        writeStructuredEvent(
          this.logger,
          'warn',
          'conversations.messages.query.not_found',
          { ...context, elapsedMs: Date.now() - startedAt },
        );
        throw new NotFoundException('Conversation was not found.');
      }

      const messages = this.dataSource.getRepository(MessageEntity);
      // 工具执行行不是可见聊天消息；一次读全 user/assistant，避免分页把定位目标截掉。
      const rows = await messages
        .createQueryBuilder('message')
        .where('message.conversationId = :conversationId', { conversationId })
        .andWhere('message.role IN (:...roles)', {
          roles: ['user', 'assistant'],
        })
        .andWhere('message.status IN (:...statuses)', {
          statuses: ['completed', 'failed', 'cancelled'],
        })
        .orderBy('message.sequenceNo', 'ASC')
        .getMany();

      const visibleRows = rows.flatMap((message) => {
        const content = extractVisibleMessageText(message.contentJson);
        return content.trim() ? [{ message, content }] : [];
      });

      const toolActivitiesByUserId = await this.getToolActivitiesByUserMessageId(
        conversationId,
        visibleRows
          .map(({ message }) => message)
          .filter((message) => message.role === 'user'),
        logContext,
      );
      const generatedFilesByAssistantId =
        await this.getGeneratedFilesByAssistantMessageId(
          conversationId,
          visibleRows.map(({ message }) => message),
        );

      const result: ConversationMessagesDto = {
        messages: visibleRows.map(
          ({ message, content }): ConversationMessageDto => ({
            id: message.id,
            role: message.role as 'user' | 'assistant',
            content,
            status: message.status as ConversationMessageDto['status'],
            createdAt: message.createdAt.toISOString(),
            ...(message.role === 'user'
              ? {
                  toolActivities: toolActivitiesByUserId.get(message.id) ?? [],
                  attachments: readAttachmentRefs(message.contextRefsJson),
                }
              : {
                  generatedFiles: generatedFilesByAssistantId.get(message.id) ?? [],
                }),
          }),
        ),
      };
      writeStructuredEvent(
        this.logger,
        'log',
        'conversations.messages.query.completed',
        {
          ...context,
          scannedMessageCount: rows.length,
          visibleMessageCount: result.messages.length,
          toolActivityCount: [...toolActivitiesByUserId.values()].reduce(
            (count, activities) => count + activities.length,
            0,
          ),
          elapsedMs: Date.now() - startedAt,
        },
      );
      return result;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      writeStructuredEvent(
        this.logger,
        'error',
        'conversations.messages.query.failed',
        {
          ...context,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    }
  }

  /** Returns whether a conversation row exists, without loading its messages. */
  async conversationExists(conversationId: string): Promise<boolean> {
    return (
      (await this.dataSource
        .getRepository(ConversationEntity)
        .countBy({ id: conversationId })) > 0
    );
  }

  /**
   * Returns the model-restorable history for one conversation without writing anything.
   *
   * Rehearsal uses this to seed its opening plan from normal chat. Pending rows mean a normal turn
   * is still in flight; including them would let an unfinished answer become drill background, so
   * the caller gets a conflict instead.
   */
  async getRestorableHistory(
    conversationId: string,
    upToSequenceNo?: number,
    logContext?: RequestLogContext,
  ): Promise<RestorableConversationHistory> {
    const startedAt = Date.now();
    const context = {
      ...logContext,
      conversationId,
      hasCutoff: upToSequenceNo !== undefined,
    };
    try {
      const conversation = await this.dataSource
        .getRepository(ConversationEntity)
        .findOneBy({ id: conversationId });
      if (!conversation) {
        throw new NotFoundException('Conversation was not found.');
      }

      const query = this.dataSource
        .getRepository(MessageEntity)
        .createQueryBuilder('message')
        .where('message.conversationId = :conversationId', { conversationId })
        .orderBy('message.sequenceNo', 'ASC');
      if (upToSequenceNo !== undefined) {
        query.andWhere('message.sequenceNo <= :upToSequenceNo', {
          upToSequenceNo,
        });
      }
      const rows = await query.getMany();
      if (rows.some((row) => row.status === 'pending')) {
        throw new ConflictException(
          'The current conversation turn is still running.',
        );
      }

      const history = this.buildRestorableHistory(rows);
      const maxSequenceNo = rows.reduce(
        (maximum, row) => Math.max(maximum, row.sequenceNo),
        0,
      );
      writeStructuredEvent(
        this.logger,
        'log',
        'conversations.restorable_history.completed',
        {
          ...context,
          rowCount: rows.length,
          historyMessageCount: history.length,
          maxSequenceNo,
          elapsedMs: Date.now() - startedAt,
        },
      );
      return { history, maxSequenceNo };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      writeStructuredEvent(
        this.logger,
        'error',
        'conversations.restorable_history.failed',
        {
          ...context,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    }
  }

  /**
   * Maps each turn's produced files onto the last assistant row of that turn inside the page.
   *
   * The footer belongs under the response, so the target is the assistant row closest before the
   * next user message. A turn split across a page boundary shows no footer until its last
   * assistant row is on screen; that keeps the mapping free of extra state.
   */
  private async getGeneratedFilesByAssistantMessageId(
    conversationId: string,
    pageMessages: MessageEntity[],
  ): Promise<Map<string, ConversationGeneratedFileDto[]>> {
    const projected = new Map<string, ConversationGeneratedFileDto[]>();
    const assistantRows = pageMessages.filter((message) => message.role === 'assistant');
    if (assistantRows.length === 0) return projected;

    const artifacts = await this.artifacts.listArtifacts(conversationId);
    const byUserMessage = new Map<string, ArtifactSummaryDto[]>();
    for (const artifact of artifacts) {
      if (!artifact.userMessageId) continue;
      const list = byUserMessage.get(artifact.userMessageId) ?? [];
      list.push(artifact);
      byUserMessage.set(artifact.userMessageId, list);
    }
    if (byUserMessage.size === 0) return projected;

    const repository = this.dataSource.getRepository(MessageEntity);
    const owners = await repository
      .createQueryBuilder('message')
      .select(['message.id', 'message.sequenceNo'])
      .where('message.conversationId = :conversationId', { conversationId })
      .andWhere('message.id IN (:...ids)', { ids: [...byUserMessage.keys()] })
      .getMany();
    const ownerSequence = new Map(owners.map((row) => [row.id, row.sequenceNo]));
    if (ownerSequence.size === 0) return projected;

    // Every user row in the conversation gives each turn its right boundary.
    const userRows = await repository
      .createQueryBuilder('message')
      .select(['message.sequenceNo'])
      .where('message.conversationId = :conversationId', { conversationId })
      .andWhere('message.role = :role', { role: 'user' })
      .orderBy('message.sequenceNo', 'ASC')
      .getMany();
    const userSequences = userRows.map((row) => row.sequenceNo);

    for (const [userMessageId, files] of byUserMessage) {
      const startSequence = ownerSequence.get(userMessageId);
      if (startSequence === undefined) continue;
      const endSequence =
        userSequences.find((sequence) => sequence > startSequence) ?? Number.POSITIVE_INFINITY;
      const turnAssistants = assistantRows
        .filter(
          (row) => row.sequenceNo > startSequence && row.sequenceNo < endSequence,
        )
        .sort((left, right) => left.sequenceNo - right.sequenceNo);
      const target = turnAssistants[turnAssistants.length - 1];
      if (!target) continue;
      projected.set(
        target.id,
        files.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          contentFormat: file.contentFormat,
          missing: file.missing,
          external: file.external,
        })),
      );
    }
    return projected;
  }

  /** Loads safe tool summaries for each selected user message without exposing tool payloads. */
  private async getToolActivitiesByUserMessageId(
    conversationId: string,
    userMessages: MessageEntity[],
    logContext?: RequestLogContext,
  ): Promise<
    Map<string, NonNullable<ConversationMessageDto['toolActivities']>>
  > {
    const activitiesByUserId = new Map<
      string,
      NonNullable<ConversationMessageDto['toolActivities']>
    >();
    for (const userMessage of userMessages) {
      activitiesByUserId.set(userMessage.id, []);
    }
    if (userMessages.length === 0) return activitiesByUserId;

    const repository = this.dataSource.getRepository(MessageEntity);
    const firstUserSequence = userMessages[0].sequenceNo;
    const lastUserSequence = userMessages[userMessages.length - 1].sequenceNo;
    // 最后一条已选 user 之后的下一条 user 是右边界，防止活动串入下一轮。
    const nextUserMessage = await repository
      .createQueryBuilder('message')
      .where('message.conversationId = :conversationId', { conversationId })
      .andWhere('message.role = :role', { role: 'user' })
      .andWhere('message.sequenceNo > :sequenceNo', {
        sequenceNo: lastUserSequence,
      })
      .orderBy('message.sequenceNo', 'ASC')
      .getOne();
    const toolQuery = repository
      .createQueryBuilder('message')
      .where('message.conversationId = :conversationId', { conversationId })
      .andWhere('message.role = :role', { role: 'toolExecution' })
      .andWhere('message.status IN (:...statuses)', {
        statuses: ['completed', 'failed'],
      })
      .andWhere('message.sequenceNo > :firstUserSequence', {
        firstUserSequence,
      });
    if (nextUserMessage) {
      toolQuery.andWhere('message.sequenceNo < :nextUserSequence', {
        nextUserSequence: nextUserMessage.sequenceNo,
      });
    }

    const toolMessages = await toolQuery
      .orderBy('message.sequenceNo', 'ASC')
      .getMany();
    for (const toolMessage of toolMessages) {
      let execution: PersistedToolExecution | undefined;
      try {
        execution = parseToolExecution(toolMessage.contentJson);
      } catch (error) {
        writeStructuredEvent(
          this.logger,
          'warn',
          'conversations.tool.history_projection.skipped',
          {
            ...logContext,
            conversationId,
            messageId: toolMessage.id,
            ...getSafeErrorLogFields(error),
          },
        );
        continue;
      }
      if (!execution) continue;

      let owner: MessageEntity | undefined;
      // 按序号找最近的前置 user 行，作为这条工具执行记录所属轮次。
      for (const userMessage of userMessages) {
        if (userMessage.sequenceNo > toolMessage.sequenceNo) break;
        owner = userMessage;
      }
      if (!owner) continue;

      // 只投影 UI 需要的白名单字段，不将存储中的参数或执行结果带入 API。
      const activity: ConversationToolActivityDto = {
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: execution.status === 'completed' ? 'completed' : 'failed',
        ...(execution.displayPath === undefined
          ? {}
          : { path: execution.displayPath }),
        ...(execution.displayPattern === undefined
          ? {}
          : { pattern: execution.displayPattern }),
        ...(execution.displayOffset === undefined
          ? {}
          : { offset: execution.displayOffset }),
        ...(execution.displayLimit === undefined
          ? {}
          : { limit: execution.displayLimit }),
        ...(typeof execution.durationMs === 'number' &&
        Number.isFinite(execution.durationMs) &&
        execution.durationMs >= 0
          ? { durationMs: execution.durationMs }
          : {}),
      };
      activitiesByUserId.get(owner.id)?.push(activity);
    }
    return activitiesByUserId;
  }

  /** Reconciles old interrupted rows, loads prior history, and starts a new turn. */
  async beginTurn(
    conversationId: string,
    prompt: string,
    createIfMissing: boolean,
    logContext?: RequestLogContext,
  ): Promise<ConversationTurn> {
    const startedAt = Date.now();
    let metrics: Record<string, unknown> = {};
    let phase = 'load_conversation';
    writeStructuredEvent(this.logger, 'log', 'conversations.turn.begin.started', {
      ...logContext,
      conversationId,
      createIfMissing,
      promptLength: Array.from(prompt).length,
    });
    try {
      const turn = await this.dataSource.transaction(async (manager) => {
        const conversations = manager.getRepository(ConversationEntity);
        const messages = manager.getRepository(MessageEntity);
        let conversation = await conversations.findOneBy({ id: conversationId });
        const createdConversation = !conversation;

        if (!conversation && !createIfMissing) {
          throw new NotFoundException('Conversation was not found.');
        }
        if (!conversation) {
          conversation = conversations.create({ id: conversationId, title: null, metadataJson: null });
          await conversations.save(conversation);
        }

        phase = 'load_history';
        writeStructuredEvent(this.logger, 'log', 'conversations.turn.phase', {
          ...logContext,
          conversationId,
          phase,
        });
        const priorMessages = await messages.find({
          where: { conversationId },
          order: { sequenceNo: 'ASC' },
        });
        const previousMessageCount = priorMessages.length;
        const pendingRowsBeforeRecovery = priorMessages.filter(
          (message) => message.status === 'pending',
        ).length;
        phase = 'recover_interrupted_rows';
        writeStructuredEvent(
          this.logger,
          'log',
          'conversations.turn.recovery.started',
          {
            ...logContext,
            conversationId,
            previousMessageCount,
            pendingRowCount: pendingRowsBeforeRecovery,
          },
        );
        await this.recoverInterruptedRows(manager, priorMessages);
        const pendingRowsAfterRecovery = priorMessages.filter(
          (message) => message.status === 'pending',
        ).length;
        phase = 'rebuild_missing_tool_results';
        const messageCountBeforeToolRecovery = priorMessages.length;
        await this.persistMissingToolResults(manager, conversationId, priorMessages);
        writeStructuredEvent(
          this.logger,
          'log',
          'conversations.turn.recovery.reconciled',
          {
            ...logContext,
            conversationId,
            recoveredInterruptedRowCount: Math.max(
              0,
              pendingRowsBeforeRecovery - pendingRowsAfterRecovery,
            ),
            recoveredToolResultCount:
              priorMessages.length - messageCountBeforeToolRecovery,
          },
        );

        phase = 'build_model_history';
        const history = this.buildRestorableHistory(priorMessages);
        phase = 'persist_current_turn';
        writeStructuredEvent(this.logger, 'log', 'conversations.turn.phase', {
          ...logContext,
          conversationId,
          phase,
          historyMessageCount: history.length,
        });
        const nextSequence = await this.nextSequenceNo(manager, conversationId);
        const userMessage = messages.create({
          id: randomUUID(),
          conversationId,
          sequenceNo: nextSequence,
          role: 'user',
          contentJson: JSON.stringify([{ type: 'text', text: prompt }]),
          status: 'completed',
          requestId: null,
          contextRefsJson: null,
        });
        const assistantTurn = messages.create({
          id: randomUUID(),
          conversationId,
          sequenceNo: nextSequence + 1,
          role: 'assistantTurn',
          contentJson: createAssistantTurnMarker(),
          status: 'pending',
          requestId: null,
          contextRefsJson: null,
        });

        await messages.save([userMessage, assistantTurn]);
        await conversations.update(conversationId, { updatedAt: new Date() });
        metrics = {
          createdConversation,
          previousMessageCount,
          historyMessageCount: history.length,
          recoveredInterruptedRowCount: Math.max(
            0,
            pendingRowsBeforeRecovery - pendingRowsAfterRecovery,
          ),
          recoveredToolResultCount: priorMessages.length - previousMessageCount,
          userMessageId: userMessage.id,
          assistantTurnId: assistantTurn.id,
          userSequenceNo: nextSequence,
        };

        return {
          conversationId,
          history,
          assistantTurnId: assistantTurn.id,
          userMessageId: userMessage.id,
          loadedChunkIds: collectLoadedChunkIds(priorMessages),
          attachedDocuments: collectAttachedDocuments(priorMessages),
        };
      });
      writeStructuredEvent(this.logger, 'log', 'conversations.turn.begin.completed', {
        ...logContext,
        conversationId,
        ...metrics,
        elapsedMs: Date.now() - startedAt,
      });
      return turn;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.turn.begin.failed', {
        ...logContext,
        conversationId,
        phase,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /**
   * Merges context references into a user row instead of replacing the whole JSON object.
   *
   * A turn can inject attachments, knowledge chunks and rehearsal digests together; writing them
   * one by one must not erase the keys written by the previous step. This is the durable record
   * used by the next turn for dedupe and traceability, so a failure is logged but never fails the
   * turn — the worst case is re-injecting the same material.
   */
  async mergeUserMessageContextRefs(
    messageId: string,
    contextRefsJson: string,
    logContext?: RequestLogContext,
  ): Promise<void> {
    try {
      const repository = this.dataSource.getRepository(MessageEntity);
      const message = await repository.findOneBy({ id: messageId });
      if (!message) return;
      const patch = parseContextRefs(contextRefsJson);
      if (!patch) {
        throw new Error('Context refs patch is not a JSON object.');
      }
      const existing = message.contextRefsJson
        ? (parseContextRefs(message.contextRefsJson) ?? {})
        : {};
      await repository.update(
        { id: messageId },
        { contextRefsJson: JSON.stringify({ ...existing, ...patch }) },
      );
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.context_refs.failed', {
        ...logContext,
        messageId,
        ...getSafeErrorLogFields(error),
      });
    }
  }

  /**
   * Reads the explicit knowledge scope of one conversation.
   *
   * A missing conversation or missing metadata both mean "no override": the default range
   * (shared + conversation documents) then applies.
   */
  async getKnowledgeScope(conversationId: string): Promise<ConversationKnowledgeScope> {
    const conversation = await this.dataSource
      .getRepository(ConversationEntity)
      .findOneBy({ id: conversationId });
    return { documentIds: readScopeDocumentIds(conversation?.metadataJson ?? null) };
  }

  /**
   * Replaces the explicit knowledge scope, preserving every other metadata key.
   *
   * An empty list clears the override, so the conversation returns to the default range instead of
   * silently searching nothing.
   */
  async setKnowledgeScope(
    conversationId: string,
    documentIds: string[],
    logContext?: RequestLogContext,
  ): Promise<ConversationKnowledgeScope> {
    const repository = this.dataSource.getRepository(ConversationEntity);
    const conversation = await repository.findOneBy({ id: conversationId });
    if (!conversation) throw new NotFoundException('没有找到这个会话，它可能已经被删除。');

    const unique = [...new Set(documentIds)];
    const metadata = parseConversationMetadata(conversation.metadataJson);
    if (unique.length === 0) {
      delete metadata.knowledge;
    } else {
      metadata.knowledge = { documentIds: unique, updatedAt: new Date().toISOString() };
    }
    const metadataJson = Object.keys(metadata).length === 0 ? null : JSON.stringify(metadata);
    await repository.update({ id: conversationId }, { metadataJson });
    writeStructuredEvent(this.logger, 'log', 'conversations.knowledge_scope.updated', {
      ...logContext,
      conversationId,
      documentCount: unique.length,
    });
    return { documentIds: unique };
  }

  /**
   * Physically deletes one conversation, every row derived from it, and its local session files.
   *
   * Every foreign key is `ON DELETE NO ACTION`, so children are removed first inside one transaction.
   * Files are removed after the commit: a file-system failure must not resurrect the rows, and it is
   * reported as `partial` instead of being hidden.
   */
  async deleteConversation(
    conversationId: string,
    logContext?: RequestLogContext,
  ): Promise<{ conversationId: string; sessionCleanup: 'complete' | 'partial' }> {
    const startedAt = Date.now();
    const context = { ...(logContext ?? {}), conversationId };

    const releaseDeletion = this.conversationRuns.tryAcquireDeletion(conversationId);
    if (!releaseDeletion) {
      throw new ConflictException('Conversation is busy.');
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        const existing = await manager.findOne(ConversationEntity, {
          where: { id: conversationId },
        });
        if (!existing) {
          throw new NotFoundException('没有找到这个会话，它可能已经被删除。');
        }
        // Children first: fact rows and rehearsals reference the conversation directly, the turn
        // rows reference the rehearsal, and snapshots carry a raw conversation id.
        await manager.query(
          'DELETE FROM "conversation_knowledge_facts" WHERE "conversationId" = ?',
          [conversationId],
        );
        await manager.query(
          'DELETE FROM "rehearsal_turns" WHERE "rehearsalId" IN (SELECT id FROM "rehearsals" WHERE "conversationId" = ?)',
          [conversationId],
        );
        await manager.query('DELETE FROM "rehearsals" WHERE "conversationId" = ?', [
          conversationId,
        ]);
        await manager.query('DELETE FROM "artifacts" WHERE "conversationId" = ?', [
          conversationId,
        ]);
        await manager.query('DELETE FROM "conversation_documents" WHERE "conversationId" = ?', [
          conversationId,
        ]);
        // 学习笔记引用会话与消息；会话删除后这些摘录没有可定位的目标。
        await manager.query('DELETE FROM "focus_items" WHERE "conversationId" = ?', [
          conversationId,
        ]);
        await manager.query('DELETE FROM "messages" WHERE "conversationId" = ?', [
          conversationId,
        ]);
        await manager.query('DELETE FROM "pi_session_snapshots" WHERE conversation_id = ?', [
          conversationId,
        ]);
        await manager.delete(ConversationEntity, { id: conversationId });
      });
      const sessionCleanup = this.removeSessionDirectory(conversationId, context);
      writeStructuredEvent(this.logger, 'log', 'conversations.delete.completed', {
        ...context,
        sessionCleanup,
        elapsedMs: Date.now() - startedAt,
      });
      return { conversationId, sessionCleanup };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      writeStructuredEvent(this.logger, 'error', 'conversations.delete.failed', {
        ...context,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    } finally {
      // Directory cleanup is part of the deletion lifetime: releasing earlier would let a new turn
      // recreate files while the previous conversation directory is still being removed.
      releaseDeletion();
    }
  }

  /** Removes one conversation's local session files; a failure is logged, never thrown. */
  private removeSessionDirectory(
    conversationId: string,
    context: Record<string, unknown>,
  ): 'complete' | 'partial' {
    try {
      rmSync(this.settings.getSessionDirectory(conversationId), {
        recursive: true,
        force: true,
      });
      return 'complete';
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'warn',
        'conversations.delete.session_cleanup_failed',
        { ...context, ...getSafeErrorLogFields(error) },
      );
      return 'partial';
    }
  }

  /** Inserts an in-progress Pi message before any projected event is sent. */
  async startPiMessage(
    conversationId: string,
    message: SessionMessageEntry['message'],
    logContext?: RequestLogContext,
  ): Promise<string> {
    const startedAt = Date.now();
    try {
      const messageId = await this.dataSource.transaction(async (manager) => {
        const id = randomUUID();
        await manager.getRepository(MessageEntity).save({
          id,
          conversationId,
          sequenceNo: await this.nextSequenceNo(manager, conversationId),
          role: message.role,
          contentJson: serializePersistedPiMessage(message),
          status: 'pending',
          requestId: null,
          contextRefsJson: null,
        });
        return id;
      });
      writeStructuredEvent(this.logger, 'log', 'conversations.message.inserted', {
        ...logContext,
        conversationId,
        messageId,
        role: message.role,
        status: 'pending',
        elapsedMs: Date.now() - startedAt,
      });
      return messageId;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.message.insert.failed', {
        ...logContext,
        conversationId,
        role: message.role,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Commits each Pi message snapshot and its streaming or terminal state. */
  async updatePiMessage(
    conversationId: string,
    messageId: string,
    message: SessionMessageEntry['message'],
    status: 'pending' | 'completed' | 'failed' | 'cancelled',
    logContext?: RequestLogContext,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.dataSource.getRepository(MessageEntity).update(
        { id: messageId, conversationId },
        {
          role: message.role,
          contentJson: serializePersistedPiMessage(message),
          status,
          updatedAt: new Date(),
        },
      );
      if (!result.affected) {
        throw new Error('Pi message row was not found.');
      }
      if (status !== 'pending') {
        writeStructuredEvent(
          this.logger,
          status === 'completed' ? 'log' : 'warn',
          'conversations.message.terminal_persisted',
          {
            ...logContext,
            conversationId,
            messageId,
            role: message.role,
            status,
            elapsedMs: Date.now() - startedAt,
          },
        );
      }
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.message.update.failed', {
        ...logContext,
        conversationId,
        messageId,
        role: message.role,
        status,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Inserts durable tool execution state before the tool begins running. */
  async startToolExecution(
    conversationId: string,
    execution: Omit<PersistedToolExecution, 'format' | 'status'>,
    logContext?: RequestLogContext,
  ): Promise<string> {
    const startedAt = Date.now();
    try {
      const messageId = await this.dataSource.transaction(async (manager) => {
        const id = randomUUID();
        await manager.getRepository(MessageEntity).save({
          id,
          conversationId,
          sequenceNo: await this.nextSequenceNo(manager, conversationId),
          role: 'toolExecution',
          contentJson: serializeToolExecution({ ...execution, status: 'running' }),
          status: 'pending',
          requestId: null,
          contextRefsJson: null,
        });
        return id;
      });
      writeStructuredEvent(this.logger, 'log', 'conversations.tool.inserted', {
        ...logContext,
        conversationId,
        messageId,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: 'running',
        elapsedMs: Date.now() - startedAt,
      });
      return messageId;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.tool.insert.failed', {
        ...logContext,
        conversationId,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Persists partial or final tool execution state in its own ordered row. */
  async updateToolExecution(
    conversationId: string,
    messageId: string,
    execution: Omit<PersistedToolExecution, 'format'>,
    logContext?: RequestLogContext,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const repository = this.dataSource.getRepository(MessageEntity);
      const toolMessage = await repository.findOneBy({
        id: messageId,
        conversationId,
      });
      if (!toolMessage) {
        throw new Error('Tool execution row was not found.');
      }
      const priorExecution = parseToolExecution(toolMessage.contentJson);
      const updatedExecution: PersistedToolExecution = {
        format: 'teachforge-tool-execution-v1',
        ...(priorExecution ?? {}),
        ...execution,
        ...(execution.partialResult === undefined &&
        priorExecution?.partialResult !== undefined
          ? { partialResult: priorExecution.partialResult }
          : {}),
      };
      const status =
        updatedExecution.status === 'running'
          ? 'pending'
          : updatedExecution.status === 'completed'
            ? 'completed'
            : 'failed';
      const result = await repository.update(
        { id: messageId, conversationId },
        {
          contentJson: serializeToolExecution(updatedExecution),
          status,
          updatedAt: new Date(),
        },
      );
      if (!result.affected) {
        throw new Error('Tool execution row was not found.');
      }
      if (execution.status !== 'running') {
        writeStructuredEvent(
          this.logger,
          execution.status === 'completed' ? 'log' : 'warn',
          'conversations.tool.terminal_persisted',
          {
            ...logContext,
            conversationId,
            messageId,
            toolCallId: execution.toolCallId,
            toolName: execution.toolName,
            status: execution.status,
            durationMs: execution.durationMs,
            elapsedMs: Date.now() - startedAt,
          },
        );
      }
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.tool.update.failed', {
        ...logContext,
        conversationId,
        messageId,
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: execution.status,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Closes the request marker after success, failure, or cancellation. */
  async finishTurn(
    conversationId: string,
    assistantTurnId: string,
    status: ConversationAssistantStatus,
    logContext?: RequestLogContext,
  ): Promise<void> {
    const startedAt = Date.now();
    writeStructuredEvent(this.logger, 'log', 'conversations.turn.finish.started', {
      ...logContext,
      conversationId,
      assistantTurnId,
      status,
    });
    const reconciledRows: Array<{
      messageId: string;
      role: string;
      status: string;
      toolCallId?: string;
      toolName?: string;
    }> = [];
    try {
      const reconciledPendingRowCount = await this.dataSource.transaction(
        async (manager) => {
          const messages = manager.getRepository(MessageEntity);
          const assistantTurn = await messages.findOneBy({
            id: assistantTurnId,
            conversationId,
          });
          if (
            !assistantTurn ||
            !isAssistantTurnMarker(assistantTurn.contentJson)
          ) {
            throw new Error('Pending assistant turn marker was not found.');
          }

          assistantTurn.status = status;
          await messages.save(assistantTurn);
          const runtimeMessages = await messages.find({
            where: { conversationId },
            order: { sequenceNo: 'ASC' },
          });
          let reconciledCount = 0;
          for (const runtimeMessage of runtimeMessages) {
            if (
              runtimeMessage.sequenceNo <= assistantTurn.sequenceNo ||
              runtimeMessage.status !== 'pending'
            ) {
              continue;
            }
            if (runtimeMessage.role === 'toolExecution') {
              const execution = parseToolExecution(runtimeMessage.contentJson);
              if (execution) {
                execution.status = 'interrupted';
                runtimeMessage.contentJson = serializeToolExecution(execution);
                reconciledRows.push({
                  messageId: runtimeMessage.id,
                  role: runtimeMessage.role,
                  status: 'failed',
                  toolCallId: execution.toolCallId,
                  toolName: execution.toolName,
                });
              }
              runtimeMessage.status = 'failed';
            } else if (runtimeMessage.role === 'toolResult') {
              runtimeMessage.status = 'completed';
              reconciledRows.push({
                messageId: runtimeMessage.id,
                role: runtimeMessage.role,
                status: runtimeMessage.status,
              });
            } else if (runtimeMessage.role === 'assistant') {
              runtimeMessage.status = status === 'completed' ? 'failed' : status;
              reconciledRows.push({
                messageId: runtimeMessage.id,
                role: runtimeMessage.role,
                status: runtimeMessage.status,
              });
            } else if (parsePersistedPiMessage(runtimeMessage.contentJson)) {
              runtimeMessage.status = status === 'cancelled' ? 'cancelled' : 'failed';
              reconciledRows.push({
                messageId: runtimeMessage.id,
                role: runtimeMessage.role,
                status: runtimeMessage.status,
              });
            }
            await messages.save(runtimeMessage);
            reconciledCount += 1;
          }
          await manager
            .getRepository(ConversationEntity)
            .update(conversationId, { updatedAt: new Date() });
          return reconciledCount;
        },
      );
      for (const row of reconciledRows) {
        writeStructuredEvent(
          this.logger,
          row.status === 'completed' ? 'log' : 'warn',
          'conversations.turn.pending_row_finalized',
          {
            ...logContext,
            conversationId,
            assistantTurnId,
            ...row,
          },
        );
      }
      writeStructuredEvent(this.logger, 'log', 'conversations.turn.finish.completed', {
        ...logContext,
        conversationId,
        assistantTurnId,
        status,
        reconciledPendingRowCount,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.turn.finish.failed', {
        ...logContext,
        conversationId,
        assistantTurnId,
        status,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Marks abandoned message and tool rows, retaining recoverable content. */
  private async recoverInterruptedRows(
    manager: EntityManager,
    messages: MessageEntity[],
  ): Promise<void> {
    const repository = manager.getRepository(MessageEntity);
    for (const message of messages) {
      if (message.role === 'assistantTurn') {
        if (message.status === 'pending') {
          message.status = 'failed';
          await repository.save(message);
        }
        continue;
      }

      if (message.role === 'toolExecution') {
        const execution = parseToolExecution(message.contentJson);
        if (!execution || message.status !== 'pending') continue;
        execution.status = 'interrupted';
        message.contentJson = serializeToolExecution(execution);
        message.status = 'failed';
        await repository.save(message);
        continue;
      }

      const persisted = parsePersistedPiMessage(message.contentJson);
      if (!persisted) {
        if (message.role === 'assistant' && message.status === 'pending') {
          message.status = 'failed';
          await repository.save(message);
        }
        continue;
      }
      if (message.status === 'completed') continue;

      if (message.role === 'toolResult') {
        message.status = 'completed';
      } else {
        const recovered = recoverInterruptedPiMessage(
          persisted.message,
          true,
        );
        message.contentJson = recovered
          ? serializePersistedPiMessage(recovered)
          : JSON.stringify([]);
        if (message.status === 'pending') message.status = 'failed';
      }
      await repository.save(message);
    }
  }

  /** Adds one error result for each tool call whose result was lost on interruption. */
  private async persistMissingToolResults(
    manager: EntityManager,
    conversationId: string,
    messages: MessageEntity[],
  ): Promise<void> {
    const toolCalls = messages.flatMap((message) => {
      const persisted = parsePersistedPiMessage(message.contentJson);
      return persisted ? getPersistedToolCalls(persisted.message) : [];
    });
    const toolResults = new Set(
      messages.flatMap((message) => {
        const persisted = parsePersistedPiMessage(message.contentJson);
        return persisted?.message.role === 'toolResult'
          ? [persisted.message.toolCallId]
          : [];
      }),
    );
    const executions = new Map(
      messages.flatMap((message) => {
        if (message.role !== 'toolExecution') return [];
        const execution = parseToolExecution(message.contentJson);
        return execution ? [[execution.toolCallId, execution] as const] : [];
      }),
    );
    const repository = manager.getRepository(MessageEntity);
    let nextSequence = await this.nextSequenceNo(manager, conversationId);

    for (const toolCall of toolCalls) {
      if (toolResults.has(toolCall.id)) continue;
      const execution = executions.get(toolCall.id);
      const resultMessage = createRecoveredToolResult(
        toolCall.id,
        toolCall.name,
        execution,
      );
      const result = repository.create({
        id: randomUUID(),
        conversationId,
        sequenceNo: nextSequence,
        role: 'toolResult',
        contentJson: serializePersistedPiMessage(resultMessage),
        status: 'completed',
        requestId: null,
        contextRefsJson: null,
      });
      await repository.save(result);
      messages.push(result);
      toolResults.add(toolCall.id);
      nextSequence += 1;
    }
  }

  /**
   * Selects rows that belong in the durable model transcript.
   *
   * Pending markers, assistant-turn markers and tool-execution metadata are runtime bookkeeping,
   * not model messages. The same projection feeds normal chat turns and the rehearsal opening
   * context so both agents see the same history.
   */
  private buildRestorableHistory(
    messages: readonly MessageEntity[],
  ): ConversationHistoryMessage[] {
    return messages.flatMap((message) => {
      if (message.role === 'user' && message.status === 'completed') {
        return [this.toHistoryMessage(message)];
      }
      if (
        !['completed', 'failed', 'cancelled'].includes(message.status) ||
        message.role === 'assistantTurn' ||
        message.role === 'toolExecution'
      ) {
        return [];
      }
      if (
        message.role === 'assistant' ||
        message.role === 'toolResult' ||
        parsePersistedPiMessage(message.contentJson)
      ) {
        return [this.toHistoryMessage(message)];
      }
      return [];
    });
  }

  /** Converts a stored row into the common history representation. */
  private toHistoryMessage(message: MessageEntity): ConversationHistoryMessage {
    return {
      id: message.id,
      role: message.role,
      contentJson: message.contentJson,
      status: message.status,
      createdAt: message.createdAt,
    };
  }

  /** Calculates the next per-conversation sequence number inside a short transaction. */
  private async nextSequenceNo(
    manager: EntityManager,
    conversationId: string,
  ): Promise<number> {
    const result = await manager
      .getRepository(MessageEntity)
      .createQueryBuilder('message')
      .select('MAX(message.sequenceNo)', 'maximum')
      .where('message.conversationId = :conversationId', { conversationId })
      .getRawOne<{ maximum: number | string | null }>();
    return Number(result?.maximum ?? 0) + 1;
  }
}

/** Parses a context-refs JSON object, returning null for malformed or non-object values. */
function parseContextRefs(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extracts visible text from a persisted native Pi message or legacy text blocks. */
function extractVisibleMessageText(contentJson: string): string {
  const persisted = parsePersistedPiMessage(contentJson);
  if (persisted) {
    if (persisted.message.role !== 'assistant') return '';
    return extractTextContent(persisted.message.content);
  }

  return extractTextContent(JSON.parse(contentJson));
}

/** Reads the metadata object, ignoring anything that is not a JSON object. */
function parseConversationMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Reads `knowledge.documentIds` from metadata, keeping only well-formed ids. */
function readScopeDocumentIds(metadataJson: string | null): string[] {
  const metadata = parseConversationMetadata(metadataJson);
  const knowledge = metadata.knowledge;
  if (!knowledge || typeof knowledge !== 'object') return [];
  const ids = (knowledge as { documentIds?: unknown }).documentIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Collects injected chunk ids from stored context refs.
 *
 * Malformed or unrelated JSON is skipped: one bad row must not stop a turn. Older rows recorded
 * whole documents instead of chunks; they carry no chunk id and are simply ignored.
 */
function collectLoadedChunkIds(messages: MessageEntity[]): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    if (!message.contextRefsJson) continue;
    try {
      const parsed: unknown = JSON.parse(message.contextRefsJson);
      if (!parsed || typeof parsed !== 'object') continue;
      const knowledge = (parsed as { knowledge?: unknown }).knowledge;
      if (!knowledge || typeof knowledge !== 'object') continue;
      const chunks = (knowledge as { chunks?: unknown }).chunks;
      if (!Array.isArray(chunks)) continue;
      for (const entry of chunks) {
        if (!entry || typeof entry !== 'object') continue;
        const chunkId = (entry as { chunkId?: unknown }).chunkId;
        if (typeof chunkId === 'string' && chunkId.length > 0) refs.add(chunkId);
      }
    } catch {
      // Ignore rows written by an older or broken format.
    }
  }
  return [...refs];
}

/**
 * Collects the attachments recorded anywhere in this conversation, keeping the widest known sizes.
 *
 * Later turns use these entries to point the model at the stored text file; nothing is re-injected.
 */
function collectAttachedDocuments(
  messages: MessageEntity[],
): ConversationAttachmentRef[] {
  const byId = new Map<string, ConversationAttachmentRef>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const attachment of readAttachmentDetails(message.contextRefsJson)) {
      const existing = byId.get(attachment.attachmentId);
      byId.set(attachment.attachmentId, {
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        kind: attachment.kind ?? existing?.kind,
        characters: attachment.characters ?? existing?.characters,
        injectedCharacters: Math.max(
          attachment.injectedCharacters ?? 0,
          existing?.injectedCharacters ?? 0,
        ),
      });
    }
  }
  return [...byId.values()];
}

/**
 * Reads the attachments recorded for one user row.
 *
 * Only the id and display name are trusted: they are what the chat bubble shows. The extracted text
 * is stored on disk, never in `contextRefsJson`.
 */
function readAttachmentRefs(
  contextRefsJson: string | null,
): ConversationAttachmentDto[] {
  return readAttachmentDetails(contextRefsJson).map(({ attachmentId, name }) => ({
    attachmentId,
    name,
  }));
}

/** Parses one row's attachment refs, keeping the optional sizes when present. */
function readAttachmentDetails(
  contextRefsJson: string | null,
): ConversationAttachmentRef[] {
  if (!contextRefsJson) return [];
  try {
    const parsed: unknown = JSON.parse(contextRefsJson);
    if (!parsed || typeof parsed !== 'object') return [];
    const attachments = (parsed as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) return [];
    return attachments.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as {
        attachmentId?: unknown;
        name?: unknown;
        kind?: unknown;
        characters?: unknown;
        injectedCharacters?: unknown;
      };
      if (
        typeof record.attachmentId !== 'string' ||
        typeof record.name !== 'string'
      ) {
        return [];
      }
      return [
        {
          attachmentId: record.attachmentId,
          name: record.name,
          ...(record.kind === 'image' || record.kind === 'text'
            ? { kind: record.kind }
            : {}),
          ...(typeof record.characters === 'number'
            ? { characters: record.characters }
            : {}),
          ...(typeof record.injectedCharacters === 'number'
            ? { injectedCharacters: record.injectedCharacters }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Derives a compact list title from a legacy user text-block row. */
function extractDisplayTitle(contentJson: string): string | undefined {
  const value: unknown = JSON.parse(contentJson);
  return normalizeDisplayTitle(extractTextContent(value));
}

/** Joins only text blocks, keeping tool arguments and non-text Pi data private. */
function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .flatMap((block) => {
      if (
        typeof block !== 'object' ||
        block === null ||
        Array.isArray(block) ||
        (block as { type?: unknown }).type !== 'text' ||
        typeof (block as { text?: unknown }).text !== 'string'
      ) {
        return [];
      }
      return [(block as { text: string }).text];
    })
    .join('\n');
}

/** Normalizes and bounds one sidebar title without changing persisted data. */
function normalizeDisplayTitle(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length > 80
    ? `${characters.slice(0, 79).join('')}…`
    : normalized;
}
