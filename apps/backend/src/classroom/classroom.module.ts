import { Module } from '@nestjs/common';
import { LessonsModule } from '../lessons/lessons.module';
import { AgentModule } from '../llm/agents/AgentModule';
import { ClassroomController } from './classroom.controller';
import { ClassroomTurnsService } from './classroom-turns.service';

/**
 * HTTP boundary for classroom lessons.
 *
 * `AgentModule` supplies `ClassroomSimulationAgent` and `ClassroomSummariesAgent`; persistence
 * and the transcript stay in `LessonsModule`.
 */
@Module({
  imports: [LessonsModule, AgentModule],
  controllers: [ClassroomController],
  providers: [ClassroomTurnsService],
})
export class ClassroomModule {}
