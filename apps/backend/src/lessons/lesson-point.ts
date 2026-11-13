import type { LessonMessage } from './lesson.types';
import { truncateChars } from './transcript-format';

/** How many student turns one knowledge point may have before it must close. */
export const MAX_POINT_STUDENT_TURNS = 2;

/** Persisted knowledge-point state for one lesson. */
export interface LessonPointState {
  /** First teacher message of the point; null before the first point. */
  startMessageId: string | null;
  label: string | null;
  /** True once the cap was reached; later turns only acknowledge. */
  closed: boolean;
}

/** The director's judgement for one turn. */
export interface PointDecision {
  mode: 'new' | 'continue';
  /** Label for a new point; ignored for `continue`. */
  pointLabel: string | null;
}

/** Resolved state for the upcoming student turn. */
export interface ResolvedPointTurn {
  state: LessonPointState;
  /** Student turns already spent on this point (before this turn). */
  turns: number;
  /** The student must acknowledge, not ask. */
  forceClose: boolean;
  /** True when this turn starts a new point. */
  started: boolean;
}

/** Counts student messages after the point's first teacher message. */
export function countPointTurns(
  messages: readonly LessonMessage[],
  startMessageId: string | null,
): number {
  if (!startMessageId) return 0;
  const index = messages.findIndex((message) => message.id === startMessageId);
  if (index < 0) return 0;
  return messages
    .slice(index + 1)
    .filter((message) => message.speaker !== 'teacher').length;
}

/**
 * Resolves the active point for one teacher message.
 *
 * A point starts on the director's `new` decision, when no point exists yet, or when the stored
 * start message is no longer in the transcript (corrupt or repaired). Turns are derived from the
 * transcript instead of a counter, so a crash between the message append and the state write can
 * only under-count, never over-count.
 */
export function resolvePointTurn(input: {
  state: LessonPointState;
  messages: readonly LessonMessage[];
  teacherMessage: LessonMessage;
  decision: PointDecision;
  maxTurns?: number;
}): ResolvedPointTurn {
  const maxTurns = input.maxTurns ?? MAX_POINT_STUDENT_TURNS;
  const startIndex = input.state.startMessageId
    ? input.messages.findIndex(
        (message) => message.id === input.state.startMessageId,
      )
    : -1;

  if (input.decision.mode === 'new' || startIndex < 0) {
    const label =
      normalizeLabel(input.decision.pointLabel) ??
      normalizeLabel(input.teacherMessage.text);
    return {
      state: {
        startMessageId: input.teacherMessage.id,
        label,
        closed: false,
      },
      turns: 0,
      forceClose: false,
      started: true,
    };
  }

  const turns = countPointTurns(
    input.messages,
    input.state.startMessageId,
  );
  return {
    state: input.state,
    turns,
    forceClose: input.state.closed || turns >= maxTurns,
    started: false,
  };
}

/** Trims, collapses whitespace and clips a point label. */
function normalizeLabel(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return truncateChars(trimmed, 40);
}
