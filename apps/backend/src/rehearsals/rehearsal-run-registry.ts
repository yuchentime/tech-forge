import { randomUUID } from 'node:crypto';

/** One in-process lease for a rehearsal's model call. */
export interface RehearsalRunLease {
  token: string;
  controller: AbortController;
  /** Releases the lease and resolves any waiter; idempotent. */
  finish: () => void;
}

interface ActiveRehearsalRun {
  token: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

/**
 * Serializes answer/skip/report calls per rehearsal and lets `end` abort an in-flight call.
 *
 * The backend is single-process, so an in-process map is the whole lock. The token prevents a
 * settled old run from deleting a newer lease.
 */
export class RehearsalRunRegistry {
  private readonly runs = new Map<string, ActiveRehearsalRun>();

  /** Starts one lease, or returns null when the rehearsal already has an active call. */
  begin(rehearsalId: string): RehearsalRunLease | null {
    if (this.runs.has(rehearsalId)) return null;

    const token = randomUUID();
    const controller = new AbortController();
    const deferred = Promise.withResolvers<void>();
    const active: ActiveRehearsalRun = {
      token,
      controller,
      done: deferred.promise,
      finish: deferred.resolve,
    };
    this.runs.set(rehearsalId, active);

    return {
      token,
      controller,
      finish: () => {
        if (this.runs.get(rehearsalId)?.token !== token) return;
        this.runs.delete(rehearsalId);
        active.finish();
      },
    };
  }

  /** Returns whether a rehearsal currently owns a run. */
  isActive(rehearsalId: string): boolean {
    return this.runs.has(rehearsalId);
  }

  /** Returns whether the given token is still the current lease. */
  isCurrent(rehearsalId: string, token: string): boolean {
    return this.runs.get(rehearsalId)?.token === token;
  }

  /** Aborts the current call without waiting for it to settle. */
  abort(rehearsalId: string): void {
    this.runs.get(rehearsalId)?.controller.abort();
  }

  /** Waits until the current call settles; resolves immediately when no call is active. */
  async wait(rehearsalId: string): Promise<void> {
    const active = this.runs.get(rehearsalId);
    if (active) await active.done;
  }
}
