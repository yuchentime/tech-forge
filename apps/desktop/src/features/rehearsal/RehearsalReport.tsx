import { CircleNotch } from '@phosphor-icons/react';
import type { RehearsalDetail } from './rehearsal-api';
import {
  assessmentLabel,
  assessmentTone,
  endReasonLabel,
  formatRehearsalDate,
  truncateText,
  turnStatusLabel,
} from './rehearsal-ui-utils';

/** Mastery label for the overall report. */
function masteryLabel(status: string): string {
  if (status === 'mastered') return '掌握';
  if (status === 'partial') return '部分掌握';
  if (status === 'weak') return '薄弱';
  return '未验证';
}

/** Read-only overall report, shared by the live report and history detail views. */
export function RehearsalReport({
  detail,
  mode,
  isEnding,
  isStarting,
  onContinue,
  onBackChat,
  onBackHistory,
  onAdjustPersona,
  onRetryEnd,
}: {
  detail: RehearsalDetail;
  mode: 'live' | 'history';
  isEnding: boolean;
  isStarting: boolean;
  onContinue: () => void;
  onBackChat: () => void;
  onBackHistory?: () => void;
  onAdjustPersona?: () => void;
  onRetryEnd?: () => void;
}) {
  const report = detail.report;
  const pointLabels = new Map(
    (detail.plan?.knowledgePoints ?? []).map((point) => [point.id, point.label]),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-stone-900">
            {detail.topic || '演练报告'}
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            {mode === 'history' ? '历史演练 · ' : ''}
            {formatRehearsalDate(detail.endedAt ?? detail.createdAt)}
            {detail.endReason ? ` · ${endReasonLabel(detail.endReason)}` : ''}
            {` · 已提问 ${detail.progress.asked}/${detail.progress.limit}`}
            {detail.progress.skipped > 0
              ? ` · 跳过 ${detail.progress.skipped}`
              : ''}
          </p>
          {detail.persona && (
            <p className="mt-1 text-xs text-stone-400">
              学生画像：{truncateText(detail.persona, 120)}
            </p>
          )}
        </div>
        {mode === 'history' && onBackHistory && (
          <button
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-50"
            onClick={onBackHistory}
            type="button"
          >
            返回历史
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {detail.status === 'reporting' ? (
          <div className="flex items-center gap-2 rounded-2xl bg-stone-50 px-4 py-6 text-sm text-stone-600" role="status">
            <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            正在生成总体评估…
          </div>
        ) : report ? (
          <>
            <section className="rounded-2xl border border-stone-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-stone-900">总体评估</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-700">
                {report.summary}
              </p>
              {report.knowledgePointMastery.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {report.knowledgePointMastery.map((point) => (
                    <span
                      className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700"
                      key={point.pointId}
                    >
                      {pointLabels.get(point.pointId) ?? point.pointId}：
                      {masteryLabel(point.status)}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <ReportList title="优势" values={report.strengths} />
                <ReportList title="薄弱点" values={report.gaps} />
                <ReportList title="建议复习" values={report.recommendedReview} />
              </div>
              {report.suggestions.length > 0 && (
                <div className="mt-4 rounded-xl bg-emerald-50/60 px-3 py-2">
                  <p className="text-xs font-medium text-emerald-900">下一步建议</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-emerald-900">
                    {report.suggestions.map((suggestion) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-3 text-xs text-stone-400">{report.disclaimer}</p>
            </section>

            <section className="mt-4 space-y-3">
              <h3 className="text-sm font-semibold text-stone-900">逐题记录</h3>
              {detail.turns.map((turn) => (
                <article
                  className="rounded-2xl border border-stone-200 bg-white px-4 py-3"
                  key={turn.turnId}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
                    <span>第 {turn.sequenceNo} 问</span>
                    <span>{turnStatusLabel(turn)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-6 text-stone-900">
                    {turn.question}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-600">
                    {turn.answer?.trim() || '（未作答）'}
                  </p>
                  {turn.assessment && (
                    <div className="mt-2">
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
            </section>
          </>
        ) : (
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <p className="font-medium">报告未完成</p>
            <p className="mt-1 leading-6">
              逐题记录已保留，但总体评估没有生成成功。
              {mode === 'live' ? '可以重试结束，或返回普通对话。' : '请返回历史或重新演练。'}
            </p>
            {mode === 'live' && onRetryEnd && (
              <button
                className="mt-3 rounded-lg bg-amber-800 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                disabled={isEnding}
                onClick={onRetryEnd}
                type="button"
              >
                {isEnding ? '重试中…' : '重试结束'}
              </button>
            )}
          </section>
        )}
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-3">
        {mode === 'live' && onAdjustPersona && (
          <button
            className="mr-auto text-xs font-medium text-stone-500 underline underline-offset-2 hover:text-stone-800"
            onClick={onAdjustPersona}
            type="button"
          >
            调整画像
          </button>
        )}
        <button
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-600 transition hover:bg-stone-50"
          onClick={onBackChat}
          type="button"
        >
          返回普通对话
        </button>
        <button
          className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={isStarting}
          onClick={onContinue}
          type="button"
        >
          {isStarting ? '正在开始…' : '继续演练'}
        </button>
      </div>
    </div>
  );
}

/** One compact bullet list in the report. */
function ReportList({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="rounded-xl bg-stone-50 px-3 py-2">
      <p className="text-xs font-medium text-stone-600">{title}</p>
      {values.length > 0 ? (
        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-stone-700">
          {values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-stone-400">无</p>
      )}
    </div>
  );
}
