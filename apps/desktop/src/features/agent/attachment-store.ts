/**
 * Renderer-local attachment state for the Agent composer.
 *
 * Two stores share one file because they are two halves of the same lifecycle: the picked file lives
 * in the composer until send, then reappears as a tag on the message that carried it. Neither store
 * holds file bytes or extracted text — only the path the backend copies from, and the id it uses to
 * name the conversation's attachment folder.
 */

/** One file the user picked for the message being composed. */
export interface ComposerAttachment {
  /** Renderer-local key for React lists; the attachment id is what the backend stores. */
  id: number;
  attachmentId: string;
  name: string;
  /** Absolute path from the native picker; never sent to the UI as content. */
  path: string;
}

/** One attachment already sent with a message. */
export interface SentAttachment {
  attachmentId: string;
  name: string;
}

/** Stable empty value required by React's external-store snapshot contract. */
const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachment[] = [];

/**
 * Files picked for the message currently being written.
 *
 * The upload happens at send time, when the conversation id exists, so a chip here is only a
 * reference: picking a file no longer needs a round trip or a parse state.
 */
class ComposerAttachmentStore {
  private readonly byThreadId = new Map<string, ComposerAttachment[]>();
  private activeThreadId = 'draft';
  private nextId = 0;
  private readonly listeners = new Set<() => void>();

  /** Returns the current chips for `useSyncExternalStore`; the array identity is stable. */
  getSnapshot = (): ComposerAttachment[] =>
    this.byThreadId.get(this.activeThreadId) ?? EMPTY_COMPOSER_ATTACHMENTS;

  /** Selects the draft namespace rendered by the visible composer. */
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

  /** Adds one picked file; the attachment id is minted here so the message and folder agree. */
  add(name: string, path: string, threadId: string = this.activeThreadId): void {
    this.byThreadId.set(threadId, [
      ...(this.byThreadId.get(threadId) ?? []),
      { id: this.nextId++, attachmentId: crypto.randomUUID(), name, path },
    ]);
    this.emit();
  }

  /** Removes one chip without touching the picked file. */
  remove(id: number, threadId: string = this.activeThreadId): void {
    this.byThreadId.set(threadId, (this.byThreadId.get(threadId) ?? []).filter((item) => item.id !== id));
    this.emit();
  }

  /** Clears every chip after a send, a thread switch or a new conversation. */
  reset(threadId: string = this.activeThreadId): void {
    if ((this.byThreadId.get(threadId) ?? []).length === 0) return;
    this.byThreadId.set(threadId, []);
    this.emit();
  }

  /** Returns the pending attachments in pick order, ready for the send request. */
  list(threadId: string = this.activeThreadId): Array<{ attachmentId: string; name: string; path: string }> {
    return (this.byThreadId.get(threadId) ?? []).map(({ attachmentId, name, path }) => ({
      attachmentId,
      name,
      path,
    }));
  }

  /** Reads pending files for an adapter bound to one stable local thread. */
  getForThread(threadId: string): Array<{ attachmentId: string; name: string; path: string }> {
    return this.list(threadId);
  }

  /** Notifies every listener after the snapshot was replaced. */
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Attachments that were sent with a message, keyed by the renderer's user-message id.
 *
 * The live turn records them when the adapter sends; a history reload rebuilds the same keys from the
 * persisted API rows, so a tag survives a restart without putting file text in the thread message.
 */
class SentAttachmentStore {
  private byMessageId: Record<string, SentAttachment[]> = {};
  private readonly listeners = new Set<() => void>();

  /** Returns the message-id map for `useSyncExternalStore`; the object identity is stable. */
  getSnapshot = (): Record<string, SentAttachment[]> => this.byMessageId;

  /** Subscribes one React listener; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Records the attachments sent with one live user message. */
  record(messageId: string, attachments: SentAttachment[]): void {
    if (attachments.length === 0) return;
    this.byMessageId = { ...this.byMessageId, [messageId]: attachments };
    this.emit();
  }

  /** Restores the tags of one persisted message after a history page loads. */
  restoreHistory(messageId: string, attachments: SentAttachment[]): void {
    if (attachments.length === 0) return;
    this.byMessageId = { ...this.byMessageId, [messageId]: attachments };
    this.emit();
  }

  /** Drops every tag when the thread is reset or replaced. */
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

/** Shared composer attachment state, read by the page and by the chat adapter. */
export const composerAttachmentStore = new ComposerAttachmentStore();

/** Shared sent-attachment state, read by the page and written by the chat adapter. */
export const sentAttachmentStore = new SentAttachmentStore();
