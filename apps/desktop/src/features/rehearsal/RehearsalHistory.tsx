import { CircleNotch } from '@phosphor-icons/react';
import type {
  RehearsalDetail,
  RehearsalList,
  RehearsalSummary,
} from './rehearsal-api';
import {
  endReasonLabel,
  formatRehearsalDate,
  isActiveStatus,
} from './rehearsal-ui-utils';

/** Paginated rehearsal history with active batches pinned first. */
export function RehearsalHistory({
  history,
  status,
  error,
  currentDetail,
  onResume,
  onOpen,
  onLoadMore,
  onRetry,
}: {
  history: RehearsalList | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  currentDetail: RehearsalDetail | null;
  onResume: (rehearsalId: string) => void;
  onOpen: (rehearsalId: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const active = history?.items.filter((item) => isActiveStatus(item.status)) ?? [];
  const completed =
    history?.items.filter((item) => item.status === 'completed') ?? [];
  const failed = history?.items.filter((item) => item.status === 'failed') ?? [];
  const isEmpty =
    status === 'ready' &&
    active.length === 0 &&
    completed.length === 0 &&
    failed.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {status === 'loading' && !history && (
          <div className="flex items-center gap-2 rounded-2xl bg-stone-50 px-4 py-6 text-sm text-stone-600" role="status">
            <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            正在加载历史演练…
          </div>
        )}
        {error && (
          <div className="mb-3 flex items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            <span className="min-w-0 flex-1">{error}</span>
            <button
              className="font-medium underline underline-offset-2"
              onClick={onRetry}
              type="button"
            >
              重试
            </button>
          </div>
        )}
        {isEmpty && (
          <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500">
            还没有已完成的演练。
          </div>
        )}

        {active.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-emerald-800">
              进行中
            </h3>
            <div className="space-y-2">
              {active.map((item) => (
                <HistoryRow
                  actionLabel={currentDetail?.rehearsalId === item.rehearsalId ? '继续' : '恢复'}
                  item={item}
                  key={item.rehearsalId}
                  onOpen={() => onResume(item.rehearsalId)}
                />
              ))}
            </div>
          </section>
        )}

        {completed.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-stone-500">
              已完成
            </h3>
            <div className="space-y-2">
              {completed.map((item) => (
                <HistoryRow
                  actionLabel="查看报告"
                  item={item}
                  key={item.rehearsalId}
                  onOpen={() => onOpen(item.rehearsalId)}
                />
              ))}
            </div>
          </section>
        )}

        {failed.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-amber-700">
              报告未完成
            </h3>
            <div className="space-y-2">
              {failed.map((item) => (
                <HistoryRow
                  actionLabel="查看记录"
                  item={item}
                  key={item.rehearsalId}
                  onOpen={() => onOpen(item.rehearsalId)}
                />
              ))}
            </div>
          </section>
        )}

        {history?.nextCursor && (
          <div className="flex justify-center py-3">
            <button
              className="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition hover:border-stone-400 hover:text-stone-900 disabled:cursor-wait disabled:opacity-50"
              disabled={status === 'loading'}
              onClick={onLoadMore}
              type="button"
            >
              {status === 'loading' ? '正在加载…' : '加载更早'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One clickable history row; active batches say resume, completed say report. */
function HistoryRow({
  item,
  actionLabel,
  onOpen,
}: {
  item: RehearsalSummary;
  actionLabel: string;
  onOpen: () => void;
}) {
  const description =
    item.status === 'completed'
      ? item.overallSummary
      : item.status === 'failed'
        ? '总体评估生成失败，逐题记录已保留。'
        : '这场演练还没有结束。';
  return (
    <button
      className="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50/30"
      onClick={onOpen}
      type="button"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-stone-900">
          {item.topic || '准备中'}
        </span>
        <span className="text-xs font-medium text-emerald-800">{actionLabel}</span>
      </div>
      <p className="mt-1 text-xs text-stone-500">
        {formatRehearsalDate(item.endedAt ?? item.createdAt)}
        {item.endReason ? ` · ${endReasonLabel(item.endReason)}` : ''}
        {` · 已提问 ${item.progress.asked} 次（最多 ${item.progress.limit} 次）`}
        {item.progress.skipped > 0 ? ` · 跳过 ${item.progress.skipped}` : ''}
      </p>
      {description && (
        <p className="mt-2 line-clamp-2 text-sm leading-6 text-stone-600">
          {description}
        </p>
      )}
    </button>
  );
}
