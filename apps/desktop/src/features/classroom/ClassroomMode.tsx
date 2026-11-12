import { ArrowLeft, Chalkboard, ChatsCircle, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import classroomBackground from '../../assets/classroom/bg-classroom.png';
import { ClassroomComposer } from './ClassroomComposer';
import { hasDesktopBridge } from '../../types/desktop-bridge';

/**
 * The student question shown once the teacher sends a lecture.
 *
 * Hardcoded for the MVP: the classroom state machine (lecture → student turns → report) does not
 * exist yet, so the bubble only proves the layout and the transition. Replacing it with generated
 * questions is the next step.
 */
const STUDENT_QUESTION = {
  name: '小满',
  text: '老师，缓存雪崩到底是从哪一步开始崩的？',
};

/** How long the sent lecture stays above the composer before it fades into the message sidebar. */
const LECTURE_PEEK_MS = 3600;

type ClassroomPhase = 'composing' | 'sent';

type ClassroomMessage = {
  id: string;
  role: 'teacher' | 'student';
  label: string;
  text: string;
};

/**
 * Renders the immersive classroom stage and owns the window's 16:9 mode.
 *
 * The artwork is exactly 16:9, so the main process locks the OS window to that ratio while this
 * view is mounted and `.tf-classroom-stage` keeps the stage at 16:9 even where the window cannot be
 * locked (browser preview, a maximized window). The stage replaces the sidebar and header, so it
 * carries its own exit control; `Esc` closes the message sidebar first, then leaves.
 *
 * MVP flow, all local state:
 * 1. `composing` — the tall four-line box writes the lecture.
 * 2. send — the lecture floats above the box for a few seconds, the box collapses to one line, one
 *    student's question bubble appears, and both messages land in the sidebar behind a badge.
 * 3. answering — each answer is appended to the sidebar and dismisses the question bubble;
 *    "重新讲解" starts over.
 *
 * Nothing here reaches the conversation yet: sending is local until the classroom flow is wired to
 * the Agent thread.
 */
export function ClassroomMode({ onExit }: { onExit: () => void }) {
  const [phase, setPhase] = useState<ClassroomPhase>('composing');
  const [lectureDraft, setLectureDraft] = useState('');
  const [lecture, setLecture] = useState('');
  const [reply, setReply] = useState('');
  const [isQuestionVisible, setIsQuestionVisible] = useState(false);
  const [messages, setMessages] = useState<ClassroomMessage[]>([]);
  const [isMessagesOpen, setIsMessagesOpen] = useState(false);
  const [isLecturePeekVisible, setIsLecturePeekVisible] = useState(false);
  const messageSequence = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const peekTimerRef = useRef<number | null>(null);

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
  }, [isMessagesOpen, messages]);

  /**
   * Leaves the mode from the keyboard, since the sidebar's entries are not on screen.
   *
   * The sidebar closes first; inside the composer `Esc` does nothing, so a half-written message is
   * never thrown away by a stray key.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
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
  }, [isMessagesOpen, onExit]);

  const nextMessageId = (): string => `classroom-message-${(messageSequence.current += 1)}`;

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
    const text = lectureDraft.trim();
    if (!text) return;
    setLecture(text);
    setLectureDraft('');
    setPhase('sent');
    setIsQuestionVisible(true);
    setMessages([
      { id: nextMessageId(), role: 'teacher', label: '老师 · 讲稿', text },
      { id: nextMessageId(), role: 'student', label: STUDENT_QUESTION.name, text: STUDENT_QUESTION.text },
    ]);
    showLecturePeek();
  };

  /** MVP: the answer joins the sidebar and marks the question as handled; no model call yet. */
  const sendReply = (): void => {
    const text = reply.trim();
    if (!text) return;
    setMessages((previous) => [
      ...previous,
      { id: nextMessageId(), role: 'teacher', label: '老师', text },
    ]);
    setReply('');
    setIsQuestionVisible(false);
  };

  /** Clears the round so the layout can be rehearsed again without leaving the mode. */
  const restartLecture = (): void => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    setPhase('composing');
    setLecture('');
    setLectureDraft('');
    setReply('');
    setIsQuestionVisible(false);
    setIsLecturePeekVisible(false);
    setMessages([]);
    setIsMessagesOpen(false);
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

  const lectureCharacterCount = Array.from(lecture).length;

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
          <div className="tf-classroom-overlay absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 md:p-5">
            <button
              autoFocus
              className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 py-2 pl-3 pr-4 text-sm font-medium text-ink-800 shadow-card backdrop-blur-md transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              onClick={onExit}
              type="button"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              退出课堂模式
            </button>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/60 bg-white/70 px-3 py-1.5 text-xs font-semibold text-brand-800 backdrop-blur-md">
              <Chalkboard aria-hidden="true" className="size-3.5" />
              课堂模式
            </span>
          </div>

          {isQuestionVisible && (
            <div
              aria-live="polite"
              className="tf-classroom-bubble absolute bottom-[64%] left-1/2 flex w-[38%] max-w-[30rem] -translate-x-1/2 flex-col gap-1 rounded-2xl border border-white/70 bg-white/90 px-4 py-3 text-left shadow-card backdrop-blur-md"
            >
              <span className="text-xs font-semibold text-brand-700">{STUDENT_QUESTION.name}</span>
              <p className="text-sm leading-6 text-ink-900">{STUDENT_QUESTION.text}</p>
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
                    {lecture}
                  </p>
                </section>
              )}
              <ClassroomComposer
                autoFocus={phase === 'sent'}
                className="shadow-card"
                onChange={phase === 'sent' ? setReply : setLectureDraft}
                onSend={phase === 'sent' ? sendReply : sendLecture}
                value={phase === 'sent' ? reply : lectureDraft}
                variant={phase === 'sent' ? 'reply' : 'lecture'}
              />
            </div>
          </div>

          {!isMessagesOpen && (
            <button
              aria-controls="classroom-messages"
              aria-expanded={false}
              aria-label={`展开课堂消息（${messages.length} 条）`}
              className="absolute bottom-[3%] right-[2.5%] z-20 inline-flex size-12 items-center justify-center rounded-full border border-white/70 bg-white/80 text-ink-800 shadow-card backdrop-blur-md transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
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

          <aside
            aria-label="课堂消息"
            className={`absolute bottom-[3%] right-[2.5%] top-[12%] z-20 flex w-[23%] min-w-[16rem] max-w-[22rem] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/85 shadow-float backdrop-blur-xl transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
              isMessagesOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-3 opacity-0'
            }`}
            id="classroom-messages"
            inert={!isMessagesOpen}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-ink-200/70 px-3 py-2">
              <span className="text-xs font-semibold text-ink-700">课堂消息 · {messages.length}</span>
              {phase === 'sent' && (
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
                className={`${phase === 'sent' ? '' : 'ml-auto'} rounded-full p-1 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40`}
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
              {messages.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs leading-5 text-ink-500">
                  发送讲解后，讲稿与学生的提问会出现在这里。
                </p>
              ) : (
                messages.map((message) => (
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

        </div>
      </div>
    </div>
  );
}
