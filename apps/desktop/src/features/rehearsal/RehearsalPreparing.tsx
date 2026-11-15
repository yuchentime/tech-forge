import { CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import preparingArt from '../../assets/rehearsal-preparing.gif';
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
  saving: '正在保存演练计划',
};

/**
 * Ordered stages shown as the waiting checklist.
 *
 * Every stage maps onto a real backend phase, and no stage exists that the backend cannot report.
 */
const PREPARING_STEPS: ReadonlyArray<{
  label: string;
  phases: readonly RehearsalPreparingPhase[];
}> = [
  { label: '读取学习内容', phases: ['history'] },
  { label: '回顾演练记录', phases: ['prior_summaries'] },
  { label: '加载上下文', phases: ['session'] },
  { label: '生成演练题目', phases: ['plan'] },
  { label: '保存计划', phases: ['saving'] },
];

/** Shown until the backend registers its first phase, or after a restart lost the entry. */
const FALLBACK_COPY = '正在准备第一道题…';

/** Index of the checklist stage the reported phase belongs to; -1 when nothing was reported yet. */
function stageIndexForPhase(phase: RehearsalPreparingPhase | undefined): number {
  if (!phase) return -1;
  return PREPARING_STEPS.findIndex(({ phases }) => phases.includes(phase));
}

/**
 * Dedicated preparing screen for one in-flight start.
 *
 * Two signals stay separate on purpose: the checklist comes from backend phases and is the only
 * claim about real work, while the bar is paced by an estimated wait, capped short of the end, and
 * only a real completion fills it. No time numbers are shown.
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

  const percent = complete ? 100 : estimatePreparingPercent(elapsedMs);
  const activeStage = complete ? PREPARING_STEPS.length : stageIndexForPhase(preparing?.phase);
  const copy = complete
    ? '准备完成，正在进入演练…'
    : preparing
      ? PHASE_COPY[preparing.phase]
      : FALLBACK_COPY;

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto py-6">
      <div className="tf-rise w-full max-w-2xl px-2 text-center">
        {/*
         * Animated mascot: the mood layer, so it never carries information the text lacks. The GIF
         * ships its own alpha channel, so it needs no card, ring or blend mode to sit on the canvas.
         */}
        <img
          alt=""
          aria-hidden="true"
          className="mx-auto h-52 w-auto select-none md:h-64"
          src={preparingArt}
        />

        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-ink-900">
          {complete ? '准备完成，马上开始演练' : '正在为你准备演练题目…'}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-500">
          我会结合这次对话的学习内容，生成贴近真实课堂的提问与追问，
          帮你检验理解、发现盲点、把话讲清楚。
        </p>

        <div
          aria-label="演练准备进度"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={copy}
          className="mx-auto mt-5 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-ink-200/80"
          role="progressbar"
        >
          <div
            className="relative h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-700 transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          >
            <span
              aria-hidden
              className="absolute inset-y-0 right-0 w-8 animate-pulse bg-gradient-to-r from-transparent to-white/70 motion-reduce:hidden"
            />
          </div>
        </div>

        <ol className="mx-auto mt-4 flex w-fit max-w-full flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-full border border-ink-200/70 bg-white/80 px-5 py-2.5 shadow-card backdrop-blur">
          {PREPARING_STEPS.map((step, index) => {
            const state =
              index < activeStage ? 'done' : index === activeStage ? 'active' : 'pending';
            return (
              <li
                aria-current={state === 'active' ? 'step' : undefined}
                className="flex items-center gap-1.5 text-xs"
                key={step.label}
              >
                {state === 'done' ? (
                  <CheckCircle aria-hidden className="h-4 w-4 text-brand-600" weight="fill" />
                ) : state === 'active' ? (
                  <CircleNotch
                    aria-hidden
                    className="h-4 w-4 animate-spin text-brand-600 motion-reduce:animate-none"
                  />
                ) : (
                  <span aria-hidden className="h-4 w-4 rounded-full border-2 border-ink-300" />
                )}
                <span
                  className={
                    state === 'active'
                      ? 'font-semibold text-brand-700'
                      : state === 'done'
                        ? 'text-ink-800'
                        : 'text-ink-500'
                  }
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>

        <p aria-live="polite" className="mt-3 text-sm text-ink-600" role="status">
          {copy}
        </p>
        {slow && !complete && (
          <p className="mt-2 text-xs leading-5 text-ink-500">
            模型响应较慢，请继续等待；如果一直失败，可以检查设置里的模型服务。
          </p>
        )}
        <p className="mt-8 text-xs text-ink-400">演练不会修改对话模式消息</p>
      </div>
    </div>
  );
}
