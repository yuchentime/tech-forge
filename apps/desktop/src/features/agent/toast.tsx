import { useSyncExternalStore } from 'react';

/** One transient notification shown above the composer. */
export interface ToastMessage {
  id: number;
  text: string;
}

const TOAST_DURATION_MS = 3_000;

/**
 * Holds the app's only transient notifications.
 *
 * The artifact sidebar needs a "file does not exist" notice on click, and the repository has no
 * dialog or toast primitive yet; this keeps that surface to one small store plus one host.
 */
class ToastStore {
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<number, number>();
  private nextId = 1;
  private snapshot: readonly ToastMessage[] = [];

  /** Subscribes the host to toast list changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the current toast list. */
  getSnapshot = (): readonly ToastMessage[] => this.snapshot;

  /** Shows one toast and removes it after a fixed delay. */
  show(text: string): void {
    const id = this.nextId++;
    this.snapshot = [...this.snapshot, { id, text }];
    this.listeners.forEach((listener) => listener());
    const timer = window.setTimeout(() => {
      this.timers.delete(id);
      this.dismiss(id);
    }, TOAST_DURATION_MS);
    this.timers.set(id, timer);
  }

  /** Removes one toast immediately. */
  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.timers.delete(id);
    }
    const next = this.snapshot.filter((toast) => toast.id !== id);
    if (next.length === this.snapshot.length) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const toastStore = new ToastStore();

/** Publishes one transient message; the text must already be user-facing. */
export function showToast(text: string): void {
  toastStore.show(text);
}

/** Renders every active toast in a fixed, non-blocking layer. */
export function ToastHost(): React.ReactElement | null {
  const toasts = useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    toastStore.getSnapshot,
  );
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 px-4"
      role="status"
    >
      {toasts.map((toast) => (
        <div
          className="pointer-events-auto rounded-lg bg-ink-900/92 px-4 py-2 text-sm text-white shadow-lg"
          key={toast.id}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
