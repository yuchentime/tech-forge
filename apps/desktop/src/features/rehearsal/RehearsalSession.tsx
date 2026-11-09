import { CircleNotch } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { RehearsalDetail } from './rehearsal-api';
import {
  assessmentLabel,
  assessmentTone,
  turnKindLabel,
  turnStatusLabel,
} from './rehearsal-ui-utils';

/** Question/answer transcript and the composer for the active drill. */
export function RehearsalSession({
  detail,
  isSubmitting,
  isEnding,
  answerError,
  pendingAnswer,
  onAnswer,
  onSkip,
  onEnd,
  onRetryAnswer,
  onRetrySkip,
}: {
  detail: RehearsalDetail;
  isSubmitting: boolean;
  isEnding: boolean;
  answerError: string | null;
  pendingAnswer: { turnId: string; answer: string; requestId: string } | null;
  onAnswer: (answer: string) => void;
  onSkip: () => void;
  onEnd: () => void;
  onRetryAnswer: () => void;
  onRetrySkip: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const questionId = detail.currentQuestion?.turnId ?? null;

  useEffect(() => {
    setAnswer('');
  }, [questionId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [detail.turns.length, detail.status]);

  const busy =
    isSubmitting ||
    isEnding ||
    detail.status === 'evaluating' ||
    detail.status === 'reporting';
  const canAnswer =
    Boolean(detail.currentQuestion) && detail.status === 'awaiting_answer';
  const needsNextQuestion =
    detail.status === 'preparing_next' ||
    (detail.status === 'awaiting_answer' && !detail.currentQuestion);

  const submit = (): void => {
    if (!answer.trim() || busy) return;
    onAnswer(answer);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-stone-900">
            {detail.topic || '演练进行中'}
          </h2>
          <p className="mt-0.5 text-xs text-stone-500">
            已提问 {detail.progress.asked}/{detail.progress.limit}
            {detail.progress.currentFollowUpDepth > 0
              ? ` · 本题追问 ${detail.progress.currentFollowUpDepth}/2`
              : ''}
            {detail.progress.skipped > 0
              ? ` · 跳过 ${detail.progress.skipped}`
              : ''}
          </p>
        </div>
        <button
          className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-50"
          disabled={busy}
          onClick={() => {
            if (window.confirm('结束后会生成评估，当前题不能再回答。确定结束吗？')) {
              onEnd();
            }
          }}
          type="button"
        >
          {isEnding ? '正在生成评估…' : '结束演练'}
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pr-1"
        ref={viewportRef}
      >
        {detail.turns.map((turn) => (
          <article
            className={`rounded-2xl border px-4 py-3 ${
              turn.turnId === questionId
                ? 'border-emerald-300 bg-emerald-50/40'
                : 'border-stone-200 bg-white'
            }`}
            key={turn.turnId}
          >
            <div className="flex items-center justify-between gap-3 text-xs text-stone-500">
              <span>
                第 {turn.sequenceNo} 问 · {turnKindLabel(turn)}
              </span>
              <span>{turnStatusLabel(turn)}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-6 text-stone-900">
              {turn.question}
            </p>
            {turn.answer && (
              <div className="mt-3 rounded-xl bg-stone-50 px-3 py-2">
                <p className="text-xs font-medium text-stone-500">你的回答</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-stone-700">
                  {turn.answer}
                </p>
              </div>
            )}
            {turn.assessment && (
              <div className="mt-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${assessmentTone(
                    turn.assessment.level,
                  )}`}
                >
                  {assessmentLabel(turn.assessment.level)}
                </span>
                {turn.assessment.issues.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-stone-600">
                    {turn.assessment.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </article>
        ))}
        {detail.turns.length === 0 && (
          <div className="rounded-2xl border border-dashed border-stone-300 p-6 text-sm text-stone-500">
            正在生成第一道题…
          </div>
        )}
      </div>

      {answerError && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          <span className="min-w-0 flex-1">{answerError}</span>
          {pendingAnswer && (
            <button
              className="font-medium underline underline-offset-2"
              disabled={isSubmitting}
              onClick={onRetryAnswer}
              type="button"
            >
              重试评估
            </button>
          )}
        </div>
      )}

      <div className="mt-3 shrink-0 border-t border-stone-200 pt-3">
        {needsNextQuestion ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600">
            <span>下一题还没有生成成功。</span>
            <button
              className="font-medium text-emerald-800 underline underline-offset-2 disabled:opacity-50"
              disabled={isSubmitting || isEnding}
              onClick={onRetrySkip}
              type="button"
            >
              重试生成
            </button>
          </div>
        ) : detail.status === 'reporting' ? (
          <div className="flex items-center gap-2 rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600" role="status">
            <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            正在生成总体评估…
          </div>
        ) : canAnswer && detail.currentQuestion ? (
          <>
            <textarea
              aria-label="回答学生的问题"
              className="min-h-24 w-full resize-none rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm leading-6 text-stone-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-800/10 disabled:bg-stone-50"
              disabled={busy}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="用你自己的话回答，尽量给出具体例子…"
              rows={3}
              value={answer}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <button
                  className="text-xs font-medium text-stone-500 underline underline-offset-2 hover:text-stone-800 disabled:opacity-40"
                  disabled={busy}
                  onClick={onSkip}
                  type="button"
                >
                  跳过此题
                </button>
                <span className="text-xs text-stone-400">跳过消耗 1 个名额</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">Ctrl + Enter 提交</span>
                <button
                  className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy || !answer.trim()}
                  onClick={submit}
                  type="button"
                >
                  {busy ? '评估中…' : '提交回答'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600" role="status">
            <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            {detail.status === 'evaluating' ? '正在评估你的回答…' : '学生正在思考…'}
          </div>
        )}
      </div>
    </div>
  );
}
