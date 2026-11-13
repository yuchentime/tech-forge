/**
 * Builds the flat searchable text for one rendered surface.
 *
 * Both keyword-search surfaces (chat messages and the artifact preview) are live DOM, so the text to
 * search is the concatenation of their text nodes. This module stays DOM-free on purpose: the
 * renderer feeds it small text pieces plus block boundaries, and gets back one string plus the
 * offsets needed to rebuild a DOM `Range` for every hit. Keeping it DOM-free means the offset maths
 * is testable with `node --test` against the compiled `dist-electron` output.
 */

/** Stands between block-level elements so a query can never match across two paragraphs. */
export const SEARCH_PART_SEPARATOR = '\u0001';

/** One text node's content, or the boundary between two blocks. */
export type SearchTextPart = { readonly text: string } | { readonly separator: true };

/** One text part's place inside {@link SearchTextIndex.text}. */
export interface SearchTextSpan {
  readonly part: number;
  readonly start: number;
  readonly length: number;
}

/** The concatenated text plus the offset bookkeeping needed to map hits back to text nodes. */
export interface SearchTextIndex {
  readonly text: string;
  /** Where each part starts in `text`; `null` marks a separator part. */
  readonly partStarts: readonly (number | null)[];
  /** Length of each text part; `0` for separators. */
  readonly partLengths: readonly number[];
  /** Text parts in document order; one entry per non-empty text part. */
  readonly spans: readonly SearchTextSpan[];
}

/** One literal occurrence of the query inside {@link SearchTextIndex.text}. */
export interface SearchMatch {
  readonly start: number;
  readonly end: number;
}

/** Which text parts hold a match's first and last characters. */
export interface SearchMatchLocation {
  readonly startPart: number;
  readonly startOffset: number;
  readonly endPart: number;
  readonly endOffset: number;
}

/** Joins the collected parts into one searchable string, recording where each part lands. */
export function buildSearchText(
  parts: readonly SearchTextPart[],
): SearchTextIndex {
  let text = '';
  const partStarts: (number | null)[] = [];
  const partLengths: number[] = [];
  const spans: SearchTextSpan[] = [];

  parts.forEach((part, partIndex) => {
    if ('separator' in part) {
      text += SEARCH_PART_SEPARATOR;
      partStarts.push(null);
      partLengths.push(0);
      return;
    }
    partStarts.push(text.length);
    partLengths.push(part.text.length);
    if (part.text.length > 0) {
      spans.push({ part: partIndex, start: text.length, length: part.text.length });
    }
    text += part.text;
  });

  return { text, partStarts, partLengths, spans };
}

/**
 * Finds every literal occurrence of `query`.
 *
 * The query is escaped, so `.` or `*` search for themselves. Matching is case-insensitive by
 * default; a whitespace-only query matches nothing so an empty search box never paints the whole
 * document.
 */
export function findSearchMatches(
  index: SearchTextIndex,
  query: string,
  options: { readonly caseSensitive?: boolean } = {},
): readonly SearchMatch[] {
  const needle = query.trim();
  if (needle === '' || needle.includes(SEARCH_PART_SEPARATOR)) return [];

  const flags = options.caseSensitive === true ? 'gu' : 'giu';
  const pattern = new RegExp(escapeRegExp(needle), flags);
  const matches: SearchMatch[] = [];
  for (const match of index.text.matchAll(pattern)) {
    const start = match.index ?? 0;
    matches.push({ start, end: start + match[0].length });
  }
  return matches;
}

/**
 * Maps one match onto the text parts holding its ends.
 *
 * A hit can start in one text node and end in another (bold text, inline code), which is exactly why
 * matching runs over the concatenated text instead of per node.
 */
export function locateSearchMatch(
  index: SearchTextIndex,
  match: SearchMatch,
): SearchMatchLocation | null {
  const startSpan = findSpanAt(index.spans, match.start, 'start');
  const endSpan = findSpanAt(index.spans, match.end, 'end');
  if (!startSpan || !endSpan) return null;

  return {
    startPart: startSpan.part,
    startOffset: match.start - startSpan.start,
    endPart: endSpan.part,
    endOffset: Math.min(match.end - endSpan.start, endSpan.length),
  };
}

/**
 * Finds the span that owns one offset.
 *
 * `start` picks the span the offset falls in, `end` picks the span whose last character is before
 * the offset, so a match ending exactly on a text-node boundary stays pinned to that node.
 */
function findSpanAt(
  spans: readonly SearchTextSpan[],
  offset: number,
  side: 'start' | 'end',
): SearchTextSpan | null {
  let low = 0;
  let high = spans.length - 1;
  let found: SearchTextSpan | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle];
    if (side === 'start' ? span.start <= offset : span.start < offset) {
      found = span;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

/** Escapes every regular-expression metacharacter so the query is matched literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
