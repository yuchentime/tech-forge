/**
 * The command chip currently attached to the composer, if any.
 *
 * The command lives outside the textarea so the input can show a chip instead of raw `/查询资料库`
 * text; the adapter prepends the stored command when the turn is sent, so the backend contract is
 * unchanged and the stored user message still carries what the parser expects.
 */
class ComposerCommandStore {
  private command: string | null = null;
  private readonly listeners = new Set<() => void>();

  /** Returns the current command text (or null) for `useSyncExternalStore`. */
  getSnapshot = (): string | null => this.command;

  /** Subscribes one React listener; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Attaches or clears the command and notifies listeners once. */
  setCommand(command: string | null): void {
    if (this.command === command) return;
    this.command = command;
    for (const listener of this.listeners) listener();
  }

  /** Clears the chip; used after a send and when the thread resets. */
  reset(): void {
    this.setCommand(null);
  }
}

/** Shared composer command state, read by the page and by the chat adapter. */
export const composerCommandStore = new ComposerCommandStore();
