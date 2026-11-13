import {
  CLASSROOM_STUDENT_IDS,
  isClassroomStudentId,
  type ClassroomStudentId,
} from './classroom-students';
import type { LessonMessage } from './lesson.types';
import { truncateChars } from './transcript-format';

/** Hard cap on student turns per knowledge point; the director decides the normal exit earlier. */
export const MAX_POINT_TURNS = 5;

/** Persisted status bar for the knowledge point being discussed. */
export interface LessonPointState {
  /** First message of the point; null before the first point. */
  startMessageId: string | null;
  label: string | null;
}

/** The director's judgement for one turn. */
export interface PointDecision {
  /** Current point label; a different value starts a new point. */
  pointLabel: string | null;
  /** Whether the discussion is sufficient for this knowledge point. */
  done: boolean;
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

/** Counts each student's messages after the point's first message. */
export function countPointTurnsByStudent(
  messages: readonly LessonMessage[],
  startMessageId: string | null,
): Record<ClassroomStudentId, number> {
  const counts = Object.fromEntries(
    CLASSROOM_STUDENT_IDS.map((id) => [id, 0]),
  ) as Record<ClassroomStudentId, number>;
  if (!startMessageId) return counts;
  const index = messages.findIndex((message) => message.id === startMessageId);
  if (index < 0) return counts;
  for (const message of messages.slice(index + 1)) {
    if (message.speaker === 'teacher') continue;
    counts[message.speaker] += 1;
  }
  return counts;
}

/**
 * Picks the student who opens the next knowledge point.
 *
 * The director's nomination is semantic (persona fit) and used when valid. Code only validates it
 * and falls back to the student with the fewest turns on the closed point, then random.
 */
export function selectNextQuestioner(input: {
  directorChoice: unknown;
  closer: ClassroomStudentId;
  counts: Record<ClassroomStudentId, number>;
  random?: () => number;
}): ClassroomStudentId {
  const candidates = CLASSROOM_STUDENT_IDS.filter(
    (id) => id !== input.closer,
  );
  if (
    isClassroomStudentId(input.directorChoice) &&
    input.directorChoice !== input.closer
  ) {
    return input.directorChoice;
  }
  const minTurns = Math.min(
    ...candidates.map((id) => input.counts[id] ?? 0),
  );
  const pool = candidates.filter(
    (id) => (input.counts[id] ?? 0) === minTurns,
  );
  if (pool.length === 0) return candidates[0] ?? input.closer;
  const random = input.random ?? Math.random;
  const index = Math.min(
    pool.length - 1,
    Math.floor(random() * pool.length),
  );
  return pool[index] ?? pool[0]!;
}

/** Counts student messages after the point's first message. */
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
 * The director owns the semantic decision (`done`); code only enforces the hard cap and the
 * label-based boundary. A different label starts a new point, which resets the derived turn count.
 */
export function resolvePointTurn(input: {
  state: LessonPointState;
  messages: readonly LessonMessage[];
  teacherMessage: LessonMessage;
  decision: PointDecision;
  maxTurns?: number;
}): ResolvedPointTurn {
  const maxTurns = input.maxTurns ?? MAX_POINT_TURNS;
  const requestedLabel = normalizePointLabel(input.decision.pointLabel);
  const startIndex = input.state.startMessageId
    ? input.messages.findIndex(
        (message) => message.id === input.state.startMessageId,
      )
    : -1;
  const started =
    startIndex < 0 ||
    (requestedLabel !== null && requestedLabel !== input.state.label);

  if (started) {
    const label =
      requestedLabel ?? normalizePointLabel(input.teacherMessage.text);
    return {
      state: {
        startMessageId: input.teacherMessage.id,
        label,
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
    // A new point is never closed on its first message; the director's done only applies to a
    // continuing point, and the cap is a hard backstop.
    forceClose: input.decision.done || turns >= maxTurns,
    started: false,
  };
}

/** Trims, collapses whitespace and clips a point label. */
export function normalizePointLabel(
  text: string | null | undefined,
): string | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return truncateChars(trimmed, 40);
}
