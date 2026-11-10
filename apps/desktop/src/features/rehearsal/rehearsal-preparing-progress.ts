/** Estimated wall-clock time for one start; only paces the bar, never claims completion. */
export const PREPARING_ESTIMATE_MS = 20_000;

/** The estimate never fills the bar; the last 10% belongs to the real completion. */
export const PREPARING_TIME_CAP = 90;

/** Time constant tuned so the bar passes ~57% at 8s and ~83% at the 20s estimate. */
const PREPARING_TAU_MS = PREPARING_ESTIMATE_MS / 2.5;

/**
 * Returns the estimated progress for an elapsed wait.
 *
 * It is a pacing hint, not a real percentage: it rises quickly at first, flattens asymptotically,
 * and stops at the cap so an unfinished start never looks complete. The phase copy next to it
 * still comes from the backend; only the bar's position is estimated.
 */
export function estimatePreparingPercent(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return PREPARING_TIME_CAP * (1 - Math.exp(-elapsedMs / PREPARING_TAU_MS));
}
