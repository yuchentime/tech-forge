import { AuiIf, ComposerPrimitive } from '@assistant-ui/react';

/**
 * Message box of the classroom stage.
 *
 * It intentionally shares only the *look* of the conversation composer: a classroom turn is a
 * lecture or an answer, so there is no attachment picker and no slash commands (the knowledge-base
 * and deep-research commands belong to the备课 conversation). The card classes mirror
 * `MessageComposer`'s card so switching views does not restyle the input. Text, draft and the send
 * shortcut still go through assistant-ui's composer for the active thread, which is why a draft
 * written here shows up in the conversation view after leaving.
 */
export function ClassroomComposer({
  disabled = false,
  className = '',
}: {
  /** Blocks typing and sending while the visible conversation is still loading. */
  disabled?: boolean;
  /** Layout-only additions for the card; visual tokens stay inside this component. */
  className?: string;
}) {
  return (
    <ComposerPrimitive.Root
      className={`relative rounded-3xl border border-ink-200 bg-white p-3 transition-colors duration-200 ease-out focus-within:border-brand-500 motion-reduce:transition-none ${className}`}
    >
      <ComposerPrimitive.Input
        aria-label="课堂发言"
        className="h-24 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400 tf-composer-input"
        disabled={disabled}
        placeholder="写下你准备讲给学生的内容…"
        // Same fixed-height input as the conversation composer: long content scrolls inside.
        render={<textarea />}
        submitMode="ctrlEnter"
      />
      <div className="mt-2 flex items-center justify-between border-t border-ink-100 pt-2">
        <span className="text-xs text-ink-500">Ctrl + Enter 发送</span>
        <div className="flex items-center gap-2">
          <AuiIf condition={(state) => state.thread.isRunning}>
            <ComposerPrimitive.Cancel className="rounded-xl border border-ink-200 px-3 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-50">
              停止生成
            </ComposerPrimitive.Cancel>
          </AuiIf>
          <AuiIf condition={(state) => !state.thread.isRunning}>
            <ComposerPrimitive.Send
              className="rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
            >
              发送
            </ComposerPrimitive.Send>
          </AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
