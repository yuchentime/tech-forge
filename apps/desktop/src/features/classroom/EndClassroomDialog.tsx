import { WarningCircle } from '@phosphor-icons/react';
import { useEffect, useId, useRef } from 'react';

/**
 * Confirms ending a classroom session.
 *
 * Ending is irreversible (the round is cleared), so the dialog names the consequence, defaults the
 * focus to "继续上课", closes on `Esc` or a backdrop click, and traps Tab inside the card.
 */
export function EndClassroomDialog({
  hasUnsavedDraft,
  onCancel,
  onConfirm,
}: {
  /** Adds a warning that the text currently in the composer will not be kept. */
  hasUnsavedDraft: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Escape closes the dialog instead of leaving the classroom, and Tab stays inside it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
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
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-sm rounded-2xl border border-ink-200 bg-white p-5 shadow-xl"
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <WarningCircle
            aria-hidden="true"
            className="mt-0.5 size-6 shrink-0 text-rose-600"
            weight="fill"
          />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900" id={titleId}>
              结束本节课？
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-600" id={descriptionId}>
              结束后，本节课的讲稿、提问与你的回答会整理为课堂记录，并返回对话。
            </p>
            {hasUnsavedDraft && (
              <p className="mt-2 text-sm leading-6 text-rose-700">正在编辑的内容不会保存。</p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            className="rounded-lg px-3 py-1.5 text-sm text-ink-700 transition hover:bg-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onCancel}
            type="button"
          >
            继续上课
          </button>
          <button
            className="rounded-lg bg-rose-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onConfirm}
            type="button"
          >
            结束课堂
          </button>
        </div>
      </div>
    </div>
  );
}
