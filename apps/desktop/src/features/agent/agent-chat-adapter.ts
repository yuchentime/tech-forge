import type {
  ChatModelAdapter,
  ThreadMessage,
} from '@assistant-ui/react';
import type { ChatStreamEvent } from '../../types/desktop-bridge';
import { agentEventBus } from './agent-event-bus';
import {
  composerAttachmentStore,
  sentAttachmentStore,
} from './attachment-store';
import { composerCommandStore } from './composer-command-store';
import { conversationStore } from './conversation-store';

/** Extracts the newest user message because the backend runs each turn alone. */
function getLatestUserMessage(messages: readonly ThreadMessage[]): {
  id: string;
  prompt: string;
} | null {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'user');
  if (!message) return null;

  return {
    id: message.id,
    prompt: message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim(),
  };
}

/** Adapts the protected desktop stream bridge to Assistant UI cumulative output. */
export const agentChatAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const userMessage = getLatestUserMessage(messages);
    if (!userMessage?.prompt) throw new Error('请输入文本后再发送。');
    if (abortSignal.aborted) return;

    const queuedEvents: ChatStreamEvent[] = [];
    let nextEvent: ((event: ChatStreamEvent | null) => void) | undefined;
    let requestId = '';
    let terminal = false;
    let accumulatedText = '';

    const receiveEvent = (event: ChatStreamEvent): void => {
      if (nextEvent) {
        const resolve = nextEvent;
        nextEvent = undefined;
        resolve(event);
      } else {
        queuedEvents.push(event);
      }
    };
    const takeNextEvent = (): Promise<ChatStreamEvent | null> => {
      const event = queuedEvents.shift();
      if (event) return Promise.resolve(event);
      return new Promise((resolve) => {
        nextEvent = resolve;
      });
    };
    const cancel = (): void => {
      if (requestId) window.teachforge.cancelChatStream(requestId);
      const resolve = nextEvent;
      nextEvent = undefined;
      resolve?.(null);
    };

    // The chip never enters the textarea, so the command is attached here. It is part of the stored
    // user message, which is what the backend parses and what dedupe reads back later.
    const command = composerCommandStore.getSnapshot();
    const prompt = command ? `${command} ${userMessage.prompt}` : userMessage.prompt;
    // Attachments are copied and parsed when the turn runs, because the conversation id does not
    // exist before this request. The tag list is recorded against the message so the sent bubble
    // shows what was attached, and then cleared.
    const attachments = composerAttachmentStore.list();
    requestId = window.teachforge.streamChat(
      prompt,
      receiveEvent,
      conversationStore.getSnapshot().activeConversationId ?? undefined,
      attachments.length > 0
        ? attachments.map(({ attachmentId, path }) => ({ attachmentId, path }))
        : undefined,
    );
    const messageKey = userMessage.id || requestId;
    if (attachments.length > 0) {
      sentAttachmentStore.record(
        messageKey,
        attachments.map(({ attachmentId, name }) => ({ attachmentId, name })),
      );
    }
    composerAttachmentStore.reset();
    composerCommandStore.reset();
    agentEventBus.begin(messageKey, requestId);
    abortSignal.addEventListener('abort', cancel, { once: true });
    if (abortSignal.aborted) cancel();

    try {
      while (!abortSignal.aborted) {
        const event = await takeNextEvent();
        if (!event) return;

        if (event.type === 'conversation') {
          conversationStore.setActiveConversationId(event.conversationId);
          void conversationStore.refresh();
          continue;
        }

        agentEventBus.publish(requestId, event);

        if (
          event.type === 'message_update' &&
          event.assistantMessageEvent.type === 'text_delta'
        ) {
          accumulatedText += event.assistantMessageEvent.delta;
          yield { content: [{ type: 'text', text: accumulatedText }] };
        } else if (event.type === 'done') {
          terminal = true;
          return;
        } else if (event.type === 'error') {
          terminal = true;
          throw new Error(event.message);
        }
      }
    } finally {
      abortSignal.removeEventListener('abort', cancel);
      if (!terminal) cancel();
      if (requestId) {
        agentEventBus.clear(requestId);
        void conversationStore.refresh();
      }
    }
  },
};
