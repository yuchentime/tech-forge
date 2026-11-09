import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { SettingsModule } from '../settings/settings.module';
import { CustomLLMAdapter } from './adapters/custom-llm.adapter';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { LlmService } from './llm.service';

@Module({
  imports: [SettingsModule, ConversationsModule],
  providers: [LlmService, DeepseekLLMAdapter, CustomLLMAdapter],
  exports: [LlmService],
})
/** Exposes the shared model service to business modules. */
export class LlmModule {}
