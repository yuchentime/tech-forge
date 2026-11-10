import { describeFailure } from '../../api/backend-error';
import {
  answerRehearsal,
  discardRehearsal,
  endRehearsal,
  getLatestRehearsal,
  getRehearsal,
  getRehearsalPersona,
  getRehearsalPreparing,
  listRehearsals,
  saveRehearsalPersona,
  skipRehearsal,
  startRehearsal,
  type RehearsalDetail,
  type RehearsalList,
  type RehearsalPreparing,
} from './rehearsal-api';

export type RehearsalView =
  | 'start'
  | 'session'
  | 'report'
  | 'history'
  | 'historyDetail';

export interface RehearsalSnapshot {
  conversationId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  detail: RehearsalDetail | null;
  view: RehearsalView;
  isStarting: boolean;
  /** Real phase of the in-flight start; null before the backend registers or after it settles. */
  preparing: RehearsalPreparing | null;
  /** True for the brief window where the bar fills to 100% before the view swaps. */
  preparingComplete: boolean;
  isSubmitting: boolean;
  /** True only while an answer evaluation is in flight; skip/report submits leave it false. */
  isEvaluatingAnswer: boolean;
  isEnding: boolean;
  pendingAnswer: {
    turnId: string;
    answer: string;
    requestId: string;
  } | null;
  answerError: string | null;
  /** Student persona saved on disk; shared by every conversation's drill. */
  persona: string;
  personaError: string | null;
  history: RehearsalList | null;
  historyStatus: 'idle' | 'loading' | 'ready' | 'error';
  historyError: string | null;
  historyDetail: RehearsalDetail | null;
  historyDetailLoading: boolean;
  historyDetailError: string | null;
  /** Increments when a batch completes so the normal-chat card can refresh. */
  completionVersion: number;
}

const INITIAL_SNAPSHOT: RehearsalSnapshot = {
  conversationId: null,
  status: 'idle',
  error: null,
  detail: null,
  view: 'start',
  isStarting: false,
  preparing: null,
  preparingComplete: false,
  isSubmitting: false,
  isEvaluatingAnswer: false,
  isEnding: false,
  pendingAnswer: null,
  answerError: null,
  persona: '',
  personaError: null,
  history: null,
  historyStatus: 'idle',
  historyError: null,
  historyDetail: null,
  historyDetailLoading: false,
  historyDetailError: null,
  completionVersion: 0,
};

/** How long the filled bar stays before the view swaps, so progress never jumps mid-way. */
const PREPARING_COMPLETE_HOLD_MS = 450;

/** Chooses the first view for a loaded rehearsal row. */
function viewFor(detail: RehearsalDetail): RehearsalView {
  if (detail.status === 'completed') return 'report';
  if (detail.status === 'failed') {
    return detail.turns.length > 0 ? 'report' : 'start';
  }
  return 'session';
}

/** Returns a random UUID for request idempotency. */
function requestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Shared rehearsal UI state.
 *
 * The active session stays in `detail` while history/detail views are open, so browsing past
 * batches never discards an in-progress question or the user's unsent answer.
 */
export class RehearsalStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: RehearsalSnapshot = INITIAL_SNAPSHOT;
  /** Invalidates an older preparing poll loop after the start settles or the conversation changes. */
  private preparingPollToken = 0;

  /** Subscribes React consumers to immutable snapshots. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the current immutable state. */
  getSnapshot = (): RehearsalSnapshot => this.snapshot;

  /** Replaces selected fields and notifies consumers. */
  private update(patch: Partial<RehearsalSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Clears all state, e.g. when there is no active conversation. */
  reset(): void {
    this.snapshot = INITIAL_SNAPSHOT;
    for (const listener of this.listeners) listener();
  }

  /** Loads the latest rehearsal for a conversation; no-op when already loaded. */
  async loadForConversation(conversationId: string | null): Promise<void> {
    if (!conversationId) {
      this.reset();
      return;
    }
    if (
      this.snapshot.conversationId === conversationId &&
      this.snapshot.status !== 'idle'
    ) {
      return;
    }

    this.update({
      ...INITIAL_SNAPSHOT,
      conversationId,
      status: 'loading',
    });
    // The persona file is global, not conversation-scoped: read it on entry and let a failure
    // degrade to the default persona instead of blocking the drill.
    const personaLoad = getRehearsalPersona().then(
      (result) => ({ persona: result.persona, personaError: null }),
      (error: unknown) => ({
        personaError: describeFailure(error, '学生画像加载失败。'),
      }),
    );
    try {
      const detail = await getLatestRehearsal(conversationId);
      if (this.snapshot.conversationId !== conversationId) return;
      const keepHistoryView =
        this.snapshot.view === 'history' ||
        this.snapshot.view === 'historyDetail';
      const lastTurn = detail?.turns.at(-1);
      const pendingAnswer =
        detail &&
        (detail.status === 'awaiting_answer' ||
          detail.status === 'evaluating') &&
        lastTurn &&
        (lastTurn.status === 'answer_saved' || lastTurn.status === 'failed') &&
        lastTurn.answer?.trim()
          ? {
              turnId: lastTurn.turnId,
              answer: lastTurn.answer,
              requestId: requestId(),
            }
          : null;
      this.update({
        status: 'ready',
        detail,
        pendingAnswer,
        ...(await personaLoad),
        ...(keepHistoryView
          ? {}
          : { view: detail ? viewFor(detail) : 'start' }),
      });
    } catch (error) {
      this.update({
        status: 'error',
        error: describeFailure(error, '演练状态加载失败。'),
        ...(await personaLoad),
      });
    }
  }

  /** Persists the shared persona; the start view calls it when the textarea loses focus. */
  async savePersona(persona: string): Promise<void> {
    this.update({ persona });
    try {
      const saved = await saveRehearsalPersona(persona);
      this.update({ persona: saved.persona, personaError: null });
    } catch (error) {
      this.update({
        personaError: describeFailure(error, '学生画像保存失败。'),
      });
    }
  }

  /** Re-reads the latest rehearsal after a load error. */
  async reload(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId || this.snapshot.isStarting) return;
    this.snapshot = {
      ...INITIAL_SNAPSHOT,
      conversationId,
      status: 'idle',
    };
    for (const listener of this.listeners) listener();
    await this.loadForConversation(conversationId);
  }

  /** Starts a new batch, reusing the persona supplied by the start/report view. */
  async start(persona: string): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId || this.snapshot.isStarting) return;
    const pollToken = (this.preparingPollToken += 1);
    this.update({
      isStarting: true,
      preparing: null,
      error: null,
      answerError: null,
      pendingAnswer: null,
    });
    void this.pollPreparing(conversationId, pollToken);
    try {
      const detail = await startRehearsal(
        conversationId,
        persona,
        requestId(),
      );
      // A switch during the request must not write another conversation's state.
      if (this.snapshot.conversationId !== conversationId) return;
      // The backend is done; stop polling and let the bar fill before the view swaps, so it never
      // disappears mid-way and reads as "finished" instead of "cancelled".
      this.preparingPollToken += 1;
      this.update({ preparingComplete: true });
      const hold = Promise.withResolvers<void>();
      setTimeout(hold.resolve, PREPARING_COMPLETE_HOLD_MS);
      await hold.promise;
      if (this.snapshot.conversationId !== conversationId) return;
      this.update({
        isStarting: false,
        preparing: null,
        preparingComplete: false,
        detail,
        view: viewFor(detail),
        history: null,
        historyStatus: 'idle',
        historyError: null,
      });
    } catch (error) {
      if (this.snapshot.conversationId !== conversationId) return;
      this.update({
        isStarting: false,
        preparingComplete: false,
        preparing: null,
        error: describeFailure(error, '开始演练失败。'),
      });
    } finally {
      this.preparingPollToken += 1;
    }
  }

  /**
   * Polls the read-only preparing phase until the start settles.
   *
   * The feed only names the current backend phase; a failed poll leaves the generic copy in place,
   * and switching conversations stops the loop without writing into the new snapshot.
   */
  private async pollPreparing(
    conversationId: string,
    token: number,
  ): Promise<void> {
    while (this.preparingPollToken === token) {
      if (this.snapshot.conversationId !== conversationId) return;
      try {
        const preparing = await getRehearsalPreparing(conversationId);
        if (
          this.preparingPollToken !== token ||
          this.snapshot.conversationId !== conversationId
        ) {
          return;
        }
        if (preparing) this.update({ preparing });
      } catch {
        // Diagnostic only: the preparing screen keeps its generic copy.
      }
      const hidden =
        typeof document !== 'undefined' && document.visibilityState !== 'visible';
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, hidden ? 5_000 : 1_000);
      await delay.promise;
    }
  }

  /** Submits the current answer, retaining the request id for a retry. */
  async answer(answer: string): Promise<void> {
    const detail = this.snapshot.detail;
    const question = detail?.currentQuestion;
    if (!detail || !question || !answer.trim() || this.snapshot.isSubmitting) return;
    const requestKey =
      this.snapshot.pendingAnswer?.turnId === question.turnId
        ? this.snapshot.pendingAnswer.requestId
        : requestId();
    this.update({
      isSubmitting: true,
      isEvaluatingAnswer: true,
      answerError: null,
      pendingAnswer: {
        turnId: question.turnId,
        answer,
        requestId: requestKey,
      },
    });
    try {
      const result = await answerRehearsal(
        detail.rehearsalId,
        question.turnId,
        answer,
        requestKey,
      );
      const refreshed = await getRehearsal(detail.rehearsalId);
      const completed =
        result.completed || refreshed.status === 'completed';
      this.update({
        isSubmitting: false,
        isEvaluatingAnswer: false,
        detail: refreshed,
        view: completed ? 'report' : 'session',
        pendingAnswer: null,
        answerError: null,
        completionVersion: completed
          ? this.snapshot.completionVersion + 1
          : this.snapshot.completionVersion,
        history: completed ? null : this.snapshot.history,
        historyStatus: completed ? 'idle' : this.snapshot.historyStatus,
      });
    } catch (error) {
      this.update({
        isSubmitting: false,
        isEvaluatingAnswer: false,
        answerError: describeFailure(error, '回答评估失败，请重试。'),
      });
    }
  }

  /** Retries the last answer evaluation with the same idempotency key. */
  async retryAnswer(): Promise<void> {
    const pending = this.snapshot.pendingAnswer;
    if (!pending) return;
    await this.answer(pending.answer);
  }

  /** Skips the current question. */
  async skip(): Promise<void> {
    const detail = this.snapshot.detail;
    const question = detail?.currentQuestion;
    if (!detail || !question || this.snapshot.isSubmitting) return;
    this.update({ isSubmitting: true, answerError: null });
    try {
      const result = await skipRehearsal(detail.rehearsalId, question.turnId);
      const refreshed = await getRehearsal(detail.rehearsalId);
      const completed =
        result.completed || refreshed.status === 'completed';
      this.update({
        isSubmitting: false,
        detail: refreshed,
        view: completed ? 'report' : 'session',
        completionVersion: completed
          ? this.snapshot.completionVersion + 1
          : this.snapshot.completionVersion,
        history: completed ? null : this.snapshot.history,
        historyStatus: completed ? 'idle' : this.snapshot.historyStatus,
      });
    } catch (error) {
      this.update({
        isSubmitting: false,
        answerError: describeFailure(error, '跳过失败，请重试。'),
      });
    }
  }

  /** Retries generating the next question after a skip failure. */
  async retrySkip(): Promise<void> {
    const detail = this.snapshot.detail;
    if (!detail || this.snapshot.isSubmitting) return;
    const turnId =
      detail.currentQuestion?.turnId ??
      [...detail.turns]
        .reverse()
        .find((turn) => turn.status === 'skipped')?.turnId;
    if (!turnId) return;
    this.update({ isSubmitting: true, answerError: null });
    try {
      const result = await skipRehearsal(detail.rehearsalId, turnId);
      const refreshed = await getRehearsal(detail.rehearsalId);
      const completed =
        result.completed || refreshed.status === 'completed';
      this.update({
        isSubmitting: false,
        detail: refreshed,
        view: completed ? 'report' : 'session',
        completionVersion: completed
          ? this.snapshot.completionVersion + 1
          : this.snapshot.completionVersion,
        history: completed ? null : this.snapshot.history,
        historyStatus: completed ? 'idle' : this.snapshot.historyStatus,
      });
    } catch (error) {
      this.update({
        isSubmitting: false,
        answerError: describeFailure(error, '下一题生成失败，请重试。'),
      });
    }
  }

  /** Ends the rehearsal and opens the generated report. */
  async end(): Promise<void> {
    const detail = this.snapshot.detail;
    if (!detail || this.snapshot.isEnding) return;
    this.update({ isEnding: true, error: null });
    try {
      const completed = await endRehearsal(detail.rehearsalId);
      this.update({
        isEnding: false,
        detail: completed,
        view: 'report',
        completionVersion: this.snapshot.completionVersion + 1,
        history: null,
        historyStatus: 'idle',
        historyError: null,
      });
    } catch (error) {
      // A failed report keeps every per-question record. Land on the report view so its
      // 「重试结束」action is visible instead of leaving the user on a banner alone.
      const failed = await getRehearsal(detail.rehearsalId).catch(() => null);
      this.update({
        isEnding: false,
        error: describeFailure(error, '结束演练失败。'),
        ...(failed?.status === 'failed'
          ? { detail: failed, view: 'report' as const }
          : {}),
      });
    }
  }

  /** Retries report generation after a failed end. */
  async retryEnd(): Promise<void> {
    await this.end();
  }

  /** Discards a rehearsal with no answers after the zero-answer confirmation. */
  async discard(): Promise<void> {
    const detail = this.snapshot.detail;
    if (!detail || this.snapshot.isEnding) return;
    this.update({ isEnding: true, error: null });
    try {
      await discardRehearsal(detail.rehearsalId);
      this.update({
        isEnding: false,
        detail: null,
        view: 'start',
        pendingAnswer: null,
        answerError: null,
        history: null,
        historyStatus: 'idle',
        historyError: null,
      });
    } catch (error) {
      this.update({
        isEnding: false,
        error: describeFailure(error, '丢弃演练失败，请重试。'),
      });
    }
  }

  /** Opens the history list and loads its first page. */
  async openHistory(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId) return;
    this.update({
      view: 'history',
      historyStatus: 'loading',
      historyError: null,
      historyDetail: null,
      historyDetailError: null,
    });
    try {
      const history = await listRehearsals(conversationId, {
        limit: 20,
        status: 'all',
      });
      this.update({ history, historyStatus: 'ready' });
    } catch (error) {
      this.update({
        historyStatus: 'error',
        historyError: describeFailure(error, '历史演练加载失败。'),
      });
    }
  }

  /** Loads the next older history page. */
  async loadMoreHistory(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    const history = this.snapshot.history;
    if (!conversationId || !history?.nextCursor) return;
    this.update({ historyStatus: 'loading', historyError: null });
    try {
      const page = await listRehearsals(conversationId, {
        limit: 20,
        cursor: history.nextCursor,
        status: 'all',
      });
      this.update({
        history: {
          items: [...history.items, ...page.items],
          counts: page.counts,
          nextCursor: page.nextCursor,
        },
        historyStatus: 'ready',
      });
    } catch (error) {
      this.update({
        historyStatus: 'error',
        historyError: describeFailure(error, '更早的演练加载失败。'),
      });
    }
  }

  /** Opens one historical rehearsal as a read-only report. */
  async openHistoryDetail(rehearsalId: string): Promise<void> {
    this.update({
      view: 'historyDetail',
      historyDetail: null,
      historyDetailLoading: true,
      historyDetailError: null,
    });
    try {
      const detail = await getRehearsal(rehearsalId);
      this.update({
        historyDetail: detail,
        historyDetailLoading: false,
      });
    } catch (error) {
      this.update({
        historyDetailLoading: false,
        historyDetailError: describeFailure(error, '演练详情加载失败。'),
        view: 'history',
      });
    }
  }

  /** Resumes the current active rehearsal from the history list. */
  async resumeRehearsal(rehearsalId: string): Promise<void> {
    try {
      const detail = await getRehearsal(rehearsalId);
      this.update({
        detail,
        status: 'ready',
        view: viewFor(detail),
        history: null,
        historyStatus: 'idle',
      });
    } catch (error) {
      this.update({
        historyError: describeFailure(error, '演练恢复失败。'),
        view: 'history',
      });
    }
  }

  /** Returns from a history detail to the history list. */
  backToHistory(): void {
    this.update({
      view: 'history',
      historyDetail: null,
      historyDetailError: null,
    });
  }

  /** Returns to the active session, report or start view. */
  backToSession(): void {
    const detail = this.snapshot.detail;
    this.update({ view: detail ? viewFor(detail) : 'start' });
  }

  /** Opens the current report when one exists. */
  openReport(): void {
    if (this.snapshot.detail) this.update({ view: 'report' });
  }
}

/** Shared singleton consumed by the drill view and the normal-chat card. */
export const rehearsalStore = new RehearsalStore();
