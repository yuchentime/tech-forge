import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ImportDocumentDto } from './documents.dto';
import {
  DocumentsService,
  type DocumentSummary,
  type ImportDocumentResult,
  type RetryCatalogResult,
} from './documents.service';

/**
 * Exposes the knowledge-library HTTP boundary: list, import one picked file, retry its catalog summary, delete one document.
 *
 * Protocol conversion only; ingest, workspace copying, ordering and deletion rules stay in
 * `DocumentsService`.
 */
@Controller('documents')
export class DocumentsController {
  /** Injects the document domain service that owns ingest, storage and deletion. */
  constructor(private readonly documents: DocumentsService) {}

  /** Returns every stored document with its latest version state. */
  @Get()
  list(): Promise<DocumentSummary[]> {
    return this.documents.listDocuments();
  }

  /** Imports one absolute file path into the workspace and the knowledge index. */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  importDocument(@Body() input: ImportDocumentDto): Promise<ImportDocumentResult> {
    return this.documents.importFromPath(input);
  }

  /** Rebuilds the catalog summary of one document's latest version without re-importing it. */
  @Post(':documentId/catalog/retry')
  @HttpCode(HttpStatus.OK)
  retryCatalog(@Param('documentId') documentId: string): Promise<RetryCatalogResult> {
    return this.documents.retryCatalog(documentId);
  }

  /** Deletes one document with every derived row and file copy. */
  @Delete(':documentId')
  async deleteDocument(
    @Param('documentId') documentId: string,
  ): Promise<{ documentId: string; fileCleanup: 'complete' | 'partial' }> {
    const { fileCleanup } = await this.documents.deleteDocument(documentId);
    return { documentId, fileCleanup };
  }
}
