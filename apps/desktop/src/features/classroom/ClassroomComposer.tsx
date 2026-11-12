import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

/** Which message the classroom composer is currently collecting. */
export type ClassroomComposerVariant = 'lecture' | 'reply';

/**
 * Message box of the classroom stage.
 *
 * It only shares the *look* of the conversation composer: a classroom turn carries no attachments
 * and no slash commands, and its text is owned by the caller while the classroom flow is still a
 * prototype. `lecture` is the tall four-line box the teacher writes the explanation in; `reply` is
 * the single-line box used to answer a student's question.
 */
export function ClassroomComposer({
  value,
  onChange,
  onSend,
  variant = 'lecture',
  disabled = false,
  autoFocus = false,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called with the current draft when the box is submitted; the caller trims it. */
  onSend: () => void;
  variant?: ClassroomComposerVariant;
  /** Blocks typing and sending while the visible conversation is still loading. */
  disabled?: boolean;
  /** Focuses the box when it mounts; used when the reply box replaces the lecture box. */
  autoFocus?: boolean;
  /** Layout-only additions for the card; visual tokens stay inside this component. */
  className?: string;
}) {
  const canSend = !disabled && value.trim().length > 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSend) onSend();
  };

  /** Ctrl/Cmd+Enter submits, matching the conversation composer; plain Enter adds a line. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const cardClass = `relative rounded-3xl border border-ink-200 bg-white p-3 transition-colors duration-200 ease-out focus-within:border-brand-500 motion-reduce:transition-none ${className}`;

  if (variant === 'reply') {
    return (
      <form className={cardClass} onSubmit={handleSubmit}>
        <div className="flex items-center gap-2">
          <textarea
            aria-label="回答学生"
            autoFocus={autoFocus}
            className="tf-scrollbar h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400"
            disabled={disabled}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="回答学生…Ctrl + Enter 发送"
            rows={1}
            value={value}
          />
          <button
            className="shrink-0 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canSend}
            type="submit"
          >
            发送
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className={cardClass} onSubmit={handleSubmit}>
      <textarea
        aria-label="发送讲解"
        autoFocus={autoFocus}
        className="tf-scrollbar h-24 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400"
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="写下你准备讲给学生的内容…"
        value={value}
      />
      <div className="mt-2 flex items-center justify-between border-t border-ink-100 pt-2">
        <span className="text-xs text-ink-500">Ctrl + Enter 发送</span>
        <button
          className="rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSend}
          type="submit"
        >
          发送
        </button>
      </div>
    </form>
  );
}
