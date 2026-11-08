import { Module } from '@nestjs/common';
import { DocumentParserService } from './document-parser.service';
import { DocxParser } from './parsers/docx.parser';
import { PdfTextParser } from './parsers/pdf-text.parser';
import { PlainTextParser } from './parsers/plain-text.parser';

/** Wires the document parser adapter and exports only its service contract. */
@Module({
  providers: [PdfTextParser, DocxParser, PlainTextParser, DocumentParserService],
  exports: [DocumentParserService],
})
export class DocumentParserModule {}
