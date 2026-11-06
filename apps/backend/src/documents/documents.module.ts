import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationDocumentEntity } from './conversation-document.entity';
import { DocumentChunkEntity } from './document-chunk.entity';
import { DocumentEntity } from './document.entity';
import { DocumentVersionEntity } from './document-version.entity';
import { DocumentsService } from './documents.service';

/** Registers document, version, chunk, and conversation-link repositories. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocumentEntity,
      DocumentVersionEntity,
      ConversationDocumentEntity,
      DocumentChunkEntity,
    ]),
  ],
  providers: [DocumentsService],
})
export class DocumentsModule {}
