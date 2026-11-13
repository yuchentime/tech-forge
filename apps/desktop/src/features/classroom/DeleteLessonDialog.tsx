import { WarningCircle } from '@phosphor-icons/react';
import { useEffect } from 'react';

/**
 * Confirms deleting one history classroom.
 *
 * Deletion removes the lesson row, its summary and the local transcript, so the dialog names the
 * consequence and defaults focus to "取消". `Esc` or a backdrop click cancels.
 */
export function DeleteLessonDialog({
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  /** Human-readable lesson time shown in the title. */
  label: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-describedby="delete-lesson-description"
        aria-labelledby="delete-lesson-title"
        aria-modal="true"
        className="w-full max-w-sm rounded-2xl border border-ink-200 bg-white p-5 shadow-float"
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-700">
            <WarningCircle aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900" id="delete-lesson-title">
              删除课堂 · {label}
            </h2>
            <p
              className="mt-1.5 text-sm leading-6 text-ink-600"
              id="delete-lesson-description"
            >
              课堂记录与总结会被永久删除，无法恢复。
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            className="rounded-xl border border-ink-200 bg-white px-4 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-800 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? '正在删除…' : '删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
