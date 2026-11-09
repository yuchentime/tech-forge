import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * Rewrites the last user message in a snapshot so it keeps only the user's own text.
 *
 * Each turn may prepend attachment text and knowledge chunks to the message sent to the model. That
 * text belongs to one request, but the Pi session stores it as a user entry, and the snapshot is what
 * the next request restores from — leaving it there would replay the whole document every turn. Only
 * `message.content` is replaced; ids, parent links and timestamps stay untouched so the restored
 * entry tree is unchanged.
 */
export function replaceInjectedUserText(
  entries: readonly SessionEntry[],
  prompt: string,
): SessionEntry[] {
  const cleaned = [...entries];

  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    const entry = cleaned[index];
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    // A non-string content means the message was never composed by us; leave it alone.
    if (typeof entry.message.content !== 'string') return cleaned;
    if (entry.message.content === prompt) return cleaned;

    cleaned[index] = {
      ...entry,
      message: { ...entry.message, content: prompt },
    };
    return cleaned;
  }

  return cleaned;
}
