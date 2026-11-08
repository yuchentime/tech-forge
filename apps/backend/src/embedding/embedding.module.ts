import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';

/** Provides the local embedding model as a shared capability for documents and retrieval. */
@Module({
  providers: [EmbeddingService],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
