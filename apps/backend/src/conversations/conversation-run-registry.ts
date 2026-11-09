import { Injectable } from '@nestjs/common';

/**
 * Serializes state-changing work for one conversation inside this backend process.
 *
 * A queued chat claims its slot synchronously, so a concurrent deletion can distinguish it from
 * an idle conversation without waiting for an asynchronous database read. Deletion uses the same
 * tail as chat work: it rejects an already claimed slot, but a later chat waits for deletion and
 * then lets `beginTurn` report that the conversation no longer exists.
 */
@Injectable()
export class ConversationRunRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  /** Claims the next serialized chat slot and resolves with its idempotent release function. */
  async acquire(conversationId: string): Promise<() => void> {
    const previous = this.tails.get(conversationId);
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    // Store before awaiting the predecessor so delete sees both active and queued requests.
    this.tails.set(conversationId, current);
    await previous;
    return this.releaseFor(conversationId, current, resolveCurrent);
  }

  /**
   * Atomically reserves deletion when no chat or earlier deletion owns the conversation.
   *
   * This deliberately contains no await: a check followed by an async transaction would leave a
   * window in which a newly accepted chat could start against the rows being deleted.
   */
  tryAcquireDeletion(conversationId: string): (() => void) | null {
    if (this.tails.has(conversationId)) return null;
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.tails.set(conversationId, current);
    return this.releaseFor(conversationId, current, resolveCurrent);
  }

  /** Reports whether an active, queued, or deleting operation has claimed this conversation. */
  isBusy(conversationId: string): boolean {
    return this.tails.has(conversationId);
  }

  /** Produces an idempotent release that never removes a newer queued tail. */
  private releaseFor(
    conversationId: string,
    current: Promise<void>,
    resolveCurrent: () => void,
  ): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (this.tails.get(conversationId) === current) {
        this.tails.delete(conversationId);
      }
    };
  }
}
