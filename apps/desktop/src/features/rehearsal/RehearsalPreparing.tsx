import { useEffect, useState } from 'react';
import type {
  RehearsalPreparing,
  RehearsalPreparingPhase,
} from './rehearsal-api';
import { estimatePreparingPercent } from './rehearsal-preparing-progress';

/** User-facing copy for each real start phase; the backend decides the phase, this only names it. */
const PHASE_COPY: Record<RehearsalPreparingPhase, string> = {
  history: '正在读取这次对话的学习内容',
  prior_summaries: '正在回顾之前的演练记录',
  session: '正在加载模型和对话上下文',
  plan: '正在生成演练计划和第一道题',
  repair: '模型输出格式不对，正在重试',
  saving: '正在保存演练计划',
};

/** Shown until the backend registers its first phase, or after a restart lost the entry. */
const FALLBACK_COPY = '正在准备第一道题…';

/**
 * Dedicated preparing screen for one in-flight start.
 *
 * The status copy comes from backend phases; the bar is paced by an estimated wait, capped short
 * of the end, and only a real completion fills it. No time numbers are shown.
 */
export function RehearsalPreparing({
  preparing,
  complete = false,
}: {
  preparing: RehearsalPreparing | null;
  complete?: boolean;
}) {
  const [slow, setSlow] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    setSlow(false);
    const startedAt = Date.now();
    const ticker = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      200,
    );
    const timer = window.setTimeout(() => setSlow(true), 45_000);
    return () => {
      window.clearInterval(ticker);
      window.clearTimeout(timer);
    };
  }, []);

  // The bar is paced by an estimate only: it never reaches 100% without a real completion, and
  // the phase copy beside it still comes from the backend.
  const percent = complete ? 100 : estimatePreparingPercent(elapsedMs);
  const copy = complete
    ? '准备完成，正在进入演练…'
    : preparing
      ? PHASE_COPY[preparing.phase]
      : FALLBACK_COPY;

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-md text-center">
        <span
          aria-hidden
          className="mx-auto block h-2 w-2 animate-pulse rounded-full bg-emerald-700 motion-reduce:animate-none"
        />
        <h2 className="mt-4 text-lg font-semibold text-stone-900">
          正在准备这次演练
        </h2>
        <div
          aria-label="演练准备进度"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={copy}
          className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-stone-200"
          role="progressbar"
        >
          <div
            className="relative h-full rounded-full bg-emerald-700 transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          >
            <span
              aria-hidden
              className="absolute inset-y-0 right-0 w-8 animate-pulse bg-gradient-to-r from-transparent to-emerald-200/80 motion-reduce:hidden"
            />
          </div>
        </div>
        <p className="mt-4 text-sm text-stone-700" role="status">
          {copy}
        </p>
        {slow && !complete && (
          <p className="mt-2 text-xs leading-5 text-stone-500">
            模型响应较慢，请继续等待；如果一直失败，可以检查设置里的模型服务。
          </p>
        )}
        <p className="mt-10 text-xs text-stone-400">
          演练不会修改对话模式消息
        </p>
      </div>
    </div>
  );
}
