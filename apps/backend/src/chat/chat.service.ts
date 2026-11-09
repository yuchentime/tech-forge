import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import {
  ConversationsService,
  type ConversationAttachmentRef,
} from '../conversations/conversations.service';
import { getToolDisplayFields } from '../conversations/conversation-transcript';
import {
  AttachmentsService,
  type AttachmentRef,
  type ChatAttachmentInput,
  type StoredAttachments,
} from '../attachments/attachments.service';
import { KnowledgeService, type KnowledgeContextResult } from '../knowledge/knowledge.service';
import { parseKnowledgeCommand } from '../knowledge/knowledge-command';
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
    private readonly knowledge: KnowledgeService,
    private readonly attachments: AttachmentsService,
  ) {}

  /**
   * Persists a turn, restores its prior context, and streams safe Pi events.
   *
   * `attachments` names files the user added to this message. They are copied into the resolved
   * conversation's session directory and their text is injected for this turn only; the ids and
   * names stay on the user row for the chat bubble.
   */
  async *stream(
    prompt: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    requestId: string = randomUUID(),
    attachments: readonly ChatAttachmentInput[] = [],
  ): AsyncGenerator<ChatStreamEvent> {
    const startedAt = Date.now();
    const resolvedConversationId = conversationId ?? randomUUID();
    const logContext: RequestLogContext = {
      requestId,
      conversationId: resolvedConversationId,
    };
    // Retrieval is an explicit user decision: only the leading command turns it on for this turn.
    const parsedCommand = parseKnowledgeCommand(prompt);
    const userPrompt = parsedCommand.prompt;
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
      knowledgeCommand: parsedCommand.force,
      userPromptLength: Array.from(userPrompt).length,
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
        userPrompt,
        conversationId === undefined,
        logContext,
      );
      writeStructuredEvent(this.logger, 'log', 'chat.turn.begin.completed', {
        ...logContext,
        historyMessageCount: turn.history.length,
        assistantTurnId: turn.assistantTurnId,
        loadedChunkCount: turn.loadedChunkIds.length,
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

      let attachmentContext: string | undefined;
      const requestedAttachments = dedupeAttachments(attachments);
      let currentAttachments: AttachmentRefInjected[] = [];
      if (requestedAttachments.length > 0) {
        phase = 'attachment.context';
        // The copy happens here, not at pick time: the conversation id only exists at this point.
        const stored = await this.attachments.storeForConversation(
          resolvedConversationId,
          requestedAttachments,
        );
        const rendered = renderAttachmentContext(stored);
        attachmentContext = rendered.text;
        currentAttachments = rendered.refs;
        // Only the reference and sizes are durable: the text belongs to this turn, not the transcript.
        await this.conversations.updateUserMessageContextRefs(
          turn.userMessageId,
          JSON.stringify({ attachments: rendered.refs }),
          logContext,
        );
        writeStructuredEvent(
          this.logger,
          'log',
          'chat.attachment.context.stored',
          {
            ...logContext,
            attachmentCount: stored.contents.length,
            failedCount: stored.failures.length,
            characters: stored.contents.reduce(
              (sum, content) => sum + content.text.length,
              0,
            ),
            injectedCharacters: rendered.text.length,
          },
        );
        if (signal.aborted) {
          assistantStatus = 'cancelled';
          writeStructuredEvent(this.logger, 'warn', 'chat.turn.cancelled', {
            ...logContext,
            phase,
            reason: 'aborted_after_attachment_context',
          });
          return;
        }
      }

      // Later turns cannot see this turn's injected text, and even this turn may have been cut short.
      // Point the model at the stored text file so `read`/`grep` can continue from a real path.
      const scope = mergeAttachmentScope(
        turn.attachedDocuments,
        currentAttachments,
      );
      if (scope.length > 0) {
        const pointer = renderAttachmentScope(scope, (attachmentId) =>
          this.attachments.textFilePath(
            resolvedConversationId,
            attachmentId,
          ),
        );
        attachmentContext = [attachmentContext, pointer]
          .filter((part): part is string => Boolean(part))
          .join('\n\n');
      }

      let knowledgeContext: KnowledgeContextResult | undefined;
      if (parsedCommand.force) {
        phase = 'knowledge.context';
        // Scope is conversation state, not model judgement: an explicit selection restricts the
        // search, and an empty one keeps the default range.
        const scope = await this.conversations.getKnowledgeScope(resolvedConversationId);
        knowledgeContext = await this.knowledge.buildContext({
          conversationId: resolvedConversationId,
          query: userPrompt,
          loadedChunkIds: turn.loadedChunkIds,
          explicitDocumentIds: scope.documentIds,
          logContext,
          signal,
        });
        // Recorded before the model runs so a failed or cancelled turn still reflects what was sent.
        const refsJson = this.knowledge.toContextRefsJson(knowledgeContext, userPrompt);
        if (refsJson) {
          await this.conversations.updateUserMessageContextRefs(
            turn.userMessageId,
            refsJson,
            logContext,
          );
        }
        if (signal.aborted) {
          assistantStatus = 'cancelled';
          writeStructuredEvent(this.logger, 'warn', 'chat.turn.cancelled', {
            ...logContext,
            phase,
            reason: 'aborted_after_knowledge_context',
          });
          return;
        }
      }

      // Per-turn reference material travels with the user message, never in the system prompt:
      // the system prompt must stay identical across turns for provider prefix caching, and the
      // snapshot is cleaned of this block before it is stored.
      const promptContext = [attachmentContext, knowledgeContext?.text]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');

      phase = 'llm.stream';
      const llmStartedAt = Date.now();
      writeStructuredEvent(this.logger, 'log', 'chat.llm.stream.started', {
        ...logContext,
        historyMessageCount: turn.history.length,
        knowledgeOutcome: knowledgeContext?.outcome,
        injectedDocumentCount: knowledgeContext?.refs.length ?? 0,
        injectedTokens: knowledgeContext?.stats.injectedTokens ?? 0,
        promptContextCharacters: promptContext.length,
      });
      const piEvents = this.llm.stream(userPrompt, {
        requestId,
        signal,
        promptContext: promptContext === '' ? undefined : promptContext,
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
        const display = getToolDisplayFields(event.toolName, event.args);
        // 历史 UI 只展示动作、搜索词和路径；不把其他工具参数持久化到工具记录。
        const messageId = await this.conversations.startToolExecution(
          conversationId,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(display.displayPath === undefined
              ? {}
              : { displayPath: display.displayPath }),
            ...(display.displayPattern === undefined
              ? {}
              : { displayPattern: display.displayPattern }),
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

/**
 * Characters of attachment text injected per turn.
 *
 * A guard, not a budget: without it a 300-page PDF pushes the request past the model context, Pi
 * compaction tries and fails, and the provider returns no assistant text at all. 40k characters is
 * roughly a long handout and leaves room for the system prompt, history and the answer.
 */
const ATTACHMENT_INJECTION_LIMIT = 40_000;

/**
 * Renders this turn's extracted attachment text for the system prompt.
 *
 * Files are taken in the user's order until the injection limit; a file that does not fit is cut and
 * the model is told how much of it is visible, so it can say what it could not see instead of
 * pretending to know the whole document.
 */
function renderAttachmentContext(stored: StoredAttachments): {
  text: string;
  refs: AttachmentRefInjected[];
} {
  const blocks = [
    '## 本轮用户附加的文件',
    '以下是用户随这条消息上传的文件内容（系统提取的正文）。请把它当作本轮问题的一部分直接使用，不要要求用户重新上传或贴出内容。',
  ];
  let remaining = ATTACHMENT_INJECTION_LIMIT;
  const skipped: string[] = [];
  const injected = new Map<string, number>();

  stored.contents.forEach((content, index) => {
    if (remaining <= 0) {
      skipped.push(content.name);
      return;
    }
    const characters = Array.from(content.text);
    const take = Math.min(characters.length, remaining);
    remaining -= take;
    injected.set(content.attachmentId, take);
    const visible =
      take === characters.length
        ? content.text
        : `${characters.slice(0, take).join('')}\n\n（该文件共 ${characters.length} 字，本轮只提供开头 ${take} 字；其余内容没有注入，涉及未提供部分时请说明看不到。）`;
    blocks.push(`### 文件 ${index + 1}：《${content.name}》\n${visible}`);
  });

  if (skipped.length > 0) {
    const names = skipped.map((name) => `《${name}》`).join('、');
    blocks.push(
      `本轮附件注入已到上限，以下文件没有提供任何内容：${names}。请如实告知用户只能基于其余附件回答，不要猜测这些文件的内容。`,
    );
  }
  if (stored.failures.length > 0) {
    const names = stored.failures.map((failure) => `《${failure.name}》`).join('、');
    blocks.push(
      `以下附件本轮没有可用的内容：${names}（文件无法读取，或其中没有可提取的文字）。请如实告知用户，不要猜测其中的内容。`,
    );
  }
  return {
    text: blocks.join('\n\n'),
    refs: stored.refs.map((ref) => ({
      ...ref,
      injectedCharacters: injected.get(ref.attachmentId) ?? 0,
    })),
  };
}

/** One attachment with the number of characters this turn actually injected. */
type AttachmentRefInjected = AttachmentRef & { injectedCharacters: number };

/**
 * Merges the attachments of earlier turns with this turn's, keeping the widest known sizes.
 *
 * Current entries win on `injectedCharacters` so the pointer states what this prompt contains; the
 * earlier maximum is kept when it is larger, because the model may already have seen more.
 */
function mergeAttachmentScope(
  prior: readonly ConversationAttachmentRef[],
  current: readonly AttachmentRefInjected[],
): ConversationAttachmentRef[] {
  const byId = new Map<string, ConversationAttachmentRef>();
  for (const attachment of prior) byId.set(attachment.attachmentId, { ...attachment });
  for (const attachment of current) {
    const existing = byId.get(attachment.attachmentId);
    byId.set(attachment.attachmentId, {
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      characters: attachment.characters,
      injectedCharacters: Math.max(
        attachment.injectedCharacters,
        existing?.injectedCharacters ?? 0,
      ),
    });
  }
  return [...byId.values()];
}

/**
 * Renders the pointer block that tells the model where the full attachment text lives.
 *
 * The injected prefix is all it sees by default; the path lets `read` (offset/limit) or `grep`
 * continue from the stored text instead of guessing the rest of the document.
 */
function renderAttachmentScope(
  entries: readonly ConversationAttachmentRef[],
  pathOf: (attachmentId: string) => string,
): string {
  const lines = entries.map((entry) => {
    const size =
      entry.characters === undefined
        ? '字数未知'
        : `共 ${entry.characters.toLocaleString('en-US')} 字`;
    const seen =
      entry.injectedCharacters === undefined
        ? ''
        : `，已注入 ${entry.injectedCharacters.toLocaleString('en-US')} 字`;
    return `- 《${entry.name}》：${pathOf(entry.attachmentId)}（${size}${seen}）`;
  });
  return [
    '## 本会话可读取的附件',
    '以下文件已保存在本机，并带有解析后的正文。需要超出上面已提供范围的内容时，用 read 读取该路径（可带 offset/limit 分段），或用 grep 在其中搜索关键词；不要凭猜测补全未读到的部分。',
    ...lines,
  ].join('\n');
}

/** Keeps one entry per attachment id, dropping empty ids, and preserves the user's order. */
function dedupeAttachments(
  attachments: readonly ChatAttachmentInput[],
): ChatAttachmentInput[] {
  const seen = new Set<string>();
  const unique: ChatAttachmentInput[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.attachmentId !== 'string') continue;
    if (attachment.attachmentId.length === 0 || seen.has(attachment.attachmentId)) {
      continue;
    }
    seen.add(attachment.attachmentId);
    unique.push(attachment);
  }
  return unique;
}
