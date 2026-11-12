/** Minimal message shape needed to decide whether normal chat has a completed round. */
export interface ConversationRoundMessage {
  role: string;
  status?: { type?: string };
}

/**
 * Explains why drills are unavailable; shared by the mode toggle and the drill start card so the
 * disabled control and the in-view notice never disagree.
 */
export const REHEARSAL_REQUIRES_ROUND_HINT =
  '先进行一轮对话模式，演练会基于当前学习内容出题。';

/**
 * A drill starts from a completed normal-chat round, not merely from a non-empty thread.
 *
 * The backend also validates a completed user + assistant pair; this guard keeps the button
 * disabled while the first answer is still streaming, failed, or cancelled.
 */
export function hasCompletedConversationRound(
  messages: readonly ConversationRoundMessage[],
): boolean {
  let hasUser = false;
  for (const message of messages) {
    if (message.role === 'user') {
      hasUser = true;
      continue;
    }
    if (
      hasUser &&
      message.role === 'assistant' &&
      message.status?.type === 'complete'
    ) {
      return true;
    }
  }
  return false;
}
