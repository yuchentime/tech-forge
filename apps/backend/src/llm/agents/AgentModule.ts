import { Module } from '@nestjs/common';
import { ConversationsModule } from '../../conversations/conversations.module';
import { LessonsModule } from '../../lessons/lessons.module';
import { MemoryModule } from '../../memory/memory.module';
import { SettingsModule } from '../../settings/settings.module';
import { DeepseekLLMAdapter } from '../adapters/deepseek-llm.adapter';
import { PiAgentRuntime } from '../pi-agent-runtime';
import { ClassroomSimulationAgent } from './ClassroomSimulationAgent';
import { ClassroomSummariesAgent } from './ClassroomSummariesAgent';
import { OneShotLlmAgent } from './OneShotLlmAgent';
import { LearnAgent } from './LearnAgent';
import { StudentAgent } from './StudentAgent';

/**
 * Owns every model-backed agent and registers the shared Pi session runtime.
 *
 * `PiAgentRuntime` owns Pi session construction; `OneShotLlmAgent` owns the one-shot generation
 * lifecycle and exposes its non-streamed entry point;
 * `LearnAgent` adds the chat stream;
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
    PiAgentRuntime,
    OneShotLlmAgent,
    LearnAgent,
    ClassroomSimulationAgent,
    StudentAgent,
    ClassroomSummariesAgent,
  ],
  exports: [
    OneShotLlmAgent,
    LearnAgent,
    ClassroomSimulationAgent,
    ClassroomSummariesAgent,
  ],
})
export class AgentModule {}
