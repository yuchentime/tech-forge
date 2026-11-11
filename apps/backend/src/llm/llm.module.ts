import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { MemoryModule } from '../memory/memory.module';
import { SettingsModule } from '../settings/settings.module';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { LlmService } from './llm.service';

@Module({
  imports: [SettingsModule, ConversationsModule, MemoryModule],
  providers: [LlmService, DeepseekLLMAdapter],
  exports: [LlmService],
})
/** Exposes the shared model service to business modules. */
export class LlmModule {}
