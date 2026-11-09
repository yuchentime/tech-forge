import type { ParsedPage, ParseWarning } from '../../platform/document-parser/document-parser.types';

/** Target chunk size in sub-word tokens, matching the embedding model's 512-token limit. */
export const CHUNK_TARGET_TOKENS = 500;
/** Hard ceiling: 500 content tokens + 2 special tokens stays inside the model's 512-token window. */
export const CHUNK_MAX_TOKENS = 500;
/** 10% of the target, repeated from the previous chunk so split sentences stay readable. */
export const CHUNK_OVERLAP_TOKENS = 50;
/** Guard against pathological inputs producing an unusable index. */
export const MAX_CHUNKS_PER_DOCUMENT = 5000;
/** How far back the overlap search may look, in characters, for 50 tokens. */
const OVERLAP_SEARCH_CHARS = 400;

/** Where a chunk came from: heading trail, page span, character offsets and token length. */
export interface ChunkLocator {
  headingPath: string[];
  pageStart?: number;
  pageEnd?: number;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

/** One persisted unit produced by chunking a parsed document. */
export interface DocumentChunk {
  sequenceNo: number;
  content: string;
  locator: ChunkLocator;
}

/** Chunking inputs; `countTokens` must be the embedding model's tokenizer. */
export interface ChunkDocumentInput {
  pages: ParsedPage[];
  warnings?: ParseWarning[];
  /** Only Markdown carries reliable heading syntax; plain text (PDF) must not treat '# …' as a heading. */
  format?: 'markdown' | 'plain_text';
  countTokens: (text: string) => number;
}

/** Thrown when one document would exceed the per-document chunk budget. */
export class DocumentChunkLimitError extends Error {
  readonly code = 'DOCUMENT_TOO_LARGE_FOR_INDEX';

  constructor(readonly chunkCount: number) {
    super(`文档需要 ${chunkCount} 个分片，超过 ${MAX_CHUNKS_PER_DOCUMENT} 的限制`);
    this.name = 'DocumentChunkLimitError';
  }
}

/** A half-open character range in the concatenated parsed text. */
interface Range {
  start: number;
  end: number;
}

/** Maps concatenated-text offsets back to source page numbers. */
interface PageRange extends Range {
  pageNo: number;
}

/** One chunk under construction. */
interface Accumulator extends Range {
  headingPath: string[];
  tokens: number;
}

/**
 * Concatenates parsed pages exactly as the chunker indexes them.
 *
 * Exported so retained Markdown copies share one assembly rule: `locator.charStart/charEnd` are
 * offsets into this string, and a second join implementation would silently invalidate them.
 */
export function joinParsedPages(pages: ParsedPage[]): string {
  return pages.map((page) => page.text).join('\n\n');
}

/** Builds the searchable text and the page offset table used for locators. */
function buildSource(pages: ParsedPage[]): { text: string; pageRanges: PageRange[] } {
  let text = '';
  const pageRanges: PageRange[] = [];
  pages.forEach((page, index) => {
    if (index > 0) text += '\n\n';
    const start = text.length;
    text += page.text;
    pageRanges.push({ pageNo: page.pageNo, start, end: text.length });
  });
  return { text, pageRanges };
}

/** Returns the page number containing one offset; offsets past the end stay on the last page. */
function pageAt(pageRanges: PageRange[], offset: number): number | undefined {
  for (const range of pageRanges) {
    if (offset >= range.start && offset <= range.end) return range.pageNo;
  }
  const last = pageRanges[pageRanges.length - 1];
  return last && offset > last.end ? last.pageNo : pageRanges[0]?.pageNo;
}

/** Splits the concatenated text into paragraph blocks on blank lines, trimmed of edge whitespace. */
function splitBlocks(text: string): Range[] {
  const blocks: Range[] = [];
  const separator = /\n{2,}/g;
  const push = (from: number, to: number): void => {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end > start) blocks.push({ start, end });
  };
  let cursor = 0;
  let match = separator.exec(text);
  while (match) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
    match = separator.exec(text);
  }
  push(cursor, text.length);
  return blocks;
}

/** Finds the largest character cut whose token count stays within `limit`. */
function largestCut(
  text: string,
  from: number,
  to: number,
  limit: number,
  countTokens: (text: string) => number,
): number {
  let low = from + 1;
  let high = to;
  let best = from + 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (countTokens(text.slice(from, middle)) <= limit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** Splits an oversized block into token-sized pieces, preferring sentence boundaries. */
function splitOversizedBlock(
  text: string,
  block: Range,
  countTokens: (text: string) => number,
): Range[] {
  const sentenceEnd = /[。！？!?；;]/;
  const parts: Range[] = [];
  let start = block.start;
  while (countTokens(text.slice(start, block.end)) > CHUNK_MAX_TOKENS) {
    let cut = largestCut(text, start, block.end, CHUNK_MAX_TOKENS, countTokens);
    // Prefer the last sentence end inside the allowed window, but never return to the start.
    for (let index = cut - 1; index > start + Math.floor((cut - start) / 2); index -= 1) {
      if (sentenceEnd.test(text[index] ?? '')) {
        cut = index + 1;
        break;
      }
    }
    parts.push({ start, end: cut });
    start = cut;
  }
  if (block.end > start) parts.push({ start, end: block.end });
  return parts;
}

/** Computes the heading trail for a block, rebuilding it from Markdown heading levels. */
function headingTrail(blockText: string, current: string[]): string[] | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(blockText.split('\n')[0] ?? '');
  if (!match) return null;
  const level = match[1].length;
  return [...current.slice(0, level - 1), match[2].trim()];
}

/** Finds the earliest offset whose tail up to `end` carries at most CHUNK_OVERLAP_TOKENS tokens. */
function overlapStart(
  text: string,
  end: number,
  previousStart: number,
  countTokens: (text: string) => number,
): number {
  const lowest = Math.max(previousStart, end - OVERLAP_SEARCH_CHARS, 0);
  let low = lowest;
  let high = end;
  let best = end;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (countTokens(text.slice(middle, end)) <= CHUNK_OVERLAP_TOKENS) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

/**
 * Splits a parsed document into persisted chunks measured in embedding tokens.
 *
 * Invariant: `chunk.content === text.slice(charStart, charEnd)` of the concatenated parsed text, and
 * `locator.tokenCount` equals the tokenizer's count for that slice, so a citation can be re-checked
 * against the source without re-running the chunker.
 */
export function chunkDocument(input: ChunkDocumentInput): DocumentChunk[] {
  const { countTokens } = input;
  const skippedPages = new Set(
    (input.warnings ?? [])
      .filter((warning) => warning.code === 'TOC_LIKE' && typeof warning.pageNo === 'number')
      .map((warning) => warning.pageNo as number),
  );
  const { text, pageRanges } = buildSource(input.pages);

  const blocks = splitBlocks(text)
    .filter((block) => {
      const pageNo = pageAt(pageRanges, block.start);
      return pageNo === undefined || !skippedPages.has(pageNo);
    })
    .flatMap((block) =>
      countTokens(text.slice(block.start, block.end)) > CHUNK_MAX_TOKENS
        ? splitOversizedBlock(text, block, countTokens)
        : [block],
    );

  const chunks: DocumentChunk[] = [];
  const close = (accumulator: Accumulator): void => {
    if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
      throw new DocumentChunkLimitError(chunks.length + 1);
    }
    // Safety net: a single block can never exceed the ceiling after splitting, but a defensive trim
    // keeps the invariant true if a future change relaxes the split.
    let end = accumulator.end;
    let tokens = accumulator.tokens;
    while (tokens > CHUNK_MAX_TOKENS && end > accumulator.start + 1) {
      end = largestCut(text, accumulator.start, end, CHUNK_MAX_TOKENS, countTokens);
      tokens = countTokens(text.slice(accumulator.start, end));
    }
    chunks.push({
      sequenceNo: chunks.length,
      content: text.slice(accumulator.start, end),
      locator: {
        headingPath: accumulator.headingPath,
        pageStart: pageAt(pageRanges, accumulator.start),
        pageEnd: pageAt(pageRanges, end),
        charStart: accumulator.start,
        charEnd: end,
        tokenCount: tokens,
      },
    });
  };

  let headingPath: string[] = [];
  let accumulator: Accumulator | null = null;
  const trackHeadings = (input.format ?? 'markdown') === 'markdown';

  for (const block of blocks) {
    if (trackHeadings) {
      const trail = headingTrail(text.slice(block.start, block.end), headingPath);
      if (trail) headingPath = trail;
    }

    if (!accumulator) {
      accumulator = {
        start: block.start,
        end: block.end,
        headingPath,
        tokens: countTokens(text.slice(block.start, block.end)),
      };
      continue;
    }

    const candidateTokens = countTokens(text.slice(accumulator.start, block.end));
    if (candidateTokens <= CHUNK_TARGET_TOKENS) {
      accumulator.end = block.end;
      accumulator.tokens = candidateTokens;
      continue;
    }

    const previousEnd = accumulator.end;
    const previousStart = accumulator.start;
    close(accumulator);
    let start = overlapStart(text, previousEnd, previousStart, countTokens);
    let tokens = countTokens(text.slice(start, block.end));
    // A block that already fills the budget cannot also carry the overlap; drop it rather than
    // trimming the block's own tail.
    if (tokens > CHUNK_TARGET_TOKENS) {
      start = block.start;
      tokens = countTokens(text.slice(start, block.end));
    }
    accumulator = { start, end: block.end, headingPath, tokens };
  }
  if (accumulator) close(accumulator);

  // Fold a short trailing chunk into its predecessor when the combined slice still fits. Extending
  // the previous range keeps `content === text.slice(start, end)` true.
  const last = chunks[chunks.length - 1];
  const previous = chunks[chunks.length - 2];
  if (last && previous && last.locator.tokenCount < CHUNK_OVERLAP_TOKENS * 2) {
    const mergedTokens = countTokens(text.slice(previous.locator.charStart, last.locator.charEnd));
    if (mergedTokens <= CHUNK_MAX_TOKENS) {
      previous.content = text.slice(previous.locator.charStart, last.locator.charEnd);
      previous.locator.charEnd = last.locator.charEnd;
      previous.locator.pageEnd = last.locator.pageEnd ?? previous.locator.pageEnd;
      previous.locator.tokenCount = mergedTokens;
      chunks.pop();
    }
  }

  return chunks;
}
