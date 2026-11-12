import { ArrowLeft, Chalkboard } from '@phosphor-icons/react';
import { useEffect } from 'react';
import classroomBackground from '../../assets/classroom/bg-classroom.png';
import { ClassroomComposer } from './ClassroomComposer';
import { hasDesktopBridge } from '../../types/desktop-bridge';

/**
 * Renders the immersive classroom stage and owns the window's 16:9 mode.
 *
 * The artwork is exactly 16:9, so the main process locks the OS window to that ratio while this
 * view is mounted and `.tf-classroom-stage` keeps the stage at 16:9 even where the window cannot be
 * locked (browser preview, a maximized window). The stage replaces the sidebar and header, so it
 * carries its own exit control; `Esc` leaves as well, except while the composer has focus.
 *
 * The composer only borrows the conversation composer's card styling: classroom turns carry no
 * attachments and no slash commands. It writes to the active conversation, so a message sent here
 * is the one that appears in the chat after leaving.
 */
export function ClassroomMode({ onExit }: { onExit: () => void }) {
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

  /**
   * Leaves the mode from the keyboard, since the sidebar's entries are not on screen.
   *
   * `Esc` inside the composer dismisses the slash menu; leaving the mode there would throw away a
   * half-written message, so the shortcut only applies outside the composer.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.tf-classroom-composer')) return;
      onExit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExit]);

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
          {/* Sits on the front desk of the artwork: centred and lifted by one soft shadow so the
              white card separates from the warm desk without a border. */}
          <div className="tf-classroom-composer absolute inset-x-0 bottom-[3%] flex justify-center">
            <ClassroomComposer className="w-[46%] min-w-[20rem] max-w-[42rem] shadow-card" />
          </div>
        </div>
      </div>
    </div>
  );
}
