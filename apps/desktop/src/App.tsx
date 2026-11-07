import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import { agentChatAdapter } from './features/agent/agent-chat-adapter';
import { AgentChatPage } from './features/agent/AgentChatPage';

/** Owns the long-lived Agent runtime and fills the application window with chat. */
export default function App() {
  const runtime = useLocalRuntime(agentChatAdapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="h-dvh min-h-0 w-full overflow-hidden bg-white text-stone-900">
        <AgentChatPage runtime={runtime} />
      </main>
    </AssistantRuntimeProvider>
  );
}
