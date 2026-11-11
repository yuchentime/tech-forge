import { Inject, Injectable, Optional } from '@nestjs/common';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { buildParserRegistry, DocumentParserRegistry } from './document-parser.registry';
import {
  DocumentParserError,
  isDocumentParserError,
  type DocumentParser,
  type ParseDocumentRequest,
  type ParseDocumentResult,
  type ParserInput,
  type ParserOutput,
} from './document-parser.types';
import { DocxParser } from './parsers/docx.parser';
import { PdfTextParser } from './parsers/pdf-text.parser';
import { PlainTextParser } from './parsers/plain-text.parser';

/** Explicit execution limits; parsing never runs unbounded on a user machine. */
export interface DocumentParserLimits {
  maxFileBytes: number;
  timeoutMs: number;
}

/** Injection token so tests or future settings can override the limits without touching the service. */
export const DOCUMENT_PARSER_LIMITS = 'DOCUMENT_PARSER_LIMITS';

const DEFAULT_LIMITS: DocumentParserLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** Media type recorded on the result, derived from the extension rather than trusted input. */
const MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
};

/** Leading bytes every parser-backed binary format must have. */
const SIGNATURES: Record<string, string> = {
  '.pdf': '%PDF-',
  '.docx': 'PK\u0003\u0004',
};

/**
 * Validates one parse request, routes it to a parser, and normalises the result.
 *
 * Holds no format knowledge: every parser-specific rule lives in `parsers/`, and every caller-facing
 * guarantee (limits, timeout, cancellation, typed errors, joined text) is applied here exactly once.
 */
@Injectable()
export class DocumentParserService {
  private readonly registry: DocumentParserRegistry;
  private readonly limits: DocumentParserLimits;

  constructor(
    pdfTextParser: PdfTextParser,
    docxParser: DocxParser,
    plainTextParser: PlainTextParser,
    @Optional() @Inject(DOCUMENT_PARSER_LIMITS) limits?: DocumentParserLimits,
  ) {
    this.registry = buildParserRegistry([pdfTextParser, docxParser, plainTextParser]);
    this.limits = limits ?? DEFAULT_LIMITS;
  }

  /** Parses one application-managed file and returns page-anchored text plus quality warnings. */
  async parse(request: ParseDocumentRequest): Promise<ParseDocumentResult> {
    const filePath = this.validateRequest(request);
    const byteSize = this.assertReadableFile(filePath);
    const extension = this.resolveExtension(request);
    const mediaType = MEDIA_TYPES[extension] ?? 'application/octet-stream';
    const parser = this.registry.resolve({ extension, mediaType });

    if (!parser) {
      throw new DocumentParserError(
        'UNSUPPORTED_FORMAT',
        `不支持的文件类型：${extension || '(无扩展名)'}`,
      );
    }
    this.assertSignature(filePath, extension);

    const parserInput: ParserInput = { ...request, inputPath: filePath, extension };
    const output = await this.runWithLimits(
      (signal) => parser.parse({ ...parserInput, signal }),
      parserInput.signal,
    );
    const text = output.pages.map((page) => page.text).join('\n\n').trim();

    if (output.pages.length === 0 || text.length === 0) {
      throw new DocumentParserError('EMPTY_PARSE_RESULT', '解析完成但没有可用文本');
    }

    return {
      text,
      pages: output.pages,
      format: output.format,
      parser: { id: parser.id, versionOrModel: output.versionOrModel },
      source: { mediaType, pageCount: output.pages.length, byteSize },
      warnings: output.warnings,
    };
  }

  /** Registered parser ids, exposed for diagnostics and conformance tests. */
  availableParsers(): string[] {
    return this.registry.ids();
  }

  /** Reports whether a file name would route to a parser, without touching the filesystem. */
  supportsFile(originalName: string): boolean {
    return this.resolveParser(originalName) !== null;
  }

  /**
   * Reports whether reading a file of this name produces a new text document.
   *
   * False for Markdown and plain text: the stored file already is the text, so a converted copy
   * would only duplicate it. Unknown formats report true so no caller treats them as readable.
   */
  requiresExtraction(originalName: string): boolean {
    return this.resolveParser(originalName)?.requiresExtraction ?? true;
  }

  /** Resolves the parser for one file name, or null when its extension is unsupported. */
  private resolveParser(originalName: string): DocumentParser | null {
    const extension = extname(originalName).toLowerCase();
    if (!extension) return null;
    return this.registry.resolve({ extension, mediaType: MEDIA_TYPES[extension] ?? '' });
  }

  /** Rejects empty, relative or non-string input paths early. */
  private validateRequest(request: ParseDocumentRequest): string {
    if (!request || typeof request.inputPath !== 'string' || request.inputPath.trim() === '') {
      throw new DocumentParserError('INVALID_INPUT_FILE', '缺少输入文件路径');
    }
    if (!isAbsolute(request.inputPath)) {
      throw new DocumentParserError('INVALID_INPUT_FILE', '输入路径必须是绝对路径');
    }
    if (typeof request.originalName !== 'string' || request.originalName.trim() === '') {
      throw new DocumentParserError('INVALID_INPUT_FILE', '缺少原始文件名');
    }
    return request.inputPath;
  }

  /** Confirms the path is a regular file within the size limit and returns its byte size. */
  private assertReadableFile(filePath: string): number {
    let byteSize: number;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) throw new Error('not a regular file');
      byteSize = stats.size;
    } catch {
      throw new DocumentParserError('INVALID_INPUT_FILE', '输入文件不存在或不可读');
    }
    if (byteSize === 0) throw new DocumentParserError('INVALID_INPUT_FILE', '输入文件为空');
    if (byteSize > this.limits.maxFileBytes) {
      throw new DocumentParserError(
        'FILE_TOO_LARGE',
        `文件超过 ${Math.round(this.limits.maxFileBytes / (1024 * 1024))} MB 限制`,
      );
    }
    return byteSize;
  }

  /** Derives the lowercase extension from the original name, falling back to the temp path. */
  private resolveExtension(request: ParseDocumentRequest): string {
    const fromName = extname(request.originalName).toLowerCase();
    return fromName || extname(request.inputPath).toLowerCase();
  }

  /** Verifies the binary signature so a renamed file cannot reach a parser expecting another format. */
  private assertSignature(filePath: string, extension: string): void {
    const signature = SIGNATURES[extension];
    if (!signature) return;
    const bytes = Buffer.alloc(signature.length);
    const handle = openSync(filePath, 'r');
    try {
      readSync(handle, bytes, 0, signature.length, 0);
    } finally {
      closeSync(handle);
    }
    if (bytes.toString('binary') !== signature) {
      throw new DocumentParserError('UNSUPPORTED_FORMAT', `文件内容与扩展名 ${extension} 不匹配`);
    }
  }

  /** Runs one parser with a hard timeout and cooperative cancellation, mapping failures to codes. */
  private async runWithLimits(
    run: (signal: AbortSignal) => Promise<ParserOutput>,
    callerSignal?: AbortSignal,
  ): Promise<ParserOutput> {
    if (callerSignal?.aborted) {
      throw new DocumentParserError('PARSER_CANCELLED', '解析已取消');
    }
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = (): void => controller.abort();
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.timeoutMs);

    try {
      return await run(controller.signal);
    } catch (error) {
      if (isDocumentParserError(error)) throw error;
      if (timedOut) throw new DocumentParserError('PARSER_TIMEOUT', '解析超时');
      if (controller.signal.aborted) throw new DocumentParserError('PARSER_CANCELLED', '解析已取消');
      const message = error instanceof Error ? error.message : String(error);
      throw new DocumentParserError('PARSER_FAILED', `解析失败：${message}`);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }
  }
}
