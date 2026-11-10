import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmbeddingModule } from '../embedding/embedding.module';
import { DocumentParserModule } from '../platform/document-parser/document-parser.module';
import { SettingsModule } from '../settings/settings.module';
import { LlmModule } from '../llm/llm.module';
import { ConversationDocumentEntity } from './conversation-document.entity';
import { DocumentChunkEntity } from './document-chunk.entity';
import { DocumentEntity } from './document.entity';
import { DocumentVersionEntity } from './document-version.entity';
import { DocumentCatalogIndexService, DocumentCatalogService } from './document-catalog.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

/**
 * Registers document repositories plus the parser, embedding and settings capabilities the domain
 * depends on, and exposes the knowledge-library API.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocumentEntity,
      DocumentVersionEntity,
      ConversationDocumentEntity,
      DocumentChunkEntity,
    ]),
    DocumentParserModule,
    // Legacy embeddings remain injectable for historical maintenance helpers; ingest no longer calls them.
    EmbeddingModule,
    SettingsModule,
    LlmModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentCatalogService, DocumentCatalogIndexService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
