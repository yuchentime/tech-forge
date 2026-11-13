import { CircleNotch, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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
  deletingRehearsalId,
  onResume,
  onOpen,
  onDelete,
  onLoadMore,
  onRetry,
}: {
  history: RehearsalList | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  currentDetail: RehearsalDetail | null;
  deletingRehearsalId: string | null;
  onResume: (rehearsalId: string) => void;
  onOpen: (rehearsalId: string) => void;
  onDelete: (rehearsalId: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  /** Finished rehearsal whose report the confirmation dialog is asking about. */
  const [deleteTarget, setDeleteTarget] = useState<RehearsalSummary | null>(null);
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
          <div className="flex items-center gap-2 rounded-2xl bg-ink-50 px-4 py-6 text-sm text-ink-600" role="status">
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
          <div className="rounded-2xl border border-dashed border-ink-300 p-8 text-center text-sm text-ink-500">
            还没有已完成的演练。
          </div>
        )}

        {active.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-brand-600">
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
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-500">
              已完成
            </h3>
            <div className="space-y-2">
              {completed.map((item) => (
                <HistoryRow
                  actionLabel="查看报告"
                  deleting={deletingRehearsalId === item.rehearsalId}
                  item={item}
                  key={item.rehearsalId}
                  onDelete={() => setDeleteTarget(item)}
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
                  deleting={deletingRehearsalId === item.rehearsalId}
                  item={item}
                  key={item.rehearsalId}
                  onDelete={() => setDeleteTarget(item)}
                  onOpen={() => onOpen(item.rehearsalId)}
                />
              ))}
            </div>
          </section>
        )}

        {deleteTarget && (
          <ConfirmDialog
            confirmLabel="删除报告"
            description="这份报告、逐题问答与本次记录会被永久删除，无法恢复。"
            note="知识掌握会按剩余演练重新计算。"
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => {
              onDelete(deleteTarget.rehearsalId);
              setDeleteTarget(null);
            }}
            title="删除这份演练报告？"
            tone="danger"
          />
        )}

        {history?.nextCursor && (
          <div className="flex justify-center py-3">
            <button
              className="rounded-full border border-ink-300 bg-white px-4 py-2 text-sm font-medium text-ink-600 transition hover:border-ink-400 hover:text-ink-900 disabled:cursor-wait disabled:opacity-50"
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

/**
 * One history row; active batches say resume, finished ones say report.
 *
 * Finished rows carry their own delete action, so the open target is a button inside the row
 * instead of the row itself — a button cannot nest another button.
 */
function HistoryRow({
  item,
  actionLabel,
  deleting = false,
  onOpen,
  onDelete,
}: {
  item: RehearsalSummary;
  actionLabel: string;
  /** True while this row's report is being deleted. */
  deleting?: boolean;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const description =
    item.status === 'completed'
      ? item.overallSummary
      : item.status === 'failed'
        ? '总体评估生成失败，逐题记录已保留。'
        : '这场演练还没有结束。';
  return (
    <div className="flex items-center gap-1 rounded-2xl border border-ink-200 bg-white pr-2 transition hover:border-brand-300 hover:bg-brand-50/30">
      <button
        className="min-w-0 flex-1 rounded-2xl px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
        onClick={onOpen}
        type="button"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-ink-900">
            {item.topic || '准备中'}
          </span>
          <span className="text-xs font-medium text-brand-600">{actionLabel}</span>
        </div>
        <p className="mt-1 text-xs text-ink-500">
          {formatRehearsalDate(item.endedAt ?? item.createdAt)}
          {item.endReason ? ` · ${endReasonLabel(item.endReason)}` : ''}
          {` · 已提问 ${item.progress.asked} 次（最多 ${item.progress.limit} 次）`}
          {item.progress.skipped > 0 ? ` · 跳过 ${item.progress.skipped}` : ''}
        </p>
        {description && (
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink-600">
            {description}
          </p>
        )}
      </button>
      {onDelete && (
        <button
          aria-label={`删除演练报告 ${item.topic || '未命名演练'}`}
          className="shrink-0 rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-wait disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
          disabled={deleting}
          onClick={onDelete}
          title="删除这份演练报告"
          type="button"
        >
          {deleting ? (
            <CircleNotch aria-hidden className="size-4 animate-spin" />
          ) : (
            <Trash aria-hidden className="size-4" />
          )}
        </button>
      )}
    </div>
  );
}
