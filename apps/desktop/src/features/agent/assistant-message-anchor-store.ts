/**
 * Maps the reply ids assistant-ui generates to the persisted assistant rows behind them.
 *
 * assistant-ui renders every streamed turn under its own short message id, while 重点关注 and
 * history navigation address SQLite rows. The backend publishes the rows a turn wrote when the
 * run settles, so the page can translate the id it finds in the DOM before saving an excerpt.
 */
class AssistantMessageAnchorStore {
  /** Only recent live turns can still be highlighted, so the map must not grow with the session. */
  private static readonly MAX_ENTRIES = 200;
  private readonly byRuntimeMessageId = new Map<string, readonly string[]>();

  /** Records the assistant rows one finished turn produced, in backend order. */
  record(runtimeMessageId: string, messageIds: readonly string[]): void {
    if (!runtimeMessageId || messageIds.length === 0) return;
    this.byRuntimeMessageId.delete(runtimeMessageId);
    this.byRuntimeMessageId.set(runtimeMessageId, [...messageIds]);
    while (
      this.byRuntimeMessageId.size >
      AssistantMessageAnchorStore.MAX_ENTRIES
    ) {
      const oldest = this.byRuntimeMessageId.keys().next();
      if (oldest.done) break;
      this.byRuntimeMessageId.delete(oldest.value);
    }
  }

  /**
   * Returns the persisted anchor for a rendered reply.
   *
   * The rendered bubble merges every assistant row of its turn, so the last row — the visible
   * final answer — is the one scroll-to-message should land on.
   */
  resolve(runtimeMessageId: string): string | null {
    const messageIds = this.byRuntimeMessageId.get(runtimeMessageId);
    return messageIds?.[messageIds.length - 1] ?? null;
  }
}

/** Shared anchor map, written by the stream adapter and read by the chat page. */
export const assistantMessageAnchorStore = new AssistantMessageAnchorStore();
