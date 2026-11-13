import {
  ArrowLeft,
  ArrowClockwise,
  ArrowRight,
  Chalkboard,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { DeleteLessonDialog } from './DeleteLessonDialog';
import { clearClassroomDraft } from './classroom-drafts';
import { PageHeader } from '../../components/PageHeader';
import {
  deleteLesson,
  endLesson,
  generateLessonSummary,
  listLessons,
  loadLessonMessages,
  loadLessonSummary,
  type LessonListEntry,
  type LessonMessageView,
  type LessonSummaryStatus,
  type LessonSummaryView,
} from './classroom-api';

/** One opened history lesson: summary plus its transcript. */
interface LessonDetail {
  lesson: LessonListEntry;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  summary: LessonSummaryView | null;
  messages: LessonMessageView[];
}

const SUMMARY_LABEL: Record<LessonSummaryStatus, string> = {
  none: '尚未生成总结',
  generating: '正在整理课堂记录…',
  ready: '总结已生成',
  failed: '总结生成失败',
};

/**
 * Classroom landing page: the current lesson, past lessons with their summaries, and the CTA.
 *
 * It replaces the old "entering the sidebar item opens the stage" behavior. The stage is a separate
 * view so its window can lock to 16:9; this page keeps the normal sidebar layout.
 */
export function ClassroomHome({
  onEnterStage,
  summaryRunning,
}: {
  /** Enters the stage; omitted means a draft classroom that is created on the first send. */
  onEnterStage: (lessonId?: string) => void;
  /** True while the stage's end action is still generating a summary in the background. */
  summaryRunning?: boolean;
}) {
  const [activeLesson, setActiveLesson] = useState<LessonListEntry | null>(null);
  const [history, setHistory] = useState<LessonListEntry[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<LessonDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LessonListEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [activeLessons, endedLessons] = await Promise.all([
        listLessons('active'),
        listLessons('ended'),
      ]);
      setActiveLesson(activeLessons[0] ?? null);
      setHistory(endedLessons);
      setListStatus('ready');
      setListError(null);
    } catch (error) {
      setListStatus('error');
      setListError(
        error instanceof Error ? error.message : '读取课堂列表失败，请重试。',
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A summary is generated in the background; poll only while one is in flight.
  const hasGeneratingSummary = useMemo(
    () => history.some((lesson) => lesson.summaryStatus === 'generating'),
    [history],
  );
  const detailLessonId = detail?.lesson.id ?? null;
  const detailGenerating = detail?.summary?.summaryStatus === 'generating';

  /** Re-reads only the open detail's summary; list refresh alone leaves its spinner running. */
  const refreshDetailSummary = useCallback(async (lessonId: string): Promise<void> => {
    try {
      const summary = await loadLessonSummary(lessonId);
      setDetail((current) =>
        current && current.lesson.id === lessonId ? { ...current, summary } : current,
      );
    } catch {
      // The list poll still reports the stored status; a transient read failure is retried.
    }
  }, []);

  useEffect(() => {
    if (!hasGeneratingSummary && !summaryRunning && !detailGenerating) return;
    const timer = window.setInterval(() => {
      void refresh();
      if (detailGenerating && detailLessonId) {
        void refreshDetailSummary(detailLessonId);
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [
    hasGeneratingSummary,
    summaryRunning,
    detailGenerating,
    detailLessonId,
    refresh,
    refreshDetailSummary,
  ]);

  /** Enters a draft stage; the backend lesson is created by the first message. */
  const startNewLesson = (): void => {
    onEnterStage();
  };

  /** Ends the active lesson, refreshes the list, and lets the summary run in the background. */
  const endActiveLesson = async (): Promise<void> => {
    if (!activeLesson) return;
    setBusy(`ending:${activeLesson.id}`);
    try {
      await endLesson(activeLesson.id);
      clearClassroomDraft(activeLesson.id);
      await refresh();
      void generateSummary(activeLesson.id);
    } catch (error) {
      setListError(
        error instanceof Error ? error.message : '结束课堂失败，请重试。',
      );
    } finally {
      setBusy(null);
    }
  };

  /** Generates one summary; failures land in the row status and are picked up by refresh. */
  const generateSummary = async (lessonId: string): Promise<void> => {
    setBusy(`summary:${lessonId}`);
    try {
      const summary = await generateLessonSummary(lessonId);
      setDetail((current) =>
        current && current.lesson.id === lessonId
          ? { ...current, summary, status: 'ready', error: null }
          : current,
      );
    } catch {
      // The stored status (failed) is what the UI reports; no toast needed here.
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  /** Deletes one history lesson after the confirmation dialog. */
  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    try {
      await deleteLesson(deleteTarget.id);
      if (detail?.lesson.id === deleteTarget.id) setDetail(null);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      setDeleteTarget(null);
      setListError(
        error instanceof Error ? error.message : '删除课堂记录失败，请重试。',
      );
    } finally {
      setIsDeleting(false);
    }
  };

  /** Opens one past lesson: its summary and transcript load together. */
  const openDetail = async (lesson: LessonListEntry): Promise<void> => {
    setDetail({ lesson, status: 'loading', error: null, summary: null, messages: [] });
    try {
      const [summary, view] = await Promise.all([
        loadLessonSummary(lesson.id),
        loadLessonMessages(lesson.id),
      ]);
      setDetail({
        lesson,
        status: 'ready',
        error: null,
        summary,
        messages: view.messages,
      });
    } catch (error) {
      setDetail((current) =>
        current && current.lesson.id === lesson.id
          ? {
              ...current,
              status: 'error',
              error:
                error instanceof Error ? error.message : '读取课堂详情失败，请重试。',
            }
          : current,
      );
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-50/50">
      {detail ? (
        <LessonDetailView
          detail={detail}
          busy={busy}
          onBack={() => setDetail(null)}
          onRegenerate={() => void generateSummary(detail.lesson.id)}
        />
      ) : (
        <>
          <PageHeader className="justify-between">
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">课堂模式</h1>
            <button
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-wait disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
              onClick={startNewLesson}
              type="button"
            >
              <Plus aria-hidden="true" className="size-4" />
              开始新课堂
            </button>
          </PageHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8 md:py-8">
            <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 pb-8">
              {listError && (
                <div
                  className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
                  role="alert"
                >
                  <span className="min-w-0 flex-1">{listError}</span>
                  <button
                    className="shrink-0 font-medium underline underline-offset-2"
                    onClick={() => void refresh()}
                    type="button"
                  >
                    重试
                  </button>
                </div>
              )}

              {listStatus === 'loading' ? (
                <p className="py-16 text-center text-sm text-ink-500">正在加载课堂…</p>
              ) : (
                <>
                  <section aria-label="进行中的课堂">
                    <h2 className="mb-3 text-sm font-semibold text-ink-700">进行中的课堂</h2>
                    {activeLesson ? (
                      <div className="flex flex-col gap-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-semibold text-ink-900">
                            课堂 · {formatDateTime(activeLesson.createdAt)}
                          </p>
                          <p className="mt-1 text-xs text-ink-500">
                            继续上次的讲解，学生会在你发送后回应。
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-700 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-wait disabled:opacity-40"
                            disabled={busy === `ending:${activeLesson.id}`}
                            onClick={() => void endActiveLesson()}
                            type="button"
                          >
                            结束课堂
                          </button>
                          <button
                            className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3.5 py-2 text-sm font-semibold text-ink-800 transition hover:bg-ink-50"
                            onClick={() => onEnterStage(activeLesson.id)}
                            type="button"
                          >
                            继续上课
                            <ArrowRight aria-hidden="true" className="size-4" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-ink-300 bg-white/70 px-5 py-8 text-center">
                        <p className="text-sm font-medium text-ink-700">现在没有进行中的课堂</p>
                        <p className="mt-1 text-xs text-ink-500">
                          点击右上角「开始新课堂」，写下要讲给学生的内容。
                        </p>
                      </div>
                    )}
                  </section>

                  <section aria-label="历史课堂">
                    <h2 className="mb-3 text-sm font-semibold text-ink-700">历史课堂</h2>
                    {history.length === 0 ? (
                      <EmptyState
                        className="my-10"
                        description="结束一节课后，课堂总结会出现在这里，方便你回看学生关注过什么。"
                        hint="课堂记录只保存在本机。"
                        icon={Chalkboard}
                        title="还没有历史课堂"
                      />
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {history.map((lesson) => (
                          <li
                            className="flex items-center gap-1 rounded-2xl border border-ink-200 bg-white pr-2 transition hover:border-brand-300 hover:bg-brand-50/40"
                            key={lesson.id}
                          >
                            <button
                              className="flex min-w-0 flex-1 items-start gap-4 rounded-2xl px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
                              onClick={() => void openDetail(lesson)}
                              type="button"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-ink-900">
                                  {formatDateTime(lesson.endedAt ?? lesson.updatedAt)}
                                </p>
                                <p className="mt-1 line-clamp-2 text-sm leading-6 text-ink-600">
                                  {lesson.summaryPreview ??
                                    SUMMARY_LABEL[lesson.summaryStatus]}
                                </p>
                              </div>
                              <span className="shrink-0 pt-0.5 text-xs text-ink-500">
                                {SUMMARY_LABEL[lesson.summaryStatus]}
                              </span>
                            </button>
                            <button
                              aria-label={`删除课堂 ${formatDateTime(lesson.endedAt ?? lesson.updatedAt)}`}
                              className="shrink-0 rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
                              disabled={lesson.summaryStatus === 'generating'}
                              onClick={() => setDeleteTarget(lesson)}
                              title={
                                lesson.summaryStatus === 'generating'
                                  ? '总结生成中，暂时不能删除'
                                  : '删除这条课堂记录'
                              }
                              type="button"
                            >
                              <Trash aria-hidden="true" className="size-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {deleteTarget && (
        <DeleteLessonDialog
          busy={isDeleting}
          label={formatDateTime(deleteTarget.endedAt ?? deleteTarget.updatedAt)}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </section>
  );
}

/** Read-only view of one ended lesson: summary first, transcript below. */
function LessonDetailView({
  detail,
  busy,
  onBack,
  onRegenerate,
}: {
  detail: LessonDetail;
  busy: string | null;
  onBack: () => void;
  onRegenerate: () => void;
}) {
  const isGenerating =
    detail.summary?.summaryStatus === 'generating' ||
    busy === `summary:${detail.lesson.id}`;
  return (
    <>
      <PageHeader className="justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            aria-label="返回课堂首页"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-600 transition hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
          </button>
          <h1 className="truncate text-xl font-semibold tracking-tight text-ink-900">
            课堂 · {formatDateTime(detail.lesson.endedAt ?? detail.lesson.updatedAt)}
          </h1>
        </div>
        <button
          className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-medium text-ink-800 transition hover:bg-ink-50 disabled:cursor-wait disabled:opacity-40"
          disabled={isGenerating}
          onClick={onRegenerate}
          type="button"
        >
          <ArrowClockwise aria-hidden="true" className="size-4" />
          {detail.summary?.summaryStatus === 'ready' ? '重新生成总结' : '生成总结'}
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-8">
          {detail.status === 'loading' && (
            <p className="py-16 text-center text-sm text-ink-500">正在加载课堂记录…</p>
          )}

          {detail.status === 'error' && (
            <div
              className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
              role="alert"
            >
              {detail.error}
            </div>
          )}

          {detail.status === 'ready' && (
            <>
              <section
                aria-label="课堂总结"
                className="rounded-2xl border border-ink-200 bg-white p-5"
              >
                {isGenerating ? (
                  <p className="py-6 text-center text-sm text-ink-500">
                    正在整理课堂记录…
                  </p>
                ) : detail.summary?.summary ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-ink-800">
                    {detail.summary.summary}
                  </pre>
                ) : (
                  <p className="py-6 text-center text-sm text-ink-500">
                    {detail.summary?.error ?? SUMMARY_LABEL[detail.summary?.summaryStatus ?? 'none']}
                  </p>
                )}
              </section>

              <section aria-label="课堂记录">
                <h2 className="mb-3 text-sm font-semibold text-ink-700">
                  课堂记录 · {detail.messages.length} 条
                </h2>
                <ol className="flex flex-col gap-2">
                  {detail.messages.map((message) => (
                    <li
                      className={
                        message.role === 'teacher'
                          ? 'rounded-xl border-l-2 border-brand-500 bg-white px-4 py-2.5'
                          : 'rounded-xl bg-ink-100/70 px-4 py-2.5'
                      }
                      key={message.id}
                    >
                      <span className="text-[11px] font-semibold text-ink-600">
                        {message.name}
                      </span>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-900">
                        {message.text}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Short local date-time for classroom rows. */
function formatDateTime(value: string | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
