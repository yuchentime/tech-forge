import { BookmarkSimple } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';

/** Matches the backend note limit; counted in Unicode code points so emoji count once. */
const NOTE_MAX_CHARACTERS = 2000;

/**
 * Captures the optional study note before an excerpt is saved.
 *
 * The note is optional: "保存备注" with an empty field still saves the excerpt, and Ctrl/⌘+Enter
 * does the same from the keyboard. The field starts as one line and grows on every Enter or wrap;
 * Enter itself inserts a newline so multi-line notes never submit by accident.
 */
export function AddLearnNoteDialog({
  quote,
  onCancel,
  onSave,
}: {
  /** The selected text, shown so the user keeps context while writing the note. */
  quote: string;
  onCancel: () => void;
  onSave: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const noteId = useId();
  const characterCount = Array.from(note).length;

  // Grow with the content instead of showing an inner scrollbar on the first lines.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [note]);

  // Escape must cancel even after a click moved focus off the textarea (e.g. onto the backdrop).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isSaving) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSaving, onCancel]);

  /** Saves the excerpt with the current note; failures stay in the dialog. */
  const submit = async (): Promise<void> => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await onSave(note.trim());
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : '添加学习笔记失败，请重试。',
      );
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSaving) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-labelledby={`${noteId}-title`}
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-ink-200 bg-white p-5 shadow-float"
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-honey-100 text-honey-500">
            <BookmarkSimple aria-hidden="true" className="size-5" weight="fill" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900" id={`${noteId}-title`}>
              添加到学习笔记
            </h2>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              备注可选，留着记录你的理解或复习要点。
            </p>
          </div>
        </div>

        <blockquote className="mt-4 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border-l-2 border-brand-300 bg-ink-100/60 px-3 py-2 text-xs leading-5 text-ink-700">
          {quote}
        </blockquote>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block text-xs font-medium text-ink-600" htmlFor={noteId}>
            备注（可选）
          </label>
          <textarea
            autoFocus
            className="mt-1.5 max-h-40 w-full resize-none overflow-y-auto rounded-xl border border-ink-300 px-3 py-2 text-sm leading-6 text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
            id={noteId}
            onChange={(event) => {
              // Bound in code points so the draft never exceeds what the backend stores.
              setNote(
                Array.from(event.target.value).slice(0, NOTE_MAX_CHARACTERS).join(''),
              );
            }}
            onKeyDown={(event) => {
              // Ctrl/⌘+Enter saves; plain Enter stays a newline so notes can span lines.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="写下理解、疑问或想复习的点…"
            ref={textareaRef}
            rows={1}
            value={note}
          />
          <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-ink-500">
            <span>Enter 换行，Ctrl + Enter 保存</span>
            <span className="tabular-nums">
              {characterCount}/{NOTE_MAX_CHARACTERS}
            </span>
          </div>
          {error && (
            <p className="mt-2 text-xs text-rose-700" role="alert">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded-xl border border-ink-200 bg-white px-4 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isSaving}
              onClick={onCancel}
              type="button"
            >
              取消
            </button>
            <button
              className="rounded-xl bg-brand-800 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              disabled={isSaving}
              type="submit"
            >
              {isSaving ? '正在保存…' : '保存备注'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
