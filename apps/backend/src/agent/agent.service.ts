import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import {
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
} from '../llm/adapters/llm-adapter';
import { ConversationsService } from '../conversations/conversations.service';
import { LlmService } from '../llm/llm.service';
import { projectAgentSessionEvent } from './agent-events';
import type { AgentStreamEvent } from './agent-events';

/** Tracks one active Pi message and durable tool rows during a streamed turn. */
interface AgentTurnPersistenceState {
  activePiMessageId?: string;
  toolExecutionIds: Map<string, string>;
}

/** 持久化 Agent 对话轮次，并将安全 Pi 事件交给流式调用方。 */
@Injectable()
export class AgentService {
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
  ): AsyncGenerator<AgentStreamEvent> {
    if (signal.aborted) return;

    const resolvedConversationId = conversationId ?? randomUUID();
    const releaseLock = await this.acquireConversationLock(
      resolvedConversationId,
    );
    if (signal.aborted) {
      releaseLock();
      return;
    }

    let turn:
      | Awaited<ReturnType<ConversationsService['beginTurn']>>
      | undefined;
    const persistenceState: AgentTurnPersistenceState = {
      toolExecutionIds: new Map(),
    };
    let assistantStatus: 'completed' | 'failed' | 'cancelled' = 'failed';

    try {
      turn = await this.conversations.beginTurn(
        resolvedConversationId,
        prompt,
        conversationId === undefined,
      );
      if (signal.aborted) {
        assistantStatus = 'cancelled';
        return;
      }
      yield {
        type: 'conversation',
        conversationId: resolvedConversationId,
      };

      const piEvents = this.llm.stream(prompt, {
        providerId: DEEPSEEK_PROVIDER_ID,
        modelId: DEEPSEEK_MODEL_ID,
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
        const event = projectAgentSessionEvent(piEvent);
        if (event) yield event;
      }

      assistantStatus = signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      assistantStatus = signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      try {
        if (turn) {
          if (signal.aborted) assistantStatus = 'cancelled';
          await this.conversations.finishTurn(
            resolvedConversationId,
            turn.assistantTurnId,
            assistantStatus,
          );
        }
      } finally {
        releaseLock();
      }
    }
  }

  /** Commits one Pi message/tool snapshot before forwarding its public event. */
  private async persistPiEvent(
    conversationId: string,
    state: AgentTurnPersistenceState,
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
        );
        return;
      case 'message_update':
        if (isNonPersistedPiMessage(event.message)) return;
        state.activePiMessageId ??= await this.conversations.startPiMessage(
          conversationId,
          event.message,
        );
        await this.conversations.updatePiMessage(
          conversationId,
          state.activePiMessageId,
          event.message,
          'pending',
        );
        return;
      case 'message_end':
        if (isNonPersistedPiMessage(event.message)) return;
        state.activePiMessageId ??= await this.conversations.startPiMessage(
          conversationId,
          event.message,
        );
        await this.conversations.updatePiMessage(
          conversationId,
          state.activePiMessageId,
          event.message,
          event.message.role !== 'assistant'
            ? 'completed'
            : event.message.stopReason === 'error'
              ? 'failed'
              : event.message.stopReason === 'aborted'
                ? 'cancelled'
                : 'completed',
        );
        state.activePiMessageId = undefined;
        return;
      case 'tool_execution_start': {
        const messageId = await this.conversations.startToolExecution(
          conversationId,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.parentToolCallId
              ? { parentToolCallId: event.parentToolCallId }
              : {}),
          },
        );
        state.toolExecutionIds.set(event.toolCallId, messageId);
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
        await this.conversations.updateToolExecution(conversationId, messageId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.parentToolCallId
            ? { parentToolCallId: event.parentToolCallId }
            : {}),
          status: 'running',
          partialResult: event.partialResult,
        });
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
        await this.conversations.updateToolExecution(conversationId, messageId, {
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
        });
        return;
      }
      default:
        return;
    }
  }

  /** Creates a fallback tool row if Pi reports progress without a start event. */
  private async getToolExecutionRowId(
    conversationId: string,
    state: AgentTurnPersistenceState,
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
    );
    state.toolExecutionIds.set(toolCallId, messageId);
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
