import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { ConversationsService } from '../conversations/conversations.service';
import { LlmService } from '../llm/llm.service';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';
import { projectChatSessionEvent } from './chat-events';
import type { ChatStreamEvent } from './chat-events';

/** Tracks one active Pi message and durable tool rows during a streamed turn. */
interface ChatTurnPersistenceState {
  logContext: RequestLogContext;
  activePiMessageId?: string;
  activePiMessageStartedAt?: number;
  messageUpdateCount: number;
  lastMessageProgressLoggedAt: number;
  toolExecutionIds: Map<string, string>;
  toolProgress: Map<
    string,
    { updateCount: number; lastLoggedAt: number; startedAt: number }
  >;
}

/** 持久化 Chat 对话轮次，并将安全 Pi 事件交给流式调用方。 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly conversationTails = new Map<string, Promise<void>>();

  /** Injects persistence and model services used by one streamed conversation turn. */
  constructor(
    private readonly llm: LlmService,
    private readonly conversations: ConversationsService,
  ) {}

  /** Persists a turn, restores its prior context, and streams safe Pi events. */
  async *stream(
    prompt: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    requestId: string = randomUUID(),
  ): AsyncGenerator<ChatStreamEvent> {
    const startedAt = Date.now();
    const resolvedConversationId = conversationId ?? randomUUID();
    const logContext: RequestLogContext = {
      requestId,
      conversationId: resolvedConversationId,
    };
    let phase = 'request_start';
    let releaseLock: (() => void) | undefined;
    let turn:
      | Awaited<ReturnType<ConversationsService['beginTurn']>>
      | undefined;
    const persistenceState: ChatTurnPersistenceState = {
      logContext,
      messageUpdateCount: 0,
      lastMessageProgressLoggedAt: 0,
      toolExecutionIds: new Map(),
      toolProgress: new Map(),
    };
    let assistantStatus: 'completed' | 'failed' | 'cancelled' = 'failed';
    const eventCounts = new Map<string, number>();

    writeStructuredEvent(this.logger, 'log', 'chat.turn.accepted', {
      ...logContext,
      requestedConversation: conversationId !== undefined,
      promptLength: Array.from(prompt).length,
    });

    try {
      if (signal.aborted) {
        assistantStatus = 'cancelled';
        writeStructuredEvent(this.logger, 'warn', 'chat.turn.cancelled', {
          ...logContext,
          phase,
          reason: 'aborted_before_queue',
        });
        return;
      }

      phase = 'conversation_queue';
      const queueStartedAt = Date.now();
      const queuedBehindCurrent = this.conversationTails.has(
        resolvedConversationId,
      );
      writeStructuredEvent(
        this.logger,
        'log',
        'chat.conversation.queue.waiting',
        { ...logContext, queuedBehindCurrent },
      );
      releaseLock = await this.acquireConversationLock(resolvedConversationId);
      writeStructuredEvent(
        this.logger,
        'log',
        'chat.conversation.queue.acquired',
        {
          ...logContext,
          queuedBehindCurrent,
          waitMs: Date.now() - queueStartedAt,
        },
      );
      if (signal.aborted) {
        assistantStatus = 'cancelled';
        writeStructuredEvent(this.logger, 'warn', 'chat.turn.cancelled', {
          ...logContext,
          phase,
          reason: 'aborted_while_queued',
        });
        return;
      }

      phase = 'conversation.begin_turn';
      writeStructuredEvent(this.logger, 'log', 'chat.turn.begin.started', {
        ...logContext,
        createIfMissing: conversationId === undefined,
      });
      turn = await this.conversations.beginTurn(
        resolvedConversationId,
        prompt,
        conversationId === undefined,
        logContext,
      );
      writeStructuredEvent(this.logger, 'log', 'chat.turn.begin.completed', {
        ...logContext,
        historyMessageCount: turn.history.length,
        assistantTurnId: turn.assistantTurnId,
      });
      if (signal.aborted) {
        assistantStatus = 'cancelled';
        writeStructuredEvent(this.logger, 'warn', 'chat.turn.cancelled', {
          ...logContext,
          phase,
          reason: 'aborted_after_turn_begin',
        });
        return;
      }
      yield {
        type: 'conversation',
        conversationId: resolvedConversationId,
      };

      phase = 'llm.stream';
      const llmStartedAt = Date.now();
      writeStructuredEvent(this.logger, 'log', 'chat.llm.stream.started', {
        ...logContext,
        historyMessageCount: turn.history.length,
      });
      const piEvents = this.llm.stream(prompt, {
        requestId,
        signal,
        conversation: {
          id: resolvedConversationId,
          history: turn.history.map((message) => ({
            id: message.id,
            role: message.role,
            contentJson: message.contentJson,
            status: message.status,
            createdAt: message.createdAt,
          })),
        },
        persistConversationEvent: (event) =>
          this.persistPiEvent(resolvedConversationId, persistenceState, event),
      });

      for await (const piEvent of piEvents) {
        eventCounts.set(
          piEvent.type,
          (eventCounts.get(piEvent.type) ?? 0) + 1,
        );
        if (
          piEvent.type === 'agent_start' ||
          piEvent.type === 'turn_start' ||
          piEvent.type === 'turn_end' ||
          piEvent.type === 'agent_end'
        ) {
          writeStructuredEvent(this.logger, 'log', 'chat.pi.lifecycle', {
            ...logContext,
            eventType: piEvent.type,
          });
        }
        const event = projectChatSessionEvent(piEvent);
        if (event) yield event;
      }

      assistantStatus = signal.aborted ? 'cancelled' : 'completed';
      writeStructuredEvent(
        this.logger,
        assistantStatus === 'completed' ? 'log' : 'warn',
        'chat.llm.stream.terminated',
        {
          ...logContext,
          outcome: assistantStatus,
          elapsedMs: Date.now() - llmStartedAt,
          eventCounts: Object.fromEntries(eventCounts),
        },
      );
    } catch (error) {
      assistantStatus = signal.aborted ? 'cancelled' : 'failed';
      writeStructuredEvent(
        this.logger,
        assistantStatus === 'cancelled' ? 'warn' : 'error',
        assistantStatus === 'cancelled'
          ? 'chat.turn.cancelled'
          : 'chat.turn.failed',
        {
          ...logContext,
          phase,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    } finally {
      try {
        if (turn) {
          if (signal.aborted) assistantStatus = 'cancelled';
          phase = 'conversation.finish_turn';
          writeStructuredEvent(
            this.logger,
            'log',
            'chat.turn.finalization.started',
            {
              ...logContext,
              assistantTurnId: turn.assistantTurnId,
              status: assistantStatus,
            },
          );
          try {
            await this.conversations.finishTurn(
              resolvedConversationId,
              turn.assistantTurnId,
              assistantStatus,
              logContext,
            );
            writeStructuredEvent(
              this.logger,
              'log',
              'chat.turn.finalization.completed',
              {
                ...logContext,
                assistantTurnId: turn.assistantTurnId,
                status: assistantStatus,
              },
            );
          } catch (error) {
            assistantStatus = 'failed';
            writeStructuredEvent(
              this.logger,
              'error',
              'chat.turn.finalization.failed',
              {
                ...logContext,
                assistantTurnId: turn.assistantTurnId,
                ...getSafeErrorLogFields(error),
              },
            );
            throw error;
          }
        }
      } finally {
        releaseLock?.();
        writeStructuredEvent(
          this.logger,
          assistantStatus === 'failed'
            ? 'error'
            : assistantStatus === 'cancelled'
              ? 'warn'
              : 'log',
          'chat.turn.terminated',
          {
            ...logContext,
            status: assistantStatus,
            elapsedMs: Date.now() - startedAt,
            lockReleased: releaseLock !== undefined,
          },
        );
      }
    }
  }

  /** Commits one Pi message/tool snapshot before forwarding its public event. */
  private async persistPiEvent(
    conversationId: string,
    state: ChatTurnPersistenceState,
    event: import('@earendil-works/pi-coding-agent').AgentSessionEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'message_start':
        if (isNonPersistedPiMessage(event.message)) return;
        if (state.activePiMessageId) {
          throw new Error('Pi started a message before the previous one ended.');
        }
        state.activePiMessageId = await this.conversations.startPiMessage(
          conversationId,
          event.message,
          state.logContext,
        );
        state.activePiMessageStartedAt = Date.now();
        state.messageUpdateCount = 0;
        state.lastMessageProgressLoggedAt = state.activePiMessageStartedAt;
        writeStructuredEvent(this.logger, 'log', 'chat.message.started', {
          ...state.logContext,
          messageId: state.activePiMessageId,
          role: event.message.role,
          ...getPiMessageMetrics(event.message),
        });
        return;
      case 'message_update':
        if (isNonPersistedPiMessage(event.message)) return;
        if (!state.activePiMessageId) {
          state.activePiMessageId = await this.conversations.startPiMessage(
            conversationId,
            event.message,
            state.logContext,
          );
          state.activePiMessageStartedAt = Date.now();
          state.messageUpdateCount = 0;
          state.lastMessageProgressLoggedAt = 0;
          writeStructuredEvent(this.logger, 'log', 'chat.message.started', {
            ...state.logContext,
            messageId: state.activePiMessageId,
            role: event.message.role,
            startedFrom: 'message_update',
          });
        }
        await this.conversations.updatePiMessage(
          conversationId,
          state.activePiMessageId,
          event.message,
          'pending',
          state.logContext,
        );
        state.messageUpdateCount += 1;
        if (Date.now() - state.lastMessageProgressLoggedAt >= 5_000) {
          state.lastMessageProgressLoggedAt = Date.now();
          writeStructuredEvent(this.logger, 'debug', 'chat.message.progress', {
            ...state.logContext,
            messageId: state.activePiMessageId,
            updateCount: state.messageUpdateCount,
            elapsedMs: state.activePiMessageStartedAt
              ? Date.now() - state.activePiMessageStartedAt
              : undefined,
            ...getPiMessageMetrics(event.message),
          });
        }
        return;
      case 'message_end':
        if (isNonPersistedPiMessage(event.message)) return;
        if (!state.activePiMessageId) {
          state.activePiMessageId = await this.conversations.startPiMessage(
            conversationId,
            event.message,
            state.logContext,
          );
          state.activePiMessageStartedAt = Date.now();
          writeStructuredEvent(this.logger, 'log', 'chat.message.started', {
            ...state.logContext,
            messageId: state.activePiMessageId,
            role: event.message.role,
            startedFrom: 'message_end',
          });
        }
        {
          const messageId = state.activePiMessageId;
          const updateCount = state.messageUpdateCount;
          const elapsedMs = state.activePiMessageStartedAt
            ? Date.now() - state.activePiMessageStartedAt
            : undefined;
          const status =
            event.message.role !== 'assistant'
              ? 'completed'
              : event.message.stopReason === 'error'
                ? 'failed'
                : event.message.stopReason === 'aborted'
                  ? 'cancelled'
                  : 'completed';
          await this.conversations.updatePiMessage(
            conversationId,
            messageId,
            event.message,
            status,
            state.logContext,
          );
          writeStructuredEvent(
            this.logger,
            status === 'completed' ? 'log' : 'warn',
            'chat.message.terminated',
            {
              ...state.logContext,
              messageId,
              role: event.message.role,
              status,
              updateCount,
              elapsedMs,
              ...getPiMessageMetrics(event.message),
            },
          );
        }
        state.activePiMessageId = undefined;
        state.activePiMessageStartedAt = undefined;
        state.messageUpdateCount = 0;
        state.lastMessageProgressLoggedAt = 0;
        return;
      case 'tool_execution_start': {
        const displayPath = getToolDisplayPath(event.args);
        // 历史 UI 只需要路径标签；不把其他工具参数持久化到工具记录。
        const messageId = await this.conversations.startToolExecution(
          conversationId,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(displayPath === undefined ? {} : { displayPath }),
            ...(event.parentToolCallId
              ? { parentToolCallId: event.parentToolCallId }
              : {}),
          },
          state.logContext,
        );
        state.toolExecutionIds.set(event.toolCallId, messageId);
        const toolStartedAt = Date.now();
        state.toolProgress.set(event.toolCallId, {
          updateCount: 0,
          lastLoggedAt: toolStartedAt,
          startedAt: toolStartedAt,
        });
        writeStructuredEvent(this.logger, 'log', 'chat.tool.started', {
          ...state.logContext,
          messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          parentToolCallId: event.parentToolCallId,
        });
        return;
      }
      case 'tool_execution_update': {
        const messageId = await this.getToolExecutionRowId(
          conversationId,
          state,
          event.toolCallId,
          event.toolName,
          event.parentToolCallId,
        );
        await this.conversations.updateToolExecution(
          conversationId,
          messageId,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.parentToolCallId
              ? { parentToolCallId: event.parentToolCallId }
              : {}),
            status: 'running',
            partialResult: event.partialResult,
          },
          state.logContext,
        );
        const progress = state.toolProgress.get(event.toolCallId) ?? {
          updateCount: 0,
          lastLoggedAt: 0,
          startedAt: Date.now(),
        };
        progress.updateCount += 1;
        if (Date.now() - progress.lastLoggedAt >= 5_000) {
          progress.lastLoggedAt = Date.now();
          writeStructuredEvent(this.logger, 'debug', 'chat.tool.progress', {
            ...state.logContext,
            messageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            updateCount: progress.updateCount,
            elapsedMs: Date.now() - progress.startedAt,
            partialResultLength: getSafeStringLength(event.partialResult),
          });
        }
        state.toolProgress.set(event.toolCallId, progress);
        return;
      }
      case 'tool_execution_end': {
        const messageId = await this.getToolExecutionRowId(
          conversationId,
          state,
          event.toolCallId,
          event.toolName,
          event.parentToolCallId,
        );
        const progress = state.toolProgress.get(event.toolCallId);
        await this.conversations.updateToolExecution(
          conversationId,
          messageId,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.parentToolCallId
              ? { parentToolCallId: event.parentToolCallId }
              : {}),
            status: event.isError ? 'failed' : 'completed',
            result: event.result,
            ...(event.durationMs === undefined
              ? {}
              : { durationMs: event.durationMs }),
          },
          state.logContext,
        );
        writeStructuredEvent(
          this.logger,
          event.isError ? 'warn' : 'log',
          'chat.tool.terminated',
          {
            ...state.logContext,
            messageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.isError ? 'failed' : 'completed',
            durationMs: event.durationMs,
            updateCount: progress?.updateCount ?? 0,
            hasResult: event.result !== undefined,
            resultLength: getSafeStringLength(event.result),
          },
        );
        state.toolProgress.delete(event.toolCallId);
        return;
      }
      default:
        return;
    }
  }

  /** Creates a fallback tool row if Pi reports progress without a start event. */
  private async getToolExecutionRowId(
    conversationId: string,
    state: ChatTurnPersistenceState,
    toolCallId: string,
    toolName: string,
    parentToolCallId: string | undefined,
  ): Promise<string> {
    const existingId = state.toolExecutionIds.get(toolCallId);
    if (existingId) return existingId;

    const messageId = await this.conversations.startToolExecution(
      conversationId,
      {
        toolCallId,
        toolName,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      },
      state.logContext,
    );
    state.toolExecutionIds.set(toolCallId, messageId);
    const toolStartedAt = Date.now();
    state.toolProgress.set(toolCallId, {
      updateCount: 0,
      lastLoggedAt: toolStartedAt,
      startedAt: toolStartedAt,
    });
    writeStructuredEvent(this.logger, 'warn', 'chat.tool.start_missing', {
      ...state.logContext,
      messageId,
      toolCallId,
      toolName,
      parentToolCallId,
    });
    return messageId;
  }

  /** Serializes history reads and sequence allocation for one conversation. */
  private async acquireConversationLock(
    conversationId: string,
  ): Promise<() => void> {
    const previous = this.conversationTails.get(conversationId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.conversationTails.set(conversationId, current);
    await previous;

    return () => {
      release();
      if (this.conversationTails.get(conversationId) === current) {
        this.conversationTails.delete(conversationId);
      }
    };
  }
}

/** Selects model and tool-result messages that belong in the durable transcript. */
function isNonPersistedPiMessage(
  message: SessionMessageEntry['message'],
): boolean {
  return message.role !== 'assistant' && message.role !== 'toolResult';
}

/** Returns transcript shape metrics without including message text or tool arguments. */
function getPiMessageMetrics(
  message: SessionMessageEntry['message'],
): Record<string, number> {
  if (!('content' in message)) return { contentBlockCount: 0 };

  const content: unknown = message.content;
  if (typeof content === 'string') {
    return { textLength: Array.from(content).length, contentBlockCount: 1 };
  }
  if (!Array.isArray(content)) return { contentBlockCount: 0 };

  let textLength = 0;
  let toolCallCount = 0;
  for (const item of content) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') {
      textLength += Array.from(block.text).length;
    }
    if (block.type === 'toolCall') toolCallCount += 1;
  }
  return {
    contentBlockCount: content.length,
    textLength,
    toolCallCount,
  };
}

/** Measures text-like tool progress without serializing the tool payload. */
function getSafeStringLength(value: unknown): number | undefined {
  if (typeof value === 'string') return Array.from(value).length;
  return undefined;
}

/** Keeps only a string path from tool arguments for later safe history display. */
function getToolDisplayPath(args: unknown): string | undefined {
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args)
  ) {
    return undefined;
  }

  const path = (args as Record<string, unknown>).path;
  return typeof path === 'string' ? path : undefined;
}
