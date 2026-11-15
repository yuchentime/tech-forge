import type { AgentActivitySnapshot } from './agent-event-bus';

/** Quiet window after streamed text before the waiting row returns, in milliseconds. */
export const TURN_PROGRESS_SILENCE_MS = 1_000;

/**
 * Decides whether the response area still needs a waiting row.
 *
 * `working` always needs one because no text has streamed yet. `responding` hides it while text
 * flows, but the model can then stay silent for a long time while it reasons or generates a large
 * tool call; the backend sends no visible frame for those phases, so the row must come back once
 * the turn has been quiet — otherwise only the stop button proves the run is alive.
 *
 * This is the accepted A option. The deferred B option (throttled, content-free backend phase
 * events) and its switch triggers are recorded in
 * docs/decisions/2026-11-15-chat-waiting-progress-signal.md.
 */
export function shouldShowTurnProgress(
  phase: AgentActivitySnapshot['phase'],
  lastEventAt: number,
  now: number,
): boolean {
  if (phase === 'working') return true;
  return phase === 'responding' && now - lastEventAt >= TURN_PROGRESS_SILENCE_MS;
}
