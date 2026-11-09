import { CircleNotch } from '@phosphor-icons/react';
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
  onExitToChat,
}: {
  conversationId: string | null;
  hasHistory: boolean;
  onExitToChat: () => void;
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

  const completedCount =
    state.history?.counts.completed ??
    (state.detail?.status === 'completed' ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-full bg-emerald-800 px-2 py-0.5 text-[11px] font-semibold text-white">
            演练
          </span>
          <p className="truncate text-xs text-stone-500">
            AI 扮演学生向你提问；回答后先评估，再决定追问或换题。
          </p>
        </div>
        <button
          className="shrink-0 rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-50"
          onClick={() => void rehearsalStore.openHistory()}
          type="button"
        >
          历史演练
          {completedCount > 0 ? ` (${completedCount})` : ''}
        </button>
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
            onBack={() => rehearsalStore.backToSession()}
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
              onBackChat={onExitToChat}
              onBackHistory={() => rehearsalStore.backToHistory()}
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
            onBackChat={onExitToChat}
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
            onEnd={() => void rehearsalStore.end()}
            onRetryAnswer={() => void rehearsalStore.retryAnswer()}
            onRetrySkip={() => void rehearsalStore.retrySkip()}
            onSkip={() => void rehearsalStore.skip()}
            pendingAnswer={state.pendingAnswer}
          />
        ) : (
          <RehearsalStart
            disabledReason={
              !hasHistory
                ? '先进行一轮普通对话，演练会基于当前学习内容出题。'
                : state.status === 'error'
                  ? '演练状态加载失败，请重试或切换会话。'
                  : null
            }
            error={state.error}
            isStarting={state.isStarting}
            onStart={(persona) => void rehearsalStore.start(persona)}
            persona={state.detail?.persona ?? ''}
          />
        )}
      </div>
    </div>
  );
}
