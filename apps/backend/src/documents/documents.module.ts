import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentParserModule } from '../platform/document-parser/document-parser.module';
import { ConversationDocumentEntity } from './conversation-document.entity';
import { DocumentChunkEntity } from './document-chunk.entity';
import { DocumentEntity } from './document.entity';
import { DocumentVersionEntity } from './document-version.entity';
import { DocumentsService } from './documents.service';

/** Registers document repositories and the parser dependency used by the ingest pipeline. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocumentEntity,
      DocumentVersionEntity,
      ConversationDocumentEntity,
      DocumentChunkEntity,
    ]),
    DocumentParserModule,
  ],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
