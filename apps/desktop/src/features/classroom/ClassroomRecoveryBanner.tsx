/**
 * The two classroom recovery banners, one component so copy and actions stay in lockstep.
 *
 * `error` covers a failed turn or an unreadable record; `degraded` reports skipped corrupt lines
 * while the rest of the record is usable. Both offer retry and "start a new classroom".
 */
export function ClassroomRecoveryBanner({
  variant,
  message,
  corruptLineCount,
  busy,
  onRetry,
  onStartNew,
}: {
  variant: 'error' | 'degraded';
  message?: string;
  corruptLineCount?: number;
  busy?: boolean;
  onRetry: () => void;
  onStartNew: () => void;
}) {
  const isError = variant === 'error';
  return (
    <div
      className={
        isError
          ? 'absolute left-1/2 top-[8%] z-30 w-[min(34rem,80%)] -translate-x-1/2 rounded-xl border border-rose-200 bg-rose-50/95 px-4 py-2 text-center text-xs leading-5 text-rose-800 shadow-card'
          : 'absolute left-1/2 top-[8%] z-20 flex -translate-x-1/2 items-center gap-3 rounded-full bg-amber-50/95 px-4 py-1.5 text-[11px] font-medium text-amber-800 shadow-card'
      }
      role={isError ? 'alert' : undefined}
    >
      <span>
        {isError
          ? message
          : `记录有 ${corruptLineCount ?? 0} 行损坏，已跳过`}
      </span>
      <div className={isError ? 'mt-1.5 flex justify-center gap-3' : 'flex gap-3'}>
        <button
          className="font-semibold underline underline-offset-2"
          onClick={onRetry}
          type="button"
        >
          重试
        </button>
        <button
          className="font-semibold underline underline-offset-2 disabled:cursor-wait disabled:opacity-40"
          disabled={busy}
          onClick={onStartNew}
          type="button"
        >
          开始新课堂
        </button>
      </div>
    </div>
  );
}
