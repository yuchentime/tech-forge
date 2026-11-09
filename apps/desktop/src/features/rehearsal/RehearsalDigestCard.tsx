import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  listRehearsals,
  type RehearsalSummary,
} from './rehearsal-api';
import { rehearsalStore } from './rehearsal-store';
import { formatRehearsalDate, truncateText } from './rehearsal-ui-utils';

/** Compact latest-report card shown above the normal chat messages. */
export function RehearsalDigestCard({
  conversationId,
  onOpenReport,
  onOpenHistory,
}: {
  conversationId: string | null;
  onOpenReport: (rehearsalId: string) => void;
  onOpenHistory: () => void;
}) {
  const store = useSyncExternalStore(
    rehearsalStore.subscribe,
    rehearsalStore.getSnapshot,
    rehearsalStore.getSnapshot,
  );
  const [summary, setSummary] = useState<RehearsalSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!conversationId) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setSummary(null);
    setLoading(true);
    setFailed(false);
    void listRehearsals(conversationId, { status: 'completed', limit: 1 })
      .then((page) => {
        if (cancelled) return;
        setSummary(page.items[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, store.completionVersion]);

  if (!conversationId || (!summary && !loading && !failed)) return null;

  return (
    <div className="mb-3 shrink-0 rounded-xl border border-emerald-200/70 bg-emerald-50/40 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-800 px-2 py-0.5 text-[11px] font-semibold text-white">
              演练评估
            </span>
            {summary && (
              <span className="text-xs text-stone-500">
                {formatRehearsalDate(summary.endedAt ?? summary.createdAt)}
              </span>
            )}
          </div>
          {loading && !summary ? (
            <p className="mt-2 text-sm text-stone-500">正在加载演练评估…</p>
          ) : failed ? (
            <p className="mt-2 text-sm text-stone-500">
              演练评估暂不可用。
            </p>
          ) : (
            summary && (
              <>
                <p className="mt-2 truncate text-sm font-semibold text-stone-900">
                  {summary.topic || '已完成演练'}
                </p>
                {summary.overallSummary && (
                  <p className="mt-1 text-sm leading-6 text-stone-600">
                    {truncateText(summary.overallSummary, 160)}
                  </p>
                )}
              </>
            )
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {summary && (
            <button
              className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-50"
              onClick={() => onOpenReport(summary.rehearsalId)}
              type="button"
            >
              查看报告
            </button>
          )}
          <button
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-stone-500 underline underline-offset-2 hover:text-stone-800"
            onClick={onOpenHistory}
            type="button"
          >
            历史演练
          </button>
        </div>
      </div>
    </div>
  );
}
