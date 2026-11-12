/**
 * Prompt markers owned by long-term memory.
 *
 * The header opens the per-turn memory block and is also the marker the snapshot cleaner looks
 * for; both sides must read it from here so a wording change cannot leave old blocks in the
 * Pi snapshot.
 */
export const MEMORY_CONTEXT_HEADER = '## 长期记忆';
