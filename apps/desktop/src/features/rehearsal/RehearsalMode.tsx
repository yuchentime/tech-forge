import { CircleNotch, ListBullets } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { RehearsalHistory } from './RehearsalHistory';
import { RehearsalReport } from './RehearsalReport';
import { RehearsalSession } from './RehearsalSession';
import { RehearsalStart } from './RehearsalStart';
import { rehearsalStore } from './rehearsal-store';

/** Root of the drill view; switches between start, session, report and history. */
export function RehearsalMode({
  conversationId,
  hasHistory,
}: {
  conversationId: string | null;
  hasHistory: boolean;
}) {
  const state = useSyncExternalStore(
    rehearsalStore.subscribe,
    rehearsalStore.getSnapshot,
    rehearsalStore.getSnapshot,
  );

  useEffect(() => {
    void rehearsalStore.loadForConversation(conversationId);
  }, [conversationId]);

  if (!conversationId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-stone-500">
        先选择或新建一个会话，再开始演练。
      </div>
    );
  }

  if (state.status === 'loading' && !state.detail) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-stone-500" role="status">
        <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
        正在加载演练状态…
      </div>
    );
  }

  const answeredCount =
    state.detail?.turns.filter((turn) => Boolean(turn.answer?.trim())).length ??
    0;
  const showEndAction =
    state.view === 'session' &&
    state.detail !== null &&
    ['preparing', 'awaiting_answer', 'evaluating', 'preparing_next'].includes(
      state.detail.status,
    );
  const handleEnd = (): void => {
    const detail = state.detail;
    if (!detail) return;
    const hasAnswers = detail.turns.some((turn) =>
      Boolean(turn.answer?.trim()),
    );
    if (!hasAnswers) {
      if (
        window.confirm(
          '还没有回答任何问题。结束后本次演练会被丢弃，确定吗？',
        )
      ) {
        void rehearsalStore.discard();
      }
      return;
    }
    if (window.confirm('结束后会生成评估，当前题不能再回答。确定结束吗？')) {
      void rehearsalStore.end();
    }
  };

  const historyBack =
    state.view === 'history'
      ? () => rehearsalStore.backToSession()
      : state.view === 'historyDetail'
        ? () => rehearsalStore.backToHistory()
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <div className="min-w-0">
          {historyBack ? (
            <button
              className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-50"
              onClick={historyBack}
              type="button"
            >
              返回
            </button>
          ) : state.view === 'session' && state.detail ? (
            <p className="text-sm font-medium text-stone-700">
              已回答 {answeredCount}/{state.detail.progress.limit} 题
            </p>
          ) : (
            <></>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            aria-label="历史演练"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
            onClick={() => void rehearsalStore.openHistory()}
            title="历史演练"
            type="button"
          >
            <ListBullets aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      {state.error && (
        <div className="mb-3 flex shrink-0 items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          <span className="min-w-0 flex-1">{state.error}</span>
          <button
            className="font-medium underline underline-offset-2"
            onClick={() => void rehearsalStore.reload()}
            type="button"
          >
            重试
          </button>
        </div>
      )}
      {state.historyDetailError && (
        <div className="mb-3 flex shrink-0 items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          <span className="min-w-0 flex-1">{state.historyDetailError}</span>
          <button
            className="font-medium underline underline-offset-2"
            onClick={() => void rehearsalStore.openHistory()}
            type="button"
          >
            重试
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {state.view === 'history' ? (
          <RehearsalHistory
            currentDetail={state.detail}
            error={state.historyError}
            history={state.history}
            onLoadMore={() => void rehearsalStore.loadMoreHistory()}
            onOpen={(rehearsalId) =>
              void rehearsalStore.openHistoryDetail(rehearsalId)
            }
            onResume={(rehearsalId) =>
              void rehearsalStore.resumeRehearsal(rehearsalId)
            }
            onRetry={() => void rehearsalStore.openHistory()}
            status={state.historyStatus}
          />
        ) : state.view === 'historyDetail' ? (
          state.historyDetailLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-stone-500" role="status">
              <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
              正在加载演练详情…
            </div>
          ) : state.historyDetail ? (
            <RehearsalReport
              detail={state.historyDetail}
              isEnding={false}
              isStarting={state.isStarting}
              mode="history"
              onContinue={() =>
                void rehearsalStore.start(state.historyDetail?.persona ?? '')
              }
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-stone-500">
              演练详情暂不可用。
            </div>
          )
        ) : state.view === 'report' && state.detail ? (
          <RehearsalReport
            detail={state.detail}
            isEnding={state.isEnding}
            isStarting={state.isStarting}
            mode="live"
            onAdjustPersona={() => rehearsalStore.openStart()}
            onContinue={() =>
              void rehearsalStore.start(state.detail?.persona ?? '')
            }
            onRetryEnd={() => void rehearsalStore.retryEnd()}
          />
        ) : state.view === 'session' && state.detail ? (
          <RehearsalSession
            answerError={state.answerError}
            detail={state.detail}
            isEnding={state.isEnding}
            isSubmitting={state.isSubmitting}
            onAnswer={(answer) => void rehearsalStore.answer(answer)}
            onEnd={handleEnd}
            onRetryAnswer={() => void rehearsalStore.retryAnswer()}
            onRetrySkip={() => void rehearsalStore.retrySkip()}
            onSkip={() => void rehearsalStore.skip()}
            pendingAnswer={state.pendingAnswer}
            showEndAction={showEndAction}
          />
        ) : (
          <RehearsalStart
            disabledReason={
              !hasHistory
                ? '先进行一轮对话模式，演练会基于当前学习内容出题。'
                : state.status === 'error'
                  ? '演练状态加载失败，请重试或切换会话。'
                  : null
            }
            error={state.error}
            isStarting={state.isStarting}
            onSavePersona={(persona) => void rehearsalStore.savePersona(persona)}
            onStart={(persona) => void rehearsalStore.start(persona)}
            persona={state.persona}
            personaError={state.personaError}
          />
        )}
      </div>
    </div>
  );
}
