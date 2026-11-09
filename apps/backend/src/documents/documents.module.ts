import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmbeddingModule } from '../embedding/embedding.module';
import { DocumentParserModule } from '../platform/document-parser/document-parser.module';
import { SettingsModule } from '../settings/settings.module';
import { ConversationDocumentEntity } from './conversation-document.entity';
import { DocumentChunkEntity } from './document-chunk.entity';
import { DocumentEntity } from './document.entity';
import { DocumentVersionEntity } from './document-version.entity';
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
    EmbeddingModule,
    SettingsModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
