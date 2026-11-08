import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEsmModule } from '../load-esm';
import {
  DocumentParserError,
  type DocumentParser,
  type ParsedPage,
  type ParseWarning,
  type ParserInput,
  type ParserOutput,
} from '../document-parser.types';

/** Vertical tolerance in PDF user units when grouping items into one visual line. */
const LINE_Y_TOLERANCE = 2;
/** Paragraph break threshold as a multiple of the page median line gap. */
const PARAGRAPH_GAP_FACTOR = 1.6;
/** Dot characters needed before a paragraph counts as a table-of-contents row. */
const TOC_MIN_DOTS = 8;
/** Minimum share of a page's text items on each side of a gutter to call it two columns. */
const COLUMN_MIN_SHARE = 0.3;

/** One text item reduced to the geometry this parser needs. */
interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
}

/** One visual line of a page, in reading order. */
interface TextLine {
  y: number;
  items: TextItem[];
}

/** Reads one pdfjs text item; the ESM payload is untyped, so every field is validated. */
function toTextItem(value: unknown): TextItem | null {
  if (!value || typeof value !== 'object') return null;
  if (!('str' in value) || !('transform' in value) || !('width' in value)) return null;
  const { str, transform, width } = value;
  if (typeof str !== 'string' || !str.trim()) return null;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const x = transform[4];
  const y = transform[5];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number') return null;
  return { text: str, x, y, width };
}

/** True for CJK and full-width punctuation, where a joining space would be wrong. */
function isCjk(ch: string): boolean {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(ch);
}

/** Joins one line's items; inserts a space only between non-CJK neighbours. */
function joinLine(items: TextItem[]): string {
  let out = '';
  let previous = '';
  for (const item of items) {
    const text = item.text;
    const needsSpace =
      previous.length > 0 &&
      !(isCjk(previous[previous.length - 1]) && isCjk(text[0])) &&
      !/\s$/.test(previous) &&
      !/^\s/.test(text);
    out += (needsSpace ? ' ' : '') + text;
    previous = text;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** Groups items into visual lines by shared baseline, top-down and left-right. */
function groupLines(items: TextItem[]): TextLine[] {
  const lines: TextLine[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= LINE_Y_TOLERANCE);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

/** Returns the page's median vertical line gap, used as the paragraph break baseline. */
function medianLineGap(lines: TextLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) gaps.push(lines[i - 1].y - lines[i].y);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Merges lines into paragraphs, breaking where the gap clearly exceeds the median. */
function groupParagraphs(lines: TextLine[]): string[] {
  if (lines.length === 0) return [];
  const threshold = medianLineGap(lines) * PARAGRAPH_GAP_FACTOR;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    current.push(joinLine(lines[i].items));
    const next = lines[i + 1];
    const gap = next ? lines[i].y - next.y : Number.POSITIVE_INFINITY;
    if (gap > threshold) {
      const text = current.join('\n').trim();
      if (text) paragraphs.push(text);
      current = [];
    }
  }
  const tail = current.join('\n').trim();
  if (tail) paragraphs.push(tail);
  return paragraphs;
}

/**
 * Finds a vertical gutter that splits the page into two text columns.
 *
 * Only reports a gutter that leaves a meaningful share of items on both sides; single-column pages
 * with ragged right edges and wide tables must not be split.
 */
function detectGutter(items: TextItem[], pageWidth: number): number | null {
  if (items.length < 20 || pageWidth <= 0) return null;
  const bins = 100;
  const covered = new Array<boolean>(bins).fill(false);
  for (const item of items) {
    const start = Math.max(0, Math.floor((item.x / pageWidth) * bins));
    const end = Math.min(bins - 1, Math.floor(((item.x + Math.max(item.width, 1)) / pageWidth) * bins));
    for (let bin = start; bin <= end; bin += 1) covered[bin] = true;
  }
  let best: { start: number; length: number } | null = null;
  let runStart = -1;
  for (let bin = 0; bin <= bins; bin += 1) {
    const empty = bin < bins && !covered[bin];
    if (empty && runStart === -1) runStart = bin;
    if (!empty && runStart !== -1) {
      const length = bin - runStart;
      // The gutter must sit inside the central band, not at a margin.
      if (bin <= bins * 0.3 || runStart >= bins * 0.7) {
        runStart = -1;
        continue;
      }
      if (!best || length > best.length) best = { start: runStart, length };
      runStart = -1;
    }
  }
  if (!best || best.length < 6) return null;

  const gutterX = ((best.start + best.length / 2) / bins) * pageWidth;
  const left = items.filter((item) => item.x + item.width <= gutterX).length;
  const right = items.filter((item) => item.x >= gutterX).length;
  const share = (left + right) / items.length;
  if (share < 0.8) return null;
  if (left / items.length < COLUMN_MIN_SHARE || right / items.length < COLUMN_MIN_SHARE) return null;
  return gutterX;
}

/** True when a paragraph looks like a table-of-contents row rather than prose. */
function isTocLike(paragraph: string): boolean {
  const dots = paragraph.match(/\./g)?.length ?? 0;
  return dots >= TOC_MIN_DOTS && dots / paragraph.length > 0.15;
}

/** Rebuilds one page into paragraphs, splitting two-column pages column by column. */
function pageToParagraphs(items: TextItem[], pageWidth: number): {
  paragraphs: string[];
  multiColumn: boolean;
} {
  const gutter = detectGutter(items, pageWidth);
  if (gutter === null) {
    return { paragraphs: groupParagraphs(groupLines(items)), multiColumn: false };
  }
  const left = items.filter((item) => item.x < gutter);
  const right = items.filter((item) => item.x >= gutter);
  return {
    paragraphs: [...groupParagraphs(groupLines(left)), ...groupParagraphs(groupLines(right))],
    multiColumn: true,
  };
}

/** Resolves a pdfjs asset directory (cmaps, standard fonts) next to the installed package. */
function pdfjsAssetUrl(subdirectory: string): string | undefined {
  try {
    const packageJson = require.resolve('pdfjs-dist/package.json');
    return `${pathToFileURL(join(dirname(packageJson), subdirectory)).href}/`;
  } catch {
    return undefined;
  }
}

/** Reads the installed pdfjs-dist version for result provenance. */
function readPdfjsVersion(): string {
  try {
    const pkg: unknown = require('pdfjs-dist/package.json');
    if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
      return pkg.version;
    }
  } catch {
    /* fall through to the explicit unknown marker */
  }
  return 'unknown';
}

/** Minimal pdfjs surface used here; the module is ESM and ships no CommonJS types. */
interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{ view: number[]; getTextContent(): Promise<{ items: unknown[] }> }>;
}
interface PdfJsModule {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<PdfJsDocument>;
    destroy(): Promise<void>;
  };
}

let pdfjsPromise: Promise<PdfJsModule> | undefined;

/** Loads pdfjs-dist once per process; repeated parses reuse the module instance. */
function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= loadEsmModule<PdfJsModule>('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** Extracts the text layer of a PDF page by page, rebuilding lines and paragraphs geometrically. */
export class PdfTextParser implements DocumentParser {
  readonly id = 'pdf-text' as const;

  /** Accepts only .pdf; signature validation happens in the service. */
  supports(input: { extension: string; mediaType: string }): boolean {
    return input.extension === '.pdf';
  }

  /** Parses every page, keeping page numbers so downstream citations stay verifiable. */
  async parse(input: ParserInput): Promise<ParserOutput> {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(readFileSync(input.inputPath));
    const task = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      cMapUrl: pdfjsAssetUrl('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfjsAssetUrl('standard_fonts'),
    });

    const warnings: ParseWarning[] = [];
    const pages: ParsedPage[] = [];
    try {
      const document = await task.promise;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (input.signal?.aborted) throw new DocumentParserError('PARSER_CANCELLED', '解析已取消');
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = content.items
          .map((item) => toTextItem(item))
          .filter((item): item is TextItem => item !== null);
        const pageWidth = (page.view[2] ?? 0) - (page.view[0] ?? 0);
        const { paragraphs, multiColumn } = pageToParagraphs(items, pageWidth);

        if (multiColumn) {
          warnings.push({
            code: 'MULTI_COLUMN_SUSPECTED',
            message: `第 ${pageNumber} 页检测到双栏，已按列优先输出`,
            pageNo: pageNumber,
          });
        }
        if (paragraphs.some((paragraph) => isTocLike(paragraph))) {
          warnings.push({
            code: 'TOC_LIKE',
            message: `第 ${pageNumber} 页疑似目录页（点线引导符），不应进入索引`,
            pageNo: pageNumber,
          });
        }
        if (paragraphs.length === 0) {
          warnings.push({
            code: 'EMPTY_PAGE',
            message: `第 ${pageNumber} 页没有可提取文本`,
            pageNo: pageNumber,
          });
        }
        pages.push({ pageNo: pageNumber, text: paragraphs.join('\n\n') });
      }
    } finally {
      await task.destroy();
    }

    if (pages.every((page) => page.text.trim().length === 0)) {
      throw new DocumentParserError('NO_TEXT_LAYER', '该 PDF 没有文本层（可能是扫描件），暂不支持');
    }

    return {
      pages,
      format: 'plain_text',
      versionOrModel: `pdfjs@${readPdfjsVersion()}`,
      warnings,
    };
  }
}
