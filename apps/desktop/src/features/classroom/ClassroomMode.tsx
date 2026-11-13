import {
  ArrowLeft,
  ChatsCircle,
  CircleNotch,
  FlagPennant,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import classroomBackground from '../../assets/classroom/bg-classroom.png';
import { ClassroomComposer } from './ClassroomComposer';
import { ClassroomMessageDrawer } from './ClassroomMessageDrawer';
import { ClassroomRecoveryBanner } from './ClassroomRecoveryBanner';
import { EndClassroomDialog } from './EndClassroomDialog';
import {
  clearClassroomDraft,
  getClassroomDraft,
  setClassroomDraft,
} from './classroom-drafts';
import {
  createLesson,
  endLesson,
  loadLessonMessages,
  sendLessonTurn,
  type LessonMessageView,
  type LessonMessagesView,
  type LessonSpeaker,
  type LessonStatus,
} from './classroom-api';
import { hasDesktopBridge } from '../../types/desktop-bridge';

/** How long the just-sent lecture stays above the composer before it fades into the sidebar. */
const LECTURE_PEEK_MS = 3600;

/** Horizontal anchor of each student's bubble, matching the artwork's three seats. */
const BUBBLE_LEFT: Record<Exclude<LessonSpeaker, 'teacher'>, string> = {
  // Left-to-right seats in the artwork: lin, su, gu.
  lin: '22%',
  su: '50%',
  gu: '78%',
};

/**
 * Renders the immersive classroom stage and owns the window's 16:9 mode.
 *
 * All content comes from the lesson API: entering loads the stored transcript, sending calls one
 * turn endpoint, and ending marks the lesson ended before returning to the classroom home. Leaving
 * the stage is temporary — the lesson and its messages stay on the backend.
 */
export function ClassroomMode({
  lessonId,
  onExit,
  onEnded,
}: {
  /** Null means a draft classroom: the backend row is created by the first message. */
  lessonId: string | null;
  /** Leaves the stage for the classroom home; an existing lesson keeps running. */
  onExit: () => void;
  /** Called after the lesson was ended, with its id for post-class summary generation. */
  onEnded: (lessonId: string) => void;
}) {
  const [activeLessonId, setActiveLessonId] = useState<string | null>(lessonId);
  const [status, setStatus] = useState<LessonStatus | null>(null);
  const [messages, setMessages] = useState<LessonMessageView[]>([]);
  const [integrity, setIntegrity] = useState<LessonMessagesView['integrity'] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isStartingNew, setIsStartingNew] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const draftKey = activeLessonId ?? 'new-lesson';
  const [lectureDraft, setLectureDraft] = useState(
    () => getClassroomDraft(draftKey).lecture,
  );
  const [replyDraft, setReplyDraft] = useState(
    () => getClassroomDraft(draftKey).reply,
  );
  const [isMessagesOpen, setIsMessagesOpen] = useState(false);
  const [isLecturePeekVisible, setIsLecturePeekVisible] = useState(false);
  const [isEndDialogOpen, setIsEndDialogOpen] = useState(false);
  const [peekText, setPeekText] = useState('');
  const peekTimerRef = useRef<number | null>(null);
  /** Invalidates an in-flight reload when the stage switches lessons or unmounts. */
  const requestSeq = useRef(0);
  /** Latest lesson id, readable inside async callbacks before React state catches up. */
  const lessonIdRef = useRef<string | null>(lessonId);
  /** Set when `activeLessonId` changes because the first send created it; skip one reload. */
  const skipNextLoadRef = useRef(false);
  const endButtonRef = useRef<HTMLButtonElement | null>(null);

  const phase = messages.length === 0 ? 'composing' : 'sent';
  const isEnded = status === 'ended';
  const busy = isSending || isEnding || isStartingNew;

  // The ratio lock lives in the main process; release it on every route out (exit, Esc, window close).
  useEffect(() => {
    if (!hasDesktopBridge()) return;
    void window.teachforge.setClassroomMode(true).catch((error: unknown) => {
      console.error(
        '[TeachForge][classroom] aspect_lock_failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
    });
    return () => {
      void window.teachforge.setClassroomMode(false).catch((error: unknown) => {
        console.error(
          '[TeachForge][classroom] aspect_unlock_failed',
          error instanceof Error ? error.name : 'UnknownError',
        );
      });
    };
  }, []);

  /** Reloads the stored transcript; stale responses from a previous lesson are dropped. */
  const reloadMessages = useCallback(async (): Promise<boolean> => {
    const sequence = ++requestSeq.current;
    if (!activeLessonId) {
      // Draft classroom: nothing is stored yet, so there is nothing to load.
      setMessages([]);
      setStatus(null);
      setIntegrity(null);
      setTurnError(null);
      return true;
    }
    try {
      const view = await loadLessonMessages(activeLessonId);
      if (sequence !== requestSeq.current) return false;
      setMessages(view.messages);
      setStatus(view.status);
      setIntegrity(view.integrity);
      setTurnError(null);
      return true;
    } catch (error: unknown) {
      if (sequence !== requestSeq.current) return false;
      setTurnError(
        error instanceof Error ? error.message : '读取课堂记录失败。',
      );
      return false;
    }
  }, [activeLessonId]);

  // Load the stored transcript before showing the stage; a failure must stay visible.
  useEffect(() => {
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    setIsLoading(true);
    void reloadMessages().finally(() => setIsLoading(false));
    return () => {
      // Invalidate any in-flight read once this lesson or the view goes away.
      requestSeq.current += 1;
    };
  }, [reloadMessages]);

  useEffect(
    () => () => {
      if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
    },
    [],
  );

  /** `Esc` closes what is on top first; inside the composer it never discards a draft. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (isEndDialogOpen) {
        closeEndDialog();
        return;
      }
      if (isMessagesOpen) {
        setIsMessagesOpen(false);
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest('.tf-classroom-composer')) return;
      onExit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEndDialogOpen, isMessagesOpen, onExit]);

  /** Shows the just-sent lecture above the composer, then hands it over to the sidebar. */
  const showLecturePeek = (text: string): void => {
    if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
    setPeekText(text);
    setIsLecturePeekVisible(true);
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null;
      setIsLecturePeekVisible(false);
    }, LECTURE_PEEK_MS);
  };

  /** Persists one draft outside component state so leaving the stage does not drop it. */
  const keepDraft = (patch: { lecture?: string; reply?: string }): void => {
    setClassroomDraft(lessonIdRef.current ?? 'new-lesson', patch);
  };

  /** Sends one teacher message and adopts the transcript the backend returns. */
  const send = async (variant: 'lecture' | 'reply'): Promise<void> => {
    const text = (variant === 'lecture' ? lectureDraft : replyDraft).trim();
    if (!text || busy || isEnded) return;
    setIsSending(true);
    setTurnError(null);

    // Show the teacher's line immediately, before any request: clear the composer, move the text
    // above it, and add an optimistic row. The backend list replaces it on success.
    const optimisticId = `pending-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: optimisticId,
        speaker: 'teacher',
        role: 'teacher',
        name: '老师',
        text,
        createdAt: new Date().toISOString(),
      },
    ]);
    if (variant === 'lecture') {
      setLectureDraft('');
      keepDraft({ lecture: '' });
      showLecturePeek(text);
    } else {
      setReplyDraft('');
      keepDraft({ reply: '' });
    }

    let lessonIdForTurn = lessonIdRef.current;
    try {
      if (!lessonIdForTurn) {
        // The first message creates the classroom; only then can it be ended.
        const created = await createLesson();
        lessonIdForTurn = created.id;
        lessonIdRef.current = created.id;
        // The turn itself returns the transcript; reloading now would flash an empty list.
        skipNextLoadRef.current = true;
        setActiveLessonId(created.id);
        setStatus('active');
        clearClassroomDraft('new-lesson');
      }

      const view = await sendLessonTurn(lessonIdForTurn, text);
      setMessages(view.messages);
      setStatus(view.status);
      setIntegrity(view.integrity);
      setIsMessagesOpen(false);
    } catch (error) {
      if (!lessonIdForTurn) {
        // Creation failed: withdraw the optimistic row and put the text back in the composer.
        setMessages((current) =>
          current.filter((message) => message.id !== optimisticId),
        );
        if (variant === 'lecture') {
          setLectureDraft(text);
          keepDraft({ lecture: text });
          if (peekTimerRef.current !== null) {
            window.clearTimeout(peekTimerRef.current);
            peekTimerRef.current = null;
          }
          setIsLecturePeekVisible(false);
        } else {
          setReplyDraft(text);
          keepDraft({ reply: text });
        }
        setTurnError(
          error instanceof Error ? error.message : '创建课堂失败，请重试。',
        );
        return;
      }

      // The teacher message may already be persisted before the model failed; reload so the list
      // matches the backend instead of inviting a duplicate retry.
      let reloaded = false;
      let persisted = false;
      try {
        const view = await loadLessonMessages(lessonIdForTurn);
        setMessages(view.messages);
        setStatus(view.status);
        setIntegrity(view.integrity);
        reloaded = true;
        const last = view.messages[view.messages.length - 1];
        persisted = last?.role === 'teacher' && last.text === text;
      } catch {
        // Keep the optimistic row; the turn error below already explains the failure.
      }
      if (reloaded && !persisted) {
        // Nothing was stored, so put the text back where the user can send it again.
        if (variant === 'lecture') {
          setLectureDraft(text);
          keepDraft({ lecture: text });
          // The draft is back in the composer; drop the peek so the text is not shown twice.
          if (peekTimerRef.current !== null) {
            window.clearTimeout(peekTimerRef.current);
            peekTimerRef.current = null;
          }
          setIsLecturePeekVisible(false);
        } else {
          setReplyDraft(text);
          keepDraft({ reply: text });
        }
      }
      setTurnError(
        error instanceof Error ? error.message : '这一轮没有完成，请重试。',
      );
    } finally {
      setIsSending(false);
    }
  };

  /** Ends the lesson, then lets the parent return to the home and start the summary. */
  const endClassroom = async (): Promise<void> => {
    if (isEnding || !activeLessonId) return;
    setIsEnding(true);
    setTurnError(null);
    try {
      await endLesson(activeLessonId);
      clearClassroomDraft(activeLessonId);
      setIsEndDialogOpen(false);
      onEnded(activeLessonId);
    } catch (error) {
      setIsEndDialogOpen(false);
      setTurnError(
        error instanceof Error ? error.message : '结束课堂失败，请重试。',
      );
    } finally {
      setIsEnding(false);
    }
  };

  /** Creates a fresh lesson and switches the stage to it; used by the degraded-record banner. */
  const startNewLesson = async (): Promise<void> => {
    if (isStartingNew) return;
    setIsStartingNew(true);
    try {
      const lesson = await createLesson();
      // The previous lesson was closed by the backend; its draft no longer applies.
      if (activeLessonId) clearClassroomDraft(activeLessonId);
      lessonIdRef.current = lesson.id;
      setActiveLessonId(lesson.id);
      setStatus('active');
      setMessages([]);
      setIntegrity(null);
    } catch (error) {
      setTurnError(
        error instanceof Error ? error.message : '创建课堂失败，请重试。',
      );
    } finally {
      setIsStartingNew(false);
    }
  };

  /** Opening the sidebar cancels the peek; the lecture is already waiting there in full. */
  const openMessages = (): void => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    setIsLecturePeekVisible(false);
    setIsMessagesOpen(true);
  };

  /** Cancels the confirmation and returns focus to the button that opened it. */
  const closeEndDialog = (): void => {
    setIsEndDialogOpen(false);
    endButtonRef.current?.focus();
  };

  const latestStudentMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'student');
  const isQuestionVisible = Boolean(
    latestStudentMessage &&
      messages[messages.length - 1]?.role === 'student' &&
      !isEnded,
  );
  const draftInProgress =
    phase === 'composing' ? lectureDraft.trim().length > 0 : replyDraft.trim().length > 0;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-hidden bg-ink-900">
      <div className="tf-classroom-viewport">
        <div
          aria-label="课堂模式舞台"
          className="tf-classroom-stage overflow-hidden bg-ink-900"
          role="region"
        >
          {/* The artwork owns the reveal animation, so the mask never clips the controls. */}
          <div
            aria-hidden="true"
            className="tf-classroom-art"
            style={{ backgroundImage: `url(${classroomBackground})` }}
          />

          <div className="tf-classroom-overlay absolute inset-x-0 top-0 flex items-start justify-start py-4 pl-[2.5%] pr-4 md:py-5">
            <div
              aria-label="课堂操作"
              className="inline-flex h-10 shrink-0 items-center rounded-full border border-white/70 bg-white/80 p-1 shadow-card backdrop-blur-md"
              role="group"
            >
              <button
                autoFocus
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-ink-800 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                onClick={onExit}
                title="保留本节课进度，返回课堂首页"
                type="button"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                退出课堂
              </button>
              {/* Only a loaded, active lesson can be ended: while the record is still loading (or
                  failed to load) there is nothing valid to end yet. */}
              {status === 'active' && activeLessonId && (
                <button
                  aria-haspopup="dialog"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-ink-800 transition-colors hover:bg-rose-50/90 hover:text-rose-700 focus-visible:bg-rose-50/90 focus-visible:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={isEnding}
                  onClick={() => setIsEndDialogOpen(true)}
                  ref={endButtonRef}
                  title="结束本节课并整理课堂记录"
                  type="button"
                >
                  <FlagPennant aria-hidden="true" className="size-4" />
                  结束课堂
                </button>
              )}
            </div>
          </div>

          {turnError ? (
            <ClassroomRecoveryBanner
              busy={busy}
              message={turnError}
              onRetry={() => void reloadMessages()}
              onStartNew={() => void startNewLesson()}
              variant="error"
            />
          ) : (
            integrity?.status === 'degraded' && (
              <ClassroomRecoveryBanner
                busy={busy}
                corruptLineCount={integrity.corruptLineCount}
                onRetry={() => void reloadMessages()}
                onStartNew={() => void startNewLesson()}
                variant="degraded"
              />
            )
          )}

          {isLoading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/40 text-sm text-ink-700 backdrop-blur-sm">
              正在加载课堂记录…
            </div>
          )}

          {isSending && !isEnded && (
            <>
              <span className="sr-only" role="status">
                学生正在思考中
              </span>
              {(['su', 'lin', 'gu'] as const).map((speaker) => (
                <div
                  aria-hidden="true"
                  className="tf-classroom-bubble absolute bottom-[66%] flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/70 bg-white/90 px-3 py-1.5 text-xs text-ink-600 shadow-card backdrop-blur-md"
                  key={speaker}
                  style={{ left: BUBBLE_LEFT[speaker] }}
                >
                  <CircleNotch
                    aria-hidden="true"
                    className="size-3 animate-spin motion-reduce:animate-none"
                  />
                  正在思考中…
                  <span className="absolute -bottom-1 left-1/2 size-2 -translate-x-1/2 rotate-45 border-b border-r border-white/70 bg-white/90" />
                </div>
              ))}
            </>
          )}

          {isQuestionVisible && latestStudentMessage && (
            <div
              aria-live="polite"
              className="tf-classroom-bubble absolute bottom-[64%] flex w-[30%] max-w-[24rem] -translate-x-1/2 flex-col gap-1 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 text-left shadow-card backdrop-blur-md"
              style={{
                left:
                  BUBBLE_LEFT[
                    latestStudentMessage.speaker as Exclude<LessonSpeaker, 'teacher'>
                  ] ?? '50%',
              }}
            >
              <span className="text-xs font-semibold text-brand-700">
                {latestStudentMessage.name}
              </span>
              <p className="text-sm leading-6 text-ink-900">{latestStudentMessage.text}</p>
              <span
                aria-hidden="true"
                className="absolute -bottom-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-b border-r border-white/70 bg-white/90"
              />
            </div>
          )}

          <div className="tf-classroom-composer absolute inset-x-0 bottom-[3%] flex justify-center">
            <div className="relative w-[46%] min-w-[20rem] max-w-[42rem]">
              {isLecturePeekVisible && (
                <section
                  aria-label="刚发送的讲稿"
                  className="tf-classroom-peek absolute bottom-[calc(100%+0.5rem)] left-0 right-0 rounded-2xl border border-ink-200 bg-white/95 shadow-card backdrop-blur-sm"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-3 py-1.5">
                    <span className="text-xs font-semibold text-ink-700">
                      讲稿 · {Array.from(peekText).length} 字
                    </span>
                    <button
                      className="text-[11px] font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                      onClick={openMessages}
                      type="button"
                    >
                      查看全部
                    </button>
                  </div>
                  <p className="tf-scrollbar max-h-24 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-sm leading-6 text-ink-800">
                    {peekText}
                  </p>
                </section>
              )}
              {isEnded ? (
                <div className="rounded-3xl border border-ink-200 bg-white/90 px-5 py-4 text-center text-sm text-ink-600 shadow-card">
                  本节课已结束。课堂记录与总结可在课堂首页查看。
                </div>
              ) : (
                <ClassroomComposer
                  autoFocus={phase === 'sent'}
                  className="shadow-card"
                  disabled={busy}
                  onChange={(value) => {
                    if (phase === 'sent') {
                      setReplyDraft(value);
                      keepDraft({ reply: value });
                    } else {
                      setLectureDraft(value);
                      keepDraft({ lecture: value });
                    }
                  }}
                  onSend={() => void send(phase === 'sent' ? 'reply' : 'lecture')}
                  value={phase === 'sent' ? replyDraft : lectureDraft}
                  variant={phase === 'sent' ? 'reply' : 'lecture'}
                />
              )}
            </div>
          </div>

          {!isMessagesOpen && (
            <button
              aria-controls="classroom-messages"
              aria-expanded={false}
              aria-label={`展开课堂消息（${messages.length} 条）`}
              className="absolute bottom-[3%] right-[2.5%] z-20 inline-flex size-11 items-center justify-center rounded-full border border-white/70 bg-white/80 text-ink-800 opacity-90 shadow-card backdrop-blur-md transition hover:bg-white hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              onClick={openMessages}
              type="button"
            >
              <ChatsCircle aria-hidden="true" className="size-5" />
              {messages.length > 0 && (
                <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-brand-700 px-1 text-[11px] font-semibold leading-5 text-white">
                  {messages.length}
                </span>
              )}
            </button>
          )}

          <ClassroomMessageDrawer
            messages={messages}
            onClose={() => setIsMessagesOpen(false)}
            open={isMessagesOpen}
          />

          {isEndDialogOpen && (
            <EndClassroomDialog
              hasUnsavedDraft={draftInProgress}
              onCancel={closeEndDialog}
              onConfirm={() => void endClassroom()}
            />
          )}
        </div>
      </div>
    </div>
  );
}
