import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { SettingsModule } from '../settings/settings.module';
import { LlmQueryExpander, QUERY_EXPANDER } from './query-expander';
import { RetrievalService } from './retrieval.service';

/** Wires lexical + dense retrieval plus optional LLM query expansion. */
@Module({
  imports: [EmbeddingModule, SettingsModule],
  providers: [
    RetrievalService,
    LlmQueryExpander,
    { provide: QUERY_EXPANDER, useExisting: LlmQueryExpander },
  ],
  exports: [RetrievalService],
})
export class RetrievalModule {}
