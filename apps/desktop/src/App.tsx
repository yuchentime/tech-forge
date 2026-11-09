import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
} from '@assistant-ui/react';
import { AgentChatPage } from './features/agent/AgentChatPage';
import { useConversationRuntime } from './features/agent/conversation-runtime';
import { conversationStore } from './features/agent/conversation-store';
import { threadListAdapter } from './features/agent/thread-list-adapter';

/** Owns the long-lived Agent runtime and fills the application window with chat. */
export default function App() {
  const runtime = useRemoteThreadListRuntime({
    adapter: threadListAdapter,
    runtimeHook: useConversationRuntime,
    // Only the selected thread announces its remote id, so a background initialization cannot
    // steal the persisted selection from the conversation currently on screen.
    onThreadIdChange: (remoteId) => conversationStore.setActiveConversationId(remoteId ?? null),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="h-dvh min-h-0 w-full overflow-hidden bg-white text-stone-900">
        <AgentChatPage runtime={runtime} />
      </main>
    </AssistantRuntimeProvider>
  );
}
