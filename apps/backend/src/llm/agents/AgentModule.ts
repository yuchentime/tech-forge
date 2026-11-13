import { Module } from '@nestjs/common';
import { ConversationsModule } from '../../conversations/conversations.module';
import { LessonsModule } from '../../lessons/lessons.module';
import { MemoryModule } from '../../memory/memory.module';
import { SettingsModule } from '../../settings/settings.module';
import { DeepseekLLMAdapter } from '../adapters/deepseek-llm.adapter';
import { ClassroomSimulationAgent } from './ClassroomSimulationAgent';
import { ClassroomSummariesAgent } from './ClassroomSummariesAgent';
import { CommonAgent } from './CommonAgent';
import { LearnAgent } from './LearnAgent';
import { StudentAgent } from './StudentAgent';

/**
 * Owns every model-backed agent and the shared Pi session pipeline.
 *
 * `CommonAgent` builds sessions and runs JSON calls; `LearnAgent` adds the chat stream;
 * classroom agents add the simulation and summary flows. Business modules import this module
 * instead of reaching into the Pi SDK.
 */
@Module({
  imports: [
    SettingsModule,
    ConversationsModule,
    MemoryModule,
    LessonsModule,
  ],
  providers: [
    DeepseekLLMAdapter,
    CommonAgent,
    LearnAgent,
    ClassroomSimulationAgent,
    StudentAgent,
    ClassroomSummariesAgent,
  ],
  exports: [
    CommonAgent,
    LearnAgent,
    ClassroomSimulationAgent,
    ClassroomSummariesAgent,
  ],
})
export class AgentModule {}
