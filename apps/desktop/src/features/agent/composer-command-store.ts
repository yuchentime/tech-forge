import type { SlashCommandId } from './slash-commands';

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

/**
 * Commands recorded on messages that have already been sent.
 *
 * The live turn records them when the adapter sends; a history reload rebuilds the same keys from the
 * persisted API rows, so the chip above a user message survives a restart. Ids match the backend's
 * `contextRefsJson.commands` values.
 */
class SentCommandStore {
  private byMessageId: Record<string, SlashCommandId[]> = {};
  private readonly listeners = new Set<() => void>();

  /** Returns the message-id map for `useSyncExternalStore`; the object identity is stable. */
  getSnapshot = (): Record<string, SlashCommandId[]> => this.byMessageId;

  /** Subscribes one React listener; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Records the commands sent with one live user message. */
  record(messageId: string, commands: SlashCommandId[]): void {
    if (commands.length === 0) return;
    this.byMessageId = { ...this.byMessageId, [messageId]: commands };
    this.emit();
  }

  /** Restores the commands of one persisted message after a history page loads. */
  restoreHistory(messageId: string, commands: SlashCommandId[]): void {
    if (commands.length === 0) return;
    this.byMessageId = { ...this.byMessageId, [messageId]: commands };
    this.emit();
  }

  /** Drops every chip when the thread is reset or replaced. */
  reset(): void {
    if (Object.keys(this.byMessageId).length === 0) return;
    this.byMessageId = {};
    this.emit();
  }

  /** Notifies every listener after the snapshot was replaced. */
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Shared sent-command state, read by the page and written by the chat adapter. */
export const sentCommandStore = new SentCommandStore();
