import { readFileSync } from 'node:fs';
import type { DocumentParser, ParserInput, ParserOutput } from '../document-parser.types';

/** Reads Markdown and plain-text files verbatim; no layout or encoding guessing. */
export class PlainTextParser implements DocumentParser {
  readonly id = 'plain-text' as const;

  /** Accepts Markdown and plain-text extensions only. */
  supports(input: { extension: string; mediaType: string }): boolean {
    return ['.md', '.markdown', '.txt'].includes(input.extension);
  }

  /** Returns the decoded file as a single page; the chunker derives the rest. */
  async parse(input: ParserInput): Promise<ParserOutput> {
    const text = readFileSync(input.inputPath, 'utf8').replace(/^\uFEFF/, '');
    return {
      pages: [{ pageNo: 1, text }],
      format: input.extension === '.txt' ? 'plain_text' : 'markdown',
      versionOrModel: 'raw-utf8',
      warnings: [],
    };
  }
}
