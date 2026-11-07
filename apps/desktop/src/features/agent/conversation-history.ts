import type { ThreadMessageLike } from '@assistant-ui/react';
import type { ConversationHistoryMessage } from './conversation-store';

/** Converts a persisted text DTO to the message shape accepted by LocalRuntime. */
export function toThreadMessage(message: ConversationHistoryMessage): ThreadMessageLike {
  const converted: ThreadMessageLike = {
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.content }],
    createdAt: new Date(message.createdAt),
  };

  // Storage gives every role a status; LocalRuntime only accepts it on assistants.
  if (message.role === 'user') return converted;

  return {
    ...converted,
    status:
      message.status === 'completed'
        ? { type: 'complete', reason: 'stop' }
        : {
            type: 'incomplete',
            reason: message.status === 'cancelled' ? 'cancelled' : 'error',
          },
  };
}
