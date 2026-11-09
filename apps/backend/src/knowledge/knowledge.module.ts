import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { SettingsModule } from '../settings/settings.module';
import { CHUNK_RERANKER, LlmChunkReranker } from './chunk-reranker';
import { KnowledgeService } from './knowledge.service';

/** Composes the conversation-scoped knowledge context from documents, retrieval and reranking. */
@Module({
  imports: [DocumentsModule, RetrievalModule, SettingsModule],
  providers: [
    KnowledgeService,
    LlmChunkReranker,
    { provide: CHUNK_RERANKER, useExisting: LlmChunkReranker },
  ],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
