import { ArrowLeft, ChatsCircle, FlagPennant, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import classroomBackground from '../../assets/classroom/bg-classroom.png';
import { ClassroomComposer } from './ClassroomComposer';
import { EndClassroomDialog } from './EndClassroomDialog';
import {
  CLASSROOM_STUDENT,
  classroomSessionStore,
} from './classroom-session-store';
import { hasDesktopBridge } from '../../types/desktop-bridge';

/** How long the sent lecture stays above the composer before it fades into the message sidebar. */
const LECTURE_PEEK_MS = 3600;

/**
 * Renders the immersive classroom stage and owns the window's 16:9 mode.
 *
 * The artwork is exactly 16:9, so the main process locks the OS window to that ratio while this
 * view is mounted and `.tf-classroom-stage` keeps the stage at 16:9 even where the window cannot be
 * locked (browser preview, a maximized window). The stage replaces the sidebar and header.
 *
 * Leaving the view (top-left button, `Esc`) is temporary: the session lives in
 * `classroomSessionStore`, so entering the classroom again restores the lecture, messages, drafts
 * and question bubble. The top-right "结束课堂" button is the only way to end the session, and it
 * asks for confirmation first.
 */
export function ClassroomMode({ onExit }: { onExit: () => void }) {
  const session = useSyncExternalStore(
    classroomSessionStore.subscribe,
    classroomSessionStore.getSnapshot,
    classroomSessionStore.getSnapshot,
  );
  const [isMessagesOpen, setIsMessagesOpen] = useState(false);
  const [isLecturePeekVisible, setIsLecturePeekVisible] = useState(false);
  const [isEndDialogOpen, setIsEndDialogOpen] = useState(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const peekTimerRef = useRef<number | null>(null);
  const endButtonRef = useRef<HTMLButtonElement | null>(null);

  // The ratio lock lives in the main process, not in this component's state: it must be released
  // on unmount for every route out (the exit button, Esc, closing the window).
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

  // The peek is driven by a timer, not by the CSS animation: the fade still ends on time for
  // reduced-motion users, where the animation is disabled.
  useEffect(
    () => () => {
      if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
    },
    [],
  );

  /** Keeps the newest message in view whenever the sidebar opens or grows. */
  useEffect(() => {
    if (!isMessagesOpen) return;
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [isMessagesOpen, session.messages]);

  /**
   * `Esc` closes what is on top first: the end dialog, then the sidebar. Inside the composer it
   * does nothing, so a half-written message is never thrown away; only outside it leaves the view
   * (which keeps the session for the next visit).
   */
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
  const showLecturePeek = (): void => {
    if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
    setIsLecturePeekVisible(true);
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null;
      setIsLecturePeekVisible(false);
    }, LECTURE_PEEK_MS);
  };

  /** Moves the written lecture onto the stage and turns the composer into the reply box. */
  const sendLecture = (): void => {
    if (!classroomSessionStore.sendLecture()) return;
    closeTransientPanels();
    showLecturePeek();
  };

  /** Sending a lecture starts a new round, so any open sidebar or end dialog is stale. */
  const closeTransientPanels = (): void => {
    setIsMessagesOpen(false);
    setIsEndDialogOpen(false);
  };

  /** MVP: the answer joins the sidebar and marks the question as handled; no model call yet. */
  const sendReply = (): void => {
    classroomSessionStore.sendReply();
  };

  /** Clears the round so the layout can be rehearsed again without ending the classroom. */
  const restartLecture = (): void => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    classroomSessionStore.reset();
    setIsLecturePeekVisible(false);
    setIsMessagesOpen(false);
    setIsEndDialogOpen(false);
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

  /** Ends the whole classroom, clears the session, and returns to the conversation. */
  const endClassroom = (): void => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    classroomSessionStore.reset();
    setIsEndDialogOpen(false);
    setIsMessagesOpen(false);
    setIsLecturePeekVisible(false);
    onExit();
  };

  const lectureCharacterCount = Array.from(session.lecture).length;
  const draftInProgress =
    session.phase === 'composing' ? session.lectureDraft.trim().length > 0 : session.reply.trim().length > 0;

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
          {/* Session lifecycle lives in one top-right segmented control: leaving and ending are
              the same category, so they share a container instead of occupying opposite corners.
              The end segment stays neutral until hover/focus; the dialog carries the danger. */}
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
                title="保留本节课进度，返回对话"
                type="button"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                退出课堂模式
              </button>
              <button
                aria-haspopup="dialog"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-ink-800 transition-colors hover:bg-rose-50/90 hover:text-rose-700 focus-visible:bg-rose-50/90 focus-visible:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                onClick={() => setIsEndDialogOpen(true)}
                ref={endButtonRef}
                title="结束本节课，清空本轮内容"
                type="button"
              >
                <FlagPennant aria-hidden="true" className="size-4" />
                结束课堂
              </button>
            </div>
          </div>

          {session.isQuestionVisible && (
            <div
              aria-live="polite"
              className="tf-classroom-bubble absolute bottom-[64%] left-1/2 flex w-[38%] max-w-[30rem] -translate-x-1/2 flex-col gap-1 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 text-left shadow-card backdrop-blur-md"
            >
              <span className="text-xs font-semibold text-brand-700">{CLASSROOM_STUDENT.name}</span>
              <p className="text-sm leading-6 text-ink-900">{CLASSROOM_STUDENT.question}</p>
              <span
                aria-hidden="true"
                className="absolute -bottom-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-b border-r border-white/70 bg-white/90"
              />
            </div>
          )}

          {/* The lecture and the composer share one dock; the peek floats above the box so it
              can fade away without moving the composer. */}
          <div className="tf-classroom-composer absolute inset-x-0 bottom-[3%] flex justify-center">
            <div className="relative w-[46%] min-w-[20rem] max-w-[42rem]">
              {isLecturePeekVisible && (
                <section
                  aria-label="刚发送的讲稿"
                  className="tf-classroom-peek absolute bottom-[calc(100%+0.5rem)] left-0 right-0 rounded-2xl border border-ink-200 bg-white/95 shadow-card backdrop-blur-sm"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-3 py-1.5">
                    <span className="text-xs font-semibold text-ink-700">
                      讲稿 · {lectureCharacterCount} 字
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
                    {session.lecture}
                  </p>
                </section>
              )}
              <ClassroomComposer
                autoFocus={session.phase === 'sent'}
                className="shadow-card"
                onChange={(value) => {
                  if (session.phase === 'sent') classroomSessionStore.setReply(value);
                  else classroomSessionStore.setLectureDraft(value);
                }}
                onSend={session.phase === 'sent' ? sendReply : sendLecture}
                value={session.phase === 'sent' ? session.reply : session.lectureDraft}
                variant={session.phase === 'sent' ? 'reply' : 'lecture'}
              />
            </div>
          </div>

          {!isMessagesOpen && (
            <button
              aria-controls="classroom-messages"
              aria-expanded={false}
              aria-label={`展开课堂消息（${session.messages.length} 条）`}
              className="absolute bottom-[3%] right-[2.5%] z-20 inline-flex size-11 items-center justify-center rounded-full border border-white/70 bg-white/80 text-ink-800 opacity-90 shadow-card backdrop-blur-md transition hover:bg-white hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              onClick={openMessages}
              type="button"
            >
              <ChatsCircle aria-hidden="true" className="size-5" />
              {session.messages.length > 0 && (
                <span className="absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-brand-700 px-1 text-[11px] font-semibold leading-5 text-white">
                  {session.messages.length}
                </span>
              )}
            </button>
          )}

          <aside
            aria-label="课堂消息"
            className={`absolute bottom-[3%] right-[2.5%] top-[12%] z-20 flex w-[23%] min-w-[16rem] max-w-[22rem] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/85 shadow-float backdrop-blur-xl transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
              isMessagesOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-3 opacity-0'
            }`}
            id="classroom-messages"
            inert={!isMessagesOpen}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-ink-200/70 px-3 py-2">
              <span className="text-xs font-semibold text-ink-700">
                课堂消息 · {session.messages.length}
              </span>
              {session.phase === 'sent' && (
                <button
                  className="ml-auto text-[11px] font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                  onClick={restartLecture}
                  type="button"
                >
                  重新讲解
                </button>
              )}
              <button
                aria-label="收起课堂消息"
                className={`${session.phase === 'sent' ? '' : 'ml-auto'} rounded-full p-1 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40`}
                onClick={() => setIsMessagesOpen(false)}
                type="button"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </header>
            <div
              className="tf-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
              ref={messageListRef}
            >
              {session.messages.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs leading-5 text-ink-500">
                  发送讲解后，讲稿与学生的提问会出现在这里。
                </p>
              ) : (
                session.messages.map((message) => (
                  <article
                    className={
                      message.role === 'teacher'
                        ? 'rounded-xl border-l-2 border-brand-500 bg-white/90 px-3 py-2'
                        : 'rounded-xl bg-ink-100/80 px-3 py-2'
                    }
                    key={message.id}
                  >
                    <span className="text-[11px] font-semibold text-ink-600">{message.label}</span>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-900">
                      {message.text}
                    </p>
                  </article>
                ))
              )}
            </div>
          </aside>

          {isEndDialogOpen && (
            <EndClassroomDialog
              hasUnsavedDraft={draftInProgress}
              onCancel={closeEndDialog}
              onConfirm={endClassroom}
            />
          )}
        </div>
      </div>
    </div>
  );
}
