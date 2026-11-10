import * as mammoth from 'mammoth';
import type {
  DocumentParser,
  ParseWarning,
  ParserInput,
  ParserOutput,
} from '../document-parser.types';

/** Conversion artifacts that pollute tokenization and character offsets. */
const HTML_ANCHOR = /<a\s+[^>]*>\s*<\/a>/gi;
const INVISIBLE = /[\u200B-\u200D\uFEFF\u2060]/g;
const EMBEDDED_IMAGE = /!\[([^\]]*)\]\(data:image\/[^;\s)]+;base64,[A-Za-z0-9+/=\r\n]+\)/gi;
/** A paragraph made only of bold text, within this length, is treated as a heading. */
const BOLD_ONLY = /^\s*(?:__(?!_)(.+?)__|\*\*(.+?)\*\*)\s*$/;
const PSEUDO_HEADING_MAX_CHARS = 40;
const SENTENCE_END = /(?<!\\)[。！？.!?]/;
const MAX_CONVERSION_WARNINGS = 5;

/** Result shape of mammoth's Markdown conversion. */
interface MarkdownConversion {
  value: string;
  messages: Array<{ message: string }>;
}

/** Subset of mammoth's runtime API used here. */
interface MarkdownCapable {
  convertToMarkdown(
    input: { path: string },
    options?: { transformDocument?: (document: unknown) => unknown },
  ): Promise<MarkdownConversion>;
}

/**
 * mammoth 1.13 exposes `convertToMarkdown` at runtime but its bundled `.d.ts` only declares
 * `convertToHtml`. This named const bridges that declaration gap in one place; `parse()` still
 * asserts the method exists before calling it.
 */
const mammothApi = mammoth as typeof mammoth & MarkdownCapable;

/** The subset of mammoth's document AST this parser walks. */
interface MammothNode {
  type?: string;
  children?: unknown[];
}

/** Narrows an untyped mammoth AST node; the library ships no type declarations. */
function toNode(value: unknown): MammothNode | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as MammothNode; // third-party AST: only `type` and `children` are read
  return node;
}

/** Counts table elements anywhere in the mammoth document tree. */
function countTables(root: unknown): number {
  let count = 0;
  const walk = (value: unknown): void => {
    const node = toNode(value);
    if (!node) return;
    if (node.type === 'table') count += 1;
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return count;
}

/** Removes conversion artifacts that would otherwise reach the chunker and the index. */
export function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(HTML_ANCHOR, '')
    .replace(INVISIBLE, '')
    // A DOCX image can become a megabyte-scale data URL. The library is text-first, so retaining
    // its bytes makes Markdown readers fail without adding searchable evidence.
    .replace(EMBEDDED_IMAGE, (_match, alt: string) => `> [原文图片已省略${alt ? `：${alt}` : ''}]`);
}

/**
 * Promotes bold-only short paragraphs to `##` headings.
 *
 * Word files without heading styles (the common case for hand-written teaching notes) carry their
 * structure only through bold runs; without this step every chunk would lose its section anchor.
 */
function promotePseudoHeadings(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      const match = BOLD_ONLY.exec(block);
      if (!match) return block;
      const inner = (match[1] ?? match[2] ?? '').trim();
      if (!inner || inner.length > PSEUDO_HEADING_MAX_CHARS || SENTENCE_END.test(inner)) return block;
      return `## ${inner}`;
    })
    .join('\n\n');
}

/** Reads the installed mammoth version for result provenance; falls back instead of failing. */
function readMammothVersion(): string {
  try {
    const pkg: unknown = require('mammoth/package.json');
    if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
      return pkg.version;
    }
  } catch {
    /* fall through to the explicit unknown marker */
  }
  return 'unknown';
}

/** Converts DOCX to Markdown with mammoth and reports the structure it could not keep. */
export class DocxParser implements DocumentParser {
  readonly id = 'docx' as const;

  /** Accepts only .docx; legacy .doc is rejected by the service registry. */
  supports(input: { extension: string; mediaType: string }): boolean {
    return input.extension === '.docx';
  }

  /** Runs mammoth, flattens what Markdown cannot express, and records a warning for it. */
  async parse(input: ParserInput): Promise<ParserOutput> {
    if (typeof mammothApi.convertToMarkdown !== 'function') {
      throw new Error('当前 mammoth 版本缺少 convertToMarkdown');
    }
    let tableCount = 0;
    const converted = await mammothApi.convertToMarkdown(
      { path: input.inputPath },
      {
        // mammoth applies this transform to every element, so only the document root is counted;
        // counting each subtree would report the last visited node's tables instead of the total.
        transformDocument: (document: unknown) => {
          if (toNode(document)?.type === 'document') tableCount = countTables(document);
          return document;
        },
      },
    );

    const text = promotePseudoHeadings(cleanMarkdown(converted.value));
    const warnings: ParseWarning[] = [];
    if (tableCount > 0) {
      warnings.push({
        code: 'UNSTRUCTURED_TABLE',
        message: `${tableCount} 个表格已按行拍平为段落，行列关系未保留`,
      });
    }
    for (const message of converted.messages.slice(0, MAX_CONVERSION_WARNINGS)) {
      warnings.push({ code: 'CONVERSION_MESSAGE', message: message.message });
    }

    return {
      pages: [{ pageNo: 1, text }],
      format: 'markdown',
      versionOrModel: `mammoth@${readMammothVersion()}`,
      warnings,
    };
  }
}
