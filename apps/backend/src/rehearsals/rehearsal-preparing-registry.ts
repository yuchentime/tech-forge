import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  RehearsalPreparingPhase,
  RehearsalPreparingView,
} from './rehearsal.types';

/** Entries older than this are dropped; covers the longest start (three 90s calls plus retries). */
const PREPARING_TTL_MS = 10 * 60_000;

/** One claimed start, keyed by conversation because a conversation has one active rehearsal. */
interface PreparingEntry {
  rehearsalId: string;
  phase: RehearsalPreparingPhase;
  token: string;
  updatedAt: number;
}

/**
 * Process-local, read-only view of the start request currently preparing a drill.
 *
 * It exists only so the renderer can name the phase it is waiting on. Nothing here affects
 * persistence, the state machine or error mapping: losing an entry only degrades the copy.
 * Each `start()` claims a token so a replay or a racing request can never overwrite a live phase.
 */
@Injectable()
export class RehearsalPreparingRegistry {
  private readonly entries = new Map<string, PreparingEntry>();

  /**
   * Claims the conversation for one start attempt.
   *
   * Returns the run token, or null when another live attempt already owns the conversation.
   * Callers treat null as "no phase reporting", never as a failure.
   */
  begin(conversationId: string, rehearsalId: string): string | null {
    const existing = this.entries.get(conversationId);
    if (existing && !this.isExpired(existing)) return null;
    const token = randomUUID();
    this.entries.set(conversationId, {
      rehearsalId,
      phase: 'history',
      token,
      updatedAt: Date.now(),
    });
    return token;
  }

  /** Advances the phase for the claiming token; ignores stale or foreign writes. */
  setPhase(
    conversationId: string,
    token: string,
    phase: RehearsalPreparingPhase,
  ): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.token !== token || this.isExpired(entry)) return;
    entry.phase = phase;
    entry.updatedAt = Date.now();
  }

  /** Returns the current phase for the preparing screen, or null when nothing is in flight. */
  read(conversationId: string): RehearsalPreparingView | null {
    const entry = this.entries.get(conversationId);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(conversationId);
      return null;
    }
    return {
      rehearsalId: entry.rehearsalId,
      phase: entry.phase,
    };
  }

  /** Clears the entry only for the claiming token, so a replay cannot erase a live phase. */
  finish(conversationId: string, token: string): void {
    const entry = this.entries.get(conversationId);
    if (entry?.token === token) this.entries.delete(conversationId);
  }

  /** Treats an entry as gone once it has not advanced for the TTL. */
  private isExpired(entry: PreparingEntry): boolean {
    return Date.now() - entry.updatedAt > PREPARING_TTL_MS;
  }
}
