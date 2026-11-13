import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { LessonsModule } from '../lessons/lessons.module';
import { MemoryModule } from '../memory/memory.module';
import { SettingsModule } from '../settings/settings.module';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { ClassroomSimulationAgent } from './ClassroomSimulationAgent';
import { LlmService } from './llm.service';
import { StudentAgent } from './StudentAgent';

@Module({
  imports: [
    SettingsModule,
    ConversationsModule,
    MemoryModule,
    LessonsModule,
  ],
  providers: [LlmService, DeepseekLLMAdapter, ClassroomSimulationAgent, StudentAgent],
  exports: [LlmService, ClassroomSimulationAgent, StudentAgent],
})
/** Exposes the shared model service to business modules. */
export class LlmModule {}
