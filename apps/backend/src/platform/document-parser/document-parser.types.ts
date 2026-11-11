/** Parser implementations currently supported by the document parser adapter. */
export type ParserId = 'pdf-text' | 'docx' | 'plain-text';

/** Error codes surfaced by the adapter; callers must branch on these, not on messages. */
export type DocumentParserErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_INPUT_FILE'
  | 'FILE_TOO_LARGE'
  | 'PARSER_TIMEOUT'
  | 'PARSER_CANCELLED'
  | 'PARSER_FAILED'
  | 'EMPTY_PARSE_RESULT'
  | 'NO_TEXT_LAYER';

/** One caller request; `inputPath` must point at an application-managed temp file. */
export interface ParseDocumentRequest {
  inputPath: string;
  originalName: string;
  mimeType?: string;
  signal?: AbortSignal;
}

/** A single locator unit: one PDF page, or the whole document for non-paginated formats. */
export interface ParsedPage {
  pageNo: number;
  text: string;
}

/** Non-fatal quality signal. Consumers must not treat a warning as success. */
export interface ParseWarning {
  code: 'TOC_LIKE' | 'MULTI_COLUMN_SUSPECTED' | 'UNSTRUCTURED_TABLE' | 'EMPTY_PAGE' | 'CONVERSION_MESSAGE';
  message: string;
  pageNo?: number;
}

/** Parsed document. `text` is always `pages` concatenated, so callers may ignore paging. */
export interface ParseDocumentResult {
  text: string;
  pages: ParsedPage[];
  format: 'markdown' | 'plain_text';
  parser: { id: ParserId; versionOrModel: string };
  source: { mediaType: string; pageCount: number; byteSize: number };
  warnings: ParseWarning[];
}

/** Input handed to one parser after the service resolved the format. */
export interface ParserInput extends ParseDocumentRequest {
  extension: string;
}

/** Parser return value before the service adds identity, source metadata and the joined text. */
export interface ParserOutput {
  pages: ParsedPage[];
  format: 'markdown' | 'plain_text';
  versionOrModel: string;
  warnings: ParseWarning[];
}

/** One format implementation. Implementations must stay free of persistence and Nest dependencies. */
export interface DocumentParser {
  id: ParserId;
  /**
   * True when the stored file is not itself readable text and parsing must produce one.
   *
   * Callers use it to keep a verbatim source file instead of writing a second converted copy.
   */
  readonly requiresExtraction: boolean;
  supports(input: { extension: string; mediaType: string }): boolean;
  parse(input: ParserInput): Promise<ParserOutput>;
}

/** Typed failure raised by the adapter so callers can map it without inspecting messages. */
export class DocumentParserError extends Error {
  constructor(
    readonly code: DocumentParserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentParserError';
  }
}

/** Narrows an unknown error to the adapter's typed failure. */
export function isDocumentParserError(error: unknown): error is DocumentParserError {
  return error instanceof DocumentParserError;
}
