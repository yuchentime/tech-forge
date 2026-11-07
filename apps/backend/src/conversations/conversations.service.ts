import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { DataSource, In, type EntityManager } from 'typeorm';
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
  ConversationMessageDto,
  ConversationSummaryDto,
} from './conversation-query.dto';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';

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

  /** Returns ordered text-only chat messages for one existing conversation. */
  async getConversationMessages(
    conversationId: string,
    logContext?: RequestLogContext,
  ): Promise<ConversationMessageDto[]> {
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

      const messages = await this.dataSource.getRepository(MessageEntity).find({
        where: {
          conversationId,
          role: In(['user', 'assistant']),
          status: In(['completed', 'failed', 'cancelled']),
        },
        order: { sequenceNo: 'ASC' },
      });

      const result = messages.flatMap((message) => {
        const content = extractVisibleMessageText(message.contentJson);
        if (!content.trim()) return [];
        return [
          {
            id: message.id,
            role: message.role as 'user' | 'assistant',
            content,
            status: message.status as ConversationMessageDto['status'],
            createdAt: message.createdAt.toISOString(),
          },
        ];
      });
      writeStructuredEvent(
        this.logger,
        'log',
        'conversations.messages.query.completed',
        {
          ...context,
          storedMessageCount: messages.length,
          visibleMessageCount: result.length,
          elapsedMs: Date.now() - startedAt,
        },
      );
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
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
