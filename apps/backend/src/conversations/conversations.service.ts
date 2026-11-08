import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { DataSource, type EntityManager } from 'typeorm';
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
import type {
  ConversationMessagePageDto,
  ConversationMessageDto,
  ConversationSummaryDto,
  ConversationToolActivityDto,
} from './conversation-query.dto';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';

const CONVERSATION_HISTORY_PAGE_SIZE = 30;
const CONVERSATION_HISTORY_SCAN_BATCH_SIZE = 64;

/** Carries the ordered history and turn marker for one Agent request. */
export interface ConversationTurn {
  conversationId: string;
  history: ConversationHistoryMessage[];
  assistantTurnId: string;
}

/** Provides one previous user, assistant, or Pi tool-result row for restoration. */
export interface ConversationHistoryMessage {
  id: string;
  role: string;
  contentJson: string;
  status: string;
  createdAt: Date;
}

/** Defines terminal statuses for a request-level assistant turn marker. */
export type ConversationAssistantStatus = 'completed' | 'failed' | 'cancelled';

/** Owns ordered conversation rows and durable Pi message/tool state. */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  /** Injects TypeORM for short writes that never span model or tool execution. */
  constructor(private readonly dataSource: DataSource) {}

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

      const firstUserMessages = await this.dataSource
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
        )
        .getRawMany<{ conversationId: string; contentJson: string }>();
      const titleByConversationId = new Map(
        firstUserMessages.map(({ conversationId, contentJson }) => [
          conversationId,
          extractDisplayTitle(contentJson),
        ]),
      );
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

  /** Returns one ordered text page with safe tool summaries on its user messages. */
  async getConversationMessages(
    conversationId: string,
    beforeMessageId?: string,
    logContext?: RequestLogContext,
  ): Promise<ConversationMessagePageDto> {
    const startedAt = Date.now();
    const context = {
      ...logContext,
      conversationId,
      hasCursor: Boolean(beforeMessageId),
    };
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
      let beforeSequenceNo: number | null = null;
      if (beforeMessageId) {
        const anchor = await messages.findOneBy({
          id: beforeMessageId,
          conversationId,
        });
        if (!anchor) {
          throw new BadRequestException(
            'beforeMessageId must belong to the requested conversation.',
          );
        }
        beforeSequenceNo = anchor.sequenceNo;
      }

      const visibleRows: Array<{
        message: MessageEntity;
        content: string;
      }> = [];
      let scannedMessageCount = 0;
      let queryBatchCount = 0;
      let hasExhaustedCandidates = false;

      while (
        visibleRows.length < CONVERSATION_HISTORY_PAGE_SIZE + 1 &&
        !hasExhaustedCandidates
      ) {
        // 工具执行行不是可见聊天消息；先分页 user/assistant，避免工具数量改变页大小和 hasMore。
        const query = messages
          .createQueryBuilder('message')
          .where('message.conversationId = :conversationId', { conversationId })
          .andWhere('message.role IN (:...roles)', {
            roles: ['user', 'assistant'],
          })
          .andWhere('message.status IN (:...statuses)', {
            statuses: ['completed', 'failed', 'cancelled'],
          });
        if (beforeSequenceNo !== null) {
          query.andWhere('message.sequenceNo < :beforeSequenceNo', {
            beforeSequenceNo,
          });
        }

        const batch = await query
          .orderBy('message.sequenceNo', 'DESC')
          .take(CONVERSATION_HISTORY_SCAN_BATCH_SIZE)
          .getMany();
        queryBatchCount += 1;
        scannedMessageCount += batch.length;
        hasExhaustedCandidates =
          batch.length < CONVERSATION_HISTORY_SCAN_BATCH_SIZE;

        for (const message of batch) {
          beforeSequenceNo = message.sequenceNo;
          const content = extractVisibleMessageText(message.contentJson);
          if (!content.trim()) continue;
          visibleRows.push({ message, content });
          if (visibleRows.length === CONVERSATION_HISTORY_PAGE_SIZE + 1) break;
        }
      }

      const hasMore = visibleRows.length > CONVERSATION_HISTORY_PAGE_SIZE;
      const pageRows = visibleRows
        .slice(0, CONVERSATION_HISTORY_PAGE_SIZE)
        .reverse();
      // 先确定文本页，再补工具摘要；工具执行行不占用 30 条可见消息配额。
      const toolActivitiesByUserId = await this.getToolActivitiesByUserMessageId(
        conversationId,
        pageRows
          .map(({ message }) => message)
          .filter((message) => message.role === 'user'),
        logContext,
      );
      const result: ConversationMessagePageDto = {
        messages: pageRows.map(
          ({ message, content }): ConversationMessageDto => ({
            id: message.id,
            role: message.role as 'user' | 'assistant',
            content,
            status: message.status as ConversationMessageDto['status'],
            createdAt: message.createdAt.toISOString(),
            ...(message.role === 'user'
              ? { toolActivities: toolActivitiesByUserId.get(message.id) ?? [] }
              : {}),
          }),
        ),
        hasMore,
      };
      writeStructuredEvent(
        this.logger,
        'log',
        'conversations.messages.query.completed',
        {
          ...context,
          scannedMessageCount,
          queryBatchCount,
          visibleMessageCount: result.messages.length,
          toolActivityCount: [...toolActivitiesByUserId.values()].reduce(
            (count, activities) => count + activities.length,
            0,
          ),
          hasMore,
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
          conversation = conversations.create({ id: conversationId, title: null });
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
        const history = priorMessages.flatMap((message) => {
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

/** Extracts visible text from a persisted native Pi message or legacy text blocks. */
function extractVisibleMessageText(contentJson: string): string {
  const persisted = parsePersistedPiMessage(contentJson);
  if (persisted) {
    if (persisted.message.role !== 'assistant') return '';
    return extractTextContent(persisted.message.content);
  }

  return extractTextContent(JSON.parse(contentJson));
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
