import { CircleNotch } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { RehearsalDetail } from './rehearsal-api';
import { TurnCopyButton } from './TurnCopyButton';
import {
  assessmentLabel,
  assessmentTone,
  turnStatusLabel,
} from './rehearsal-ui-utils';

/** First non-empty line of a draft; the evaluation status line shows only this line. */
function firstAnswerLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

/** Question/answer transcript and the composer for the active drill. */
export function RehearsalSession({
  detail,
  isSubmitting,
  isEvaluatingAnswer,
  isEnding,
  answerError,
  pendingAnswer,
  onAnswer,
  onEnd,
  onSkip,
  onRetryAnswer,
  onRetrySkip,
  showEndAction,
}: {
  detail: RehearsalDetail;
  isSubmitting: boolean;
  isEvaluatingAnswer: boolean;
  isEnding: boolean;
  answerError: string | null;
  pendingAnswer: { turnId: string; answer: string; requestId: string } | null;
  onAnswer: (answer: string) => void;
  onEnd: () => void;
  onSkip: () => void;
  onRetryAnswer: () => void;
  onRetrySkip: () => void;
  showEndAction: boolean;
}) {
  const [answer, setAnswer] = useState('');
  // First line of the answer currently being evaluated; the composer is empty at that point, so
  // the status line carries the text that was sent.
  const [submittedPreview, setSubmittedPreview] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const questionId = detail.currentQuestion?.turnId ?? null;

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
  // An answer evaluation is running either locally (request in flight) or server-side after a
  // reload; both keep the composer read-only and show one status line.
  const isEvaluating = isEvaluatingAnswer || detail.status === 'evaluating';
  const evaluatingPreview = isEvaluating
    ? submittedPreview ?? (pendingAnswer ? firstAnswerLine(pendingAnswer.answer) : null)
    : null;

  useEffect(() => {
    setAnswer('');
    setSubmittedPreview(null);
  }, [questionId]);

  // A restored answer whose evaluation never finished is the only text the backend accepts for
  // that turn, so surface it in the composer instead of an empty box. The draft stays empty while
  // an evaluation runs: the submitted text lives in the status line, not in the box.
  useEffect(() => {
    if (pendingAnswer && !isEvaluating) {
      setAnswer((current) => current || pendingAnswer.answer);
    }
  }, [pendingAnswer, isEvaluating]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [detail.turns.length, detail.status]);

  // A question only becomes answerable by the model writing it, and the browser leaves focus on
  // the body (the textarea remounted after an evaluation) or on the skip button. Claim the caret
  // once per question so answering never starts with a click. `preventScroll` keeps the page still:
  // the effect above owns scrolling the transcript to the newest question.
  useEffect(() => {
    const composer = composerRef.current;
    if (!canAnswer || !composer) return;
    const active = document.activeElement;
    const typingElsewhere =
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== composer &&
      (active.matches('input, textarea, [contenteditable="true"]') ||
        active.isContentEditable);
    if (!typingElsewhere) composer.focus({ preventScroll: true });
  }, [canAnswer, questionId]);

  const submit = (): void => {
    if (!answer.trim() || busy) return;
    setSubmittedPreview(firstAnswerLine(answer));
    setAnswer('');
    onAnswer(answer);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 pb-3">
        <h2 className="truncate text-sm font-semibold text-ink-900">
          {detail.topic || '演练进行中'}
        </h2>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pr-1"
        ref={viewportRef}
      >
        {detail.turns.map((turn) => (
          <article
            className={`rounded-2xl border px-4 py-3 ${
              turn.turnId === questionId
                ? 'border-brand-300 bg-brand-50/40'
                : 'border-ink-200 bg-white'
            }`}
            key={turn.turnId}
          >
            <div className="flex items-center justify-between gap-3 text-xs text-ink-500">
              <span>第 {turn.sequenceNo} 问</span>
              {turn.answer?.trim() ? (
                <TurnCopyButton turn={turn} />
              ) : (
                <span>{turnStatusLabel(turn)}</span>
              )}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-6 text-ink-900">
              {turn.question}
            </p>
            {turn.answer && (
              <div className="mt-3 rounded-xl bg-ink-50 px-3 py-2">
                <p className="text-xs font-medium text-ink-500">你的回答</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-700">
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
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-ink-600">
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
          <div className="rounded-2xl border border-dashed border-ink-300 p-6 text-sm text-ink-500">
            正在生成第一道题…
          </div>
        )}
      </div>

      {answerError && !pendingAnswer && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          <span className="min-w-0 flex-1">{answerError}</span>
        </div>
      )}

      <div className="mt-3 shrink-0 border-t border-ink-200 pt-3">
        {isEvaluating && (
          <div
            className="mb-2 flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600"
            role="status"
            title={evaluatingPreview ?? undefined}
          >
            <CircleNotch aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              {evaluatingPreview
                ? `正在评估：${evaluatingPreview}`
                : '正在进行评估…'}
            </span>
          </div>
        )}
        {pendingAnswer && !isEvaluating ? (
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-medium">上次回答已保存，但评估没有完成。</p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-amber-800">
              “{pendingAnswer.answer}”
            </p>
            {answerError && (
              <p className="mt-1 text-xs text-rose-700">{answerError}</p>
            )}
            <button
              className="mt-2 rounded-lg bg-amber-800 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              disabled={isSubmitting}
              onClick={onRetryAnswer}
              type="button"
            >
              重试评估
            </button>
          </div>
        ) : needsNextQuestion ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600">
            <span>下一题还没有生成成功。</span>
            <button
              className="font-medium text-brand-600 underline underline-offset-2 disabled:opacity-50"
              disabled={isSubmitting || isEnding}
              onClick={onRetrySkip}
              type="button"
            >
              重试生成
            </button>
          </div>
        ) : detail.status === 'reporting' ? (
          <div className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600" role="status">
            <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            正在生成总体评估…
          </div>
        ) : canAnswer && detail.currentQuestion ? (
          <textarea
            aria-label="回答学生的问题"
            className="min-h-24 w-full resize-none rounded-xl border border-ink-300 bg-white px-3 py-2 text-sm leading-6 text-ink-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/10 disabled:bg-ink-50"
            disabled={busy}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="用你自己的话回答，尽量给出具体例子…（Ctrl + Enter 提交）"
            ref={composerRef}
            rows={3}
            value={answer}
          />
        ) : isEvaluating ? null : (
          <div className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600" role="status">
            <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            学生正在思考…
          </div>
        )}

        {(showEndAction || canAnswer) && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            {showEndAction ? (
              <button
                className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                onClick={onEnd}
                type="button"
              >
                结束演练
              </button>
            ) : (
              <span />
            )}
            {canAnswer && (
              <div className="ml-auto flex items-center gap-6">
                <button
                  className="text-xs font-medium text-ink-500 underline underline-offset-2 hover:text-ink-800 disabled:opacity-40"
                  disabled={busy}
                  onClick={onSkip}
                  type="button"
                >
                  跳过此题
                </button>
                <button
                  className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy || !answer.trim()}
                  onClick={submit}
                  type="button"
                >
                  提交回答
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
