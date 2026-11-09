import { useAuiState, useLocalRuntime } from '@assistant-ui/react';
import { useMemo } from 'react';
import { createAgentChatAdapter } from './agent-chat-adapter';

/**
 * Builds one LocalRuntime for the ambient remote thread-list item.
 *
 * `threadListItem.id` is assistant-ui's stable local id, including the period before `initialize`
 * supplies a remote Conversation id. The adapter therefore never changes its draft-store key while
 * a first send is in flight.
 */
export function useConversationRuntime() {
  const localThreadId = useAuiState((state) => state.threadListItem.id);
  const adapter = useMemo(
    () => createAgentChatAdapter(localThreadId),
    [localThreadId],
  );
  return useLocalRuntime(adapter);
}
