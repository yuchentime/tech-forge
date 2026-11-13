import { CircleNotch } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/** After this long the wait itself becomes information, so the pane admits it is slow. */
const SLOW_AFTER_MS = 45_000;

/**
 * Full-area waiting state for the end request, which blocks until the backend has written the
 * overall report.
 *
 * `POST /api/rehearsals/:id/end` is one synchronous call with no progress phases to subscribe to,
 * so this pane only claims what is already true (per-question answers are saved, the summary is
 * being generated) and shows liveness with an indeterminate sweep plus an elapsed counter instead
 * of a percentage it cannot know.
 */
export function RehearsalEvaluating() {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const startedAt = Date.now();
    const ticker = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      1_000,
    );
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => {
      window.clearInterval(ticker);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto py-6">
      <div className="tf-rise w-full max-w-md px-2 text-center">
        <span className="relative mx-auto flex size-16 items-center justify-center rounded-full bg-brand-50">
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-brand-200/50 motion-safe:animate-ping"
          />
          <CircleNotch
            aria-hidden
            className="relative size-7 text-brand-600 motion-safe:animate-spin"
            weight="bold"
          />
        </span>

        <h2 className="mt-5 text-xl font-semibold tracking-tight text-ink-900">
          正在生成演练评估
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-500">
          逐题回答已经保存。报告会结合这些内容汇总总体表现、薄弱点与复习建议，完成后自动打开。
        </p>

        <div
          aria-label="演练评估生成进度"
          className="mx-auto mt-5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-ink-200/80"
          role="progressbar"
        >
          <div className="tf-progress-sweep h-full w-2/5 rounded-full bg-gradient-to-r from-brand-500 to-brand-700" />
        </div>

        <p aria-live="polite" className="mt-3 text-sm text-ink-600" role="status">
          正在汇总总体评估…
        </p>
        {slow ? (
          <p className="mt-2 text-xs leading-5 text-ink-500">
            模型响应较慢，请继续等待；如果一直失败，可以先检查设置里的模型服务，再点「重试结束」。
          </p>
        ) : (
          elapsedMs >= 3_000 && (
            <p className="mt-2 text-xs text-ink-400">已等待 {Math.floor(elapsedMs / 1_000)} 秒</p>
          )
        )}
      </div>
    </div>
  );
}
