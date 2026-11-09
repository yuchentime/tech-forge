import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/**
 * Rewrites user entries in a snapshot so they keep only the user's own text.
 *
 * Each turn may prepend attachment text, knowledge chunks and rehearsal digests to the message sent
 * to the model. That material belongs to one request, but Pi stores it in the user entry, and the
 * snapshot is what the next request restores from — leaving it there would replay the document every
 * turn. `userTextById` maps historical user row ids to their clean stored text; the last user entry
 * falls back to the current prompt. Only `message.content` is replaced; ids, parent links and
 * timestamps stay untouched so the restored entry tree is unchanged.
 */
export function replaceInjectedUserText(
  entries: readonly SessionEntry[],
  prompt: string,
  userTextById: ReadonlyMap<string, string> = new Map(),
): SessionEntry[] {
  const cleaned = [...entries];
  const lastUserIndex = findLastUserEntryIndex(cleaned);

  for (let index = 0; index < cleaned.length; index += 1) {
    const entry = cleaned[index];
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const currentText = contentToText(entry.message.content);
    const replacement =
      userTextById.get(entry.id) ??
      (index === lastUserIndex
        ? prompt
        : currentText
          ? stripInjectedText(currentText)
          : undefined);
    if (replacement === undefined) continue;
    if (contentToText(entry.message.content) === replacement) continue;

    cleaned[index] = {
      ...entry,
      message: {
        ...entry.message,
        content: replaceContent(entry.message.content, replacement),
      },
    };
  }

  return cleaned;
}

/** Finds the last real user message, skipping Pi-only entries such as compaction. */
function findLastUserEntryIndex(entries: readonly SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === 'message' && entry.message.role === 'user') {
      return index;
    }
  }
  return -1;
}

/** Reads text from either the string or text-block content shape Pi may store. */
function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(isTextBlock)) {
    return content.map((block) => block.text).join('\n');
  }
  return undefined;
}

/**
 * Strips a known per-turn context block from a historical user entry.
 *
 * Pi assigns its own ids to prompted messages, so older injected entries cannot always be matched
 * back to a SQLite row. The visible headers are code-owned markers; the last `## 用户输入` delimiter
 * separates the injected material from the user's own text.
 */
function stripInjectedText(text: string): string | undefined {
  const injectedHeaders = [
    '## 此前的演练记录',
    '## 本轮用户附加的文件',
    '## 资料库检索结果',
    '## 本会话可读取的附件',
  ];
  if (!injectedHeaders.some((header) => text.startsWith(header))) {
    return undefined;
  }
  const delimiter = '## 用户输入\n';
  const index = text.indexOf(delimiter);
  return index >= 0 ? text.slice(index + delimiter.length) : undefined;
}

/** Narrows one Pi content block to the text shape this module can rewrite. */
function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  if (!value || typeof value !== 'object') return false;
  if (!('type' in value) || value.type !== 'text') return false;
  if (!('text' in value) || typeof value.text !== 'string') return false;
  return true;
}

/** Replaces injected content while preserving the shape the snapshot already used. */
function replaceContent(
  content: unknown,
  replacement: string,
): string | Array<{ type: 'text'; text: string }> {
  return typeof content === 'string'
    ? replacement
    : [{ type: 'text', text: replacement }];
}
