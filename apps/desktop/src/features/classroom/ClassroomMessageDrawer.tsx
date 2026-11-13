import { X } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import type { LessonMessageView } from './classroom-api';

/**
 * Overlay drawer for the classroom transcript.
 *
 * It covers rather than shrinks the stage, so the 16:9 artwork never changes size. Opening it or
 * receiving a message scrolls to the newest line.
 */
export function ClassroomMessageDrawer({
  open,
  messages,
  onClose,
}: {
  open: boolean;
  messages: readonly LessonMessageView[];
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [open, messages]);

  return (
    <aside
      aria-label="课堂消息"
      className={`absolute bottom-[3%] right-[2.5%] top-[12%] z-20 flex w-[23%] min-w-[16rem] max-w-[22rem] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/85 shadow-float backdrop-blur-xl transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${
        open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-3 opacity-0'
      }`}
      id="classroom-messages"
      inert={!open}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-ink-200/70 px-3 py-2">
        <span className="text-xs font-semibold text-ink-700">
          课堂消息 · {messages.length}
        </span>
        <button
          aria-label="收起课堂消息"
          className="ml-auto rounded-full p-1 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div
        className="tf-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
        ref={listRef}
      >
        {messages.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs leading-5 text-ink-500">
            发送讲解后，讲稿与学生的回应会出现在这里。
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
              <span className="text-[11px] font-semibold text-ink-600">{message.name}</span>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-900">
                {message.text}
              </p>
            </article>
          ))
        )}
      </div>
    </aside>
  );
}
