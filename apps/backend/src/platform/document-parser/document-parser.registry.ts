import type { DocumentParser } from './document-parser.types';

/**
 * Single routing table from file format to parser implementation.
 *
 * Adding a format must only require registering a parser here; no caller switches on extensions.
 */
export class DocumentParserRegistry {
  constructor(private readonly parsers: DocumentParser[]) {}

  /** Returns the first parser that accepts the resolved extension and media type. */
  resolve(input: { extension: string; mediaType: string }): DocumentParser | null {
    return this.parsers.find((parser) => parser.supports(input)) ?? null;
  }

  /** Lists registered parser ids, used by diagnostics and tests. */
  ids(): string[] {
    return this.parsers.map((parser) => parser.id);
  }
}

/** Builds the registry from the parser instances the module provides. */
export function buildParserRegistry(parsers: DocumentParser[]): DocumentParserRegistry {
  return new DocumentParserRegistry(parsers);
}
