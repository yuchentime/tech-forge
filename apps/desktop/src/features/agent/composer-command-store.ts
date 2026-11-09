/**
 * The command chip currently attached to the composer, if any.
 *
 * The command lives outside the textarea so the input can show a chip instead of raw `/查询资料库`
 * text; the adapter prepends the stored command when the turn is sent, so the backend contract is
 * unchanged and the stored user message still carries what the parser expects.
 */
class ComposerCommandStore {
  private readonly byThreadId = new Map<string, string | null>();
  private activeThreadId = 'draft';
  private readonly listeners = new Set<() => void>();

  /** Returns the current command text (or null) for `useSyncExternalStore`. */
  getSnapshot = (): string | null => this.byThreadId.get(this.activeThreadId) ?? null;

  /** Selects the command chip namespace rendered by the visible composer. */
  setActiveThread(threadId: string): void {
    if (this.activeThreadId === threadId) return;
    this.activeThreadId = threadId;
    this.emit();
  }

  /** Subscribes one React listener; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Attaches or clears the command and notifies listeners once. */
  setCommand(command: string | null, threadId: string = this.activeThreadId): void {
    if ((this.byThreadId.get(threadId) ?? null) === command) return;
    this.byThreadId.set(threadId, command);
    this.emit();
  }

  /** Clears the chip; used after a send and when the thread resets. */
  reset(threadId: string = this.activeThreadId): void {
    this.setCommand(null, threadId);
  }

  /** Reads a command for the adapter's stable local thread id. */
  getForThread(threadId: string): string | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Shared composer command state, read by the page and by the chat adapter. */
export const composerCommandStore = new ComposerCommandStore();
