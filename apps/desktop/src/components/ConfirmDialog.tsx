import { WarningCircle } from '@phosphor-icons/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Visual weight of the confirm action: `danger` for irreversible loss, `default` for a plain stop. */
export type ConfirmDialogTone = 'default' | 'danger';

/**
 * Owns the app's modal confirmation contract so callers only supply copy and callbacks.
 *
 * Rendered through a portal above the app shell (no clipping by scroll containers), it closes on
 * `Esc` or a backdrop click, keeps Tab inside the card, starts focus on the cancel button (the
 * safe choice), and returns focus to the trigger on close. The consequence is stated in the title
 * and description; `note` carries extra warnings such as unsaved input. The confirm button turns
 * rose for `danger` and swaps to `busyLabel` while the action is in flight.
 */
export function ConfirmDialog({
  title,
  description,
  note,
  confirmLabel,
  cancelLabel = '取消',
  busyLabel,
  busy = false,
  tone = 'default',
  onCancel,
  onConfirm,
}: {
  /** Short question naming the action, e.g. "结束本节课？". */
  title: string;
  /** What happens after confirming; keep it to one or two sentences. */
  description: ReactNode;
  /** Optional secondary warning, rendered in the tone's colour. */
  note?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Label shown on the confirm button while `busy`, e.g. "正在结束…". */
  busyLabel?: string;
  busy?: boolean;
  tone?: ConfirmDialogTone;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Escape cancels, Tab cycles inside the card, and focus returns to the trigger after closing.
  useEffect(() => {
    const trigger =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
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
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      trigger?.focus();
    };
  }, [onCancel]);

  const danger = tone === 'danger';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/25 p-4 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        aria-busy={busy || undefined}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="tf-rise w-full max-w-sm rounded-2xl border border-ink-200/70 bg-white p-5 shadow-float"
        ref={cardRef}
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full ${
              danger ? 'bg-rose-50 text-rose-600' : 'bg-brand-50 text-brand-600'
            }`}
          >
            <WarningCircle aria-hidden="true" className="size-5" weight="fill" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900" id={titleId}>
              {title}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-ink-600" id={descriptionId}>
              {description}
            </p>
            {note && (
              <p
                className={`mt-2 text-sm leading-6 ${danger ? 'text-rose-700' : 'text-brand-700'}`}
              >
                {note}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-xl border border-ink-200 bg-white px-4 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={`rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 ${
              danger
                ? 'bg-rose-700 hover:bg-rose-800 focus-visible:ring-rose-500/40'
                : 'bg-brand-600 hover:bg-brand-700 focus-visible:ring-brand-500/40'
            }`}
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
