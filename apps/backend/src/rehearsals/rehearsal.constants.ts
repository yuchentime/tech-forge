/** Hard product limits for one rehearsal batch. */
export const MAX_TOTAL_QUESTIONS = 15;
export const MAX_FOLLOW_UPS = 2;
export const MAX_PERSONA_LENGTH = 1_000;
export const MAX_ANSWER_LENGTH = 5_000;
export const MIN_PLAN_POINTS = 3;
export const MAX_PLAN_POINTS = 8;

/** Local file that carries the student persona across conversations. */
export const PERSONA_FILE_NAME = 'rehearsal-persona.txt';

/** Model budget for one planning/decision/report call. */
export const GENERATE_TIMEOUT_MS = 90_000;

/** Model calls allowed for one structured result: the first call plus two repaired retries. */
export const MAX_GENERATE_ATTEMPTS = 3;

/** A stale row is reconciled only when its process-local run is gone and it has not moved for this long. */
export const RECONCILE_STALE_MS = 120_000;

/** Normal-chat digest bounds. */
export const DIGEST_REHEARSAL_LIMIT = 3;
export const DIGEST_MAX_CHARS = 6_000;
export const DIGEST_ANSWER_EXCERPT_CHARS = 200;
export const DIGEST_SUMMARY_CHARS = 200;

/** Rehearsal statuses that count as "active" for the one-per-conversation invariant. */
export const ACTIVE_REHEARSAL_STATUSES = [
  'preparing',
  'awaiting_answer',
  'evaluating',
  'preparing_next',
  'reporting',
] as const;

/** Statuses that end a rehearsal and therefore no longer block a new batch. */
export const TERMINAL_REHEARSAL_STATUSES = ['completed', 'failed'] as const;
