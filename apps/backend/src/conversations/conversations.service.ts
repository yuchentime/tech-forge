import { Injectable, NotFoundException } from '@nestjs/common';
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
  /** Injects TypeORM for short writes that never span model or tool execution. */
  constructor(private readonly dataSource: DataSource) {}

  /** Loads lightweight sidebar summaries and derives titles from first prompts. */
  async listConversations(): Promise<ConversationSummaryDto[]> {
    const conversations = await this.dataSource
      .getRepository(ConversationEntity)
      .find({
        order: {
          updatedAt: 'DESC',
          createdAt: 'DESC',
        },
      });
    if (conversations.length === 0) return [];

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

    return conversations.map((conversation) => ({
      id: conversation.id,
      title:
        normalizeDisplayTitle(conversation.title) ??
        titleByConversationId.get(conversation.id) ??
        '新对话',
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    }));
  }

  /** Returns ordered text-only chat messages for one existing conversation. */
  async getConversationMessages(
    conversationId: string,
  ): Promise<ConversationMessageDto[]> {
    const conversation = await this.dataSource
      .getRepository(ConversationEntity)
      .findOneBy({ id: conversationId });
    if (!conversation) {
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

    return messages.flatMap((message) => {
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
  }

  /** Reconciles old interrupted rows, loads prior history, and starts a new turn. */
  async beginTurn(
    conversationId: string,
    prompt: string,
    createIfMissing: boolean,
  ): Promise<ConversationTurn> {
    return this.dataSource.transaction(async (manager) => {
      const conversations = manager.getRepository(ConversationEntity);
      const messages = manager.getRepository(MessageEntity);
      let conversation = await conversations.findOneBy({ id: conversationId });

      if (!conversation && !createIfMissing) {
        throw new NotFoundException('Conversation was not found.');
      }
      if (!conversation) {
        conversation = conversations.create({ id: conversationId, title: null });
        await conversations.save(conversation);
      }

      const priorMessages = await messages.find({
        where: { conversationId },
        order: { sequenceNo: 'ASC' },
      });
      await this.recoverInterruptedRows(manager, priorMessages);
      await this.persistMissingToolResults(manager, conversationId, priorMessages);

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

      return {
        conversationId,
        history,
        assistantTurnId: assistantTurn.id,
      };
    });
  }

  /** Inserts an in-progress Pi message before any projected event is sent. */
  async startPiMessage(
    conversationId: string,
    message: SessionMessageEntry['message'],
  ): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const messageId = randomUUID();
      await manager.getRepository(MessageEntity).save({
        id: messageId,
        conversationId,
        sequenceNo: await this.nextSequenceNo(manager, conversationId),
        role: message.role,
        contentJson: serializePersistedPiMessage(message),
        status: 'pending',
        requestId: null,
        contextRefsJson: null,
      });
      return messageId;
    });
  }

  /** Commits each Pi message snapshot and its streaming or terminal state. */
  async updatePiMessage(
    conversationId: string,
    messageId: string,
    message: SessionMessageEntry['message'],
    status: 'pending' | 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
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
  }

  /** Inserts durable tool execution state before the tool begins running. */
  async startToolExecution(
    conversationId: string,
    execution: Omit<PersistedToolExecution, 'format' | 'status'>,
  ): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const messageId = randomUUID();
      await manager.getRepository(MessageEntity).save({
        id: messageId,
        conversationId,
        sequenceNo: await this.nextSequenceNo(manager, conversationId),
        role: 'toolExecution',
        contentJson: serializeToolExecution({ ...execution, status: 'running' }),
        status: 'pending',
        requestId: null,
        contextRefsJson: null,
      });
      return messageId;
    });
  }

  /** Persists partial or final tool execution state in its own ordered row. */
  async updateToolExecution(
    conversationId: string,
    messageId: string,
    execution: Omit<PersistedToolExecution, 'format'>,
  ): Promise<void> {
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
  }

  /** Closes the request marker after success, failure, or cancellation. */
  async finishTurn(
    conversationId: string,
    assistantTurnId: string,
    status: ConversationAssistantStatus,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const messages = manager.getRepository(MessageEntity);
      const assistantTurn = await messages.findOneBy({
        id: assistantTurnId,
        conversationId,
      });
      if (!assistantTurn || !isAssistantTurnMarker(assistantTurn.contentJson)) {
        throw new Error('Pending assistant turn marker was not found.');
      }

      assistantTurn.status = status;
      await messages.save(assistantTurn);
      const runtimeMessages = await messages.find({
        where: { conversationId },
        order: { sequenceNo: 'ASC' },
      });
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
          }
          runtimeMessage.status = 'failed';
        } else if (runtimeMessage.role === 'toolResult') {
          runtimeMessage.status = 'completed';
        } else if (runtimeMessage.role === 'assistant') {
          runtimeMessage.status = status === 'completed' ? 'failed' : status;
        } else if (parsePersistedPiMessage(runtimeMessage.contentJson)) {
          runtimeMessage.status = status === 'cancelled' ? 'cancelled' : 'failed';
        }
        await messages.save(runtimeMessage);
      }
      await manager
        .getRepository(ConversationEntity)
        .update(conversationId, { updatedAt: new Date() });
    });
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
