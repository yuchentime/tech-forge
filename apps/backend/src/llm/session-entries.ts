import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { MEMORY_CONTEXT_HEADER } from '../memory/memory-context';

/** Reports what one snapshot check had to change before Pi could replay it. */
export interface SessionEntryCheck {
  entries: SessionEntry[];
  /** `toolResult` messages dropped because no assistant message declared their call. */
  removedToolResults: number;
  /** `toolCall` blocks stripped because their result was never recorded. */
  strippedToolCalls: number;
  /** Entries re-parented onto the previous entry after a removal. */
  relinkedEntries: number;
}

/**
 * Returns the entries to restore, after dropping tool-call pairs a provider would reject.
 *
 * Pi replays restored entries verbatim and OpenAI-compatible endpoints validate the pairing: a
 * `tool` message must answer a preceding `tool_calls`, and every `tool_calls` must be answered.
 * A turn interrupted between the assistant message and its results leaves an orphan `toolResult`
 * (its `toolCall` was stripped as unfinished) or a `toolCall` with no result. Because those entries
 * are saved into the snapshot, one broken pair fails every later request in the conversation with
 * a 400 instead of failing the turn that broke.
 *
 * Orphan results are dropped; a call without a result is stripped from its assistant message while
 * the assistant text stays, the same treatment `recoverInterruptedPiMessage()` gives SQLite rows.
 * A `parentId` that pointed at a dropped entry follows the previous entry: the model context is
 * the leaf path, so a dangling link would silently drop every entry before it.
 */
export function checkSessionEntries(
  entries: readonly SessionEntry[],
): SessionEntryCheck {
  const declared = new Set<string>();
  const answered = new Set<string>();
  const checked: SessionEntry[] = [];
  let removedToolResults = 0;

  for (const entry of entries) {
    if (entry.type !== 'message') {
      checked.push(entry);
      continue;
    }
    const message = entry.message;
    if (message.role === 'toolResult') {
      if (!declared.has(message.toolCallId)) {
        removedToolResults += 1;
        continue;
      }
      answered.add(message.toolCallId);
      checked.push(entry);
      continue;
    }
    checked.push(entry);
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall') declared.add(block.id);
    }
  }

  let strippedToolCalls = 0;
  for (let index = 0; index < checked.length; index += 1) {
    const entry = checked[index];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const unanswered = entry.message.content.flatMap((block) =>
      block.type === 'toolCall' && !answered.has(block.id) ? [block.id] : [],
    );
    if (unanswered.length === 0) continue;
    const stripped = new Set(unanswered);
    strippedToolCalls += unanswered.length;
    checked[index] = {
      ...entry,
      message: {
        ...entry.message,
        content: entry.message.content.filter(
          (block) => block.type !== 'toolCall' || !stripped.has(block.id),
        ),
      },
    };
  }

  const keptIds = new Set(checked.map((entry) => entry.id));
  let relinkedEntries = 0;
  let previousId: string | null = null;
  for (const entry of checked) {
    if (entry.parentId !== null && !keptIds.has(entry.parentId)) {
      entry.parentId = previousId;
      relinkedEntries += 1;
    }
    previousId = entry.id;
  }

  return {
    entries: checked,
    removedToolResults,
    strippedToolCalls,
    relinkedEntries,
  };
}

/**
 * Rewrites user entries in a snapshot so they keep only the user's own text.
 *
 * Each turn may prepend attachment text, knowledge chunks, rehearsal digests and inline images to
 * the message sent to the model. That material belongs to one request, but Pi stores it in the user
 * entry, and the snapshot is what the next request restores from — leaving it there would replay the
 * document or image every turn. `userTextById` maps historical user row ids to their clean stored
 * text; the last user entry falls back to the current prompt. Only `message.content` is replaced;
 * ids, parent links and timestamps stay untouched so the restored entry tree is unchanged.
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
    const content = entry.message.content;
    const currentText = contentToText(content);
    const replacement =
      userTextById.get(entry.id) ??
      (index === lastUserIndex
        ? prompt
        : currentText
          ? stripInjectedText(currentText)
          : undefined);
    const hasImages = containsImageBlock(content);
    if (replacement === undefined && !hasImages) continue;
    const nextText = replacement ?? currentText ?? '';
    if (!hasImages && currentText === nextText) continue;

    cleaned[index] = {
      ...entry,
      message: {
        ...entry.message,
        content: replaceContent(content, nextText),
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

/** Reads the text part of either content shape Pi may store, ignoring image blocks. */
function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (!content.every((block) => isTextBlock(block) || isImageBlock(block))) {
    return undefined;
  }
  const text = content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n');
  return text.length > 0 ? text : undefined;
}

/** Reports whether a content value carries inline image input. */
function containsImageBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some(isImageBlock);
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
    MEMORY_CONTEXT_HEADER,
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

/** Narrows one Pi content block to inline image input. */
function isImageBlock(value: unknown): value is { type: 'image' } {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'image'
  );
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
