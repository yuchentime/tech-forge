import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import { useSyncExternalStore } from 'react';
import { agentEventBus } from './agent-event-bus';

/** Renders the text-only Agent thread and its send/stop controls. */
export function AgentChatPage() {
  const activity = useSyncExternalStore(
    agentEventBus.subscribe,
    agentEventBus.getSnapshot,
    agentEventBus.getSnapshot,
  );

  return (
    <section className="mx-auto flex h-full w-full max-w-5xl flex-col px-5 py-5 md:px-8">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-stone-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">备课助手</h1>
          <p className="mt-1 text-sm text-stone-500">问题与回答只保留在当前应用运行期间。</p>
        </div>
        <p className="max-w-xl text-xs leading-5 text-stone-600">
          运行期间会显示当前工具和参数；工具执行结果不会进入对话。
        </p>
      </header>

      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3">
          <AuiIf condition={(state) => state.thread.isEmpty}>
            <div className="my-auto rounded-2xl border border-dashed border-stone-300 bg-white/70 px-6 py-10 text-center">
              <p className="text-sm font-medium text-stone-800">从一个备课问题开始</p>
              <p className="mt-2 text-sm leading-6 text-stone-500">
                例如：帮我用一个生活中的例子解释缓存雪崩。
              </p>
            </div>
          </AuiIf>

          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === 'user' ? <UserMessage /> : <AssistantMessage />
            }
          </ThreadPrimitive.Messages>

          <AgentActivity activity={activity} />

          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 pt-3">
            <ComposerPrimitive.Root className="rounded-2xl border border-stone-300 bg-white p-3 focus-within:border-emerald-800 focus-within:ring-2 focus-within:ring-emerald-800/10">
              <ComposerPrimitive.Input
                aria-label="发送给备课助手"
                className="min-h-24 w-full resize-y bg-transparent px-1 py-1 text-sm leading-6 text-stone-900 outline-none placeholder:text-stone-400"
                placeholder="写下你正在准备的内容或问题…"
                rows={3}
                submitMode="ctrlEnter"
              />
              <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2">
                <span className="text-xs text-stone-500">Ctrl + Enter 发送</span>
                <div className="flex items-center gap-2">
                  <AuiIf condition={(state) => state.thread.isRunning}>
                    <ComposerPrimitive.Cancel className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-50">
                      停止生成
                    </ComposerPrimitive.Cancel>
                  </AuiIf>
                  <AuiIf condition={(state) => !state.thread.isRunning}>
                    <ComposerPrimitive.Send className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40">
                      发送
                    </ComposerPrimitive.Send>
                  </AuiIf>
                </div>
              </div>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </section>
  );
}

/** Shows request activity separately from the assistant's streamed answer. */
function AgentActivity({
  activity,
}: {
  activity: ReturnType<typeof agentEventBus.getSnapshot>;
}) {
  if (activity.phase === 'idle') return null;

  const label = activity.tools.length
    ? `正在使用 ${activity.tools.length > 1 ? '多个工具' : activity.tools[0].toolName}`
    : activity.phase === 'responding'
      ? '正在生成回答'
      : '正在处理中';

  return (
    <div
      aria-live="polite"
      className="mx-auto w-full max-w-[90%] shrink-0 rounded-xl border border-emerald-900/15 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-950"
      role="status"
    >
      <p className="font-medium">{label}</p>
      {activity.tools.map((tool) => (
        <details className="mt-2" key={tool.toolCallId}>
          <summary className="cursor-pointer text-xs text-emerald-900">
            查看 {tool.toolName} 参数
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/80 p-2 text-xs leading-5 text-stone-700">
            {JSON.stringify(tool.args, null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

/** Displays the user's message with right-aligned emphasis. */
function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[82%] rounded-2xl rounded-br-md bg-stone-100 px-4 py-3 text-sm leading-6 text-stone-900">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

/** Displays assistant text and safe errors; activity events use AgentActivity. */
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-stone-200 bg-white px-4 py-3 text-sm leading-6 text-stone-800">
        <MessagePrimitive.Parts />
        <MessagePrimitive.Error>
          <p className="mt-2 text-sm text-rose-700" role="alert">
            这次回答没有完成，请检查模型配置或网络后重试。
          </p>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}
