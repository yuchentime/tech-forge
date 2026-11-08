import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { RetrievalService } from './retrieval.service';

/** Wires lexical + dense retrieval; depends on the embedding model for the dense channel. */
@Module({
  imports: [EmbeddingModule],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
