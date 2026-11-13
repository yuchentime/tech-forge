import { Module } from '@nestjs/common';
import { LessonsModule } from '../lessons/lessons.module';
import { LlmModule } from '../llm/llm.module';
import { ClassroomController } from './classroom.controller';
import { ClassroomSummariesService } from './classroom-summaries.service';
import { ClassroomTurnsService } from './classroom-turns.service';

/**
 * HTTP boundary for classroom lessons.
 *
 * `LlmModule` supplies `ClassroomSimulationAgent` for turns and `LlmService` for summary
 * generation; persistence and the transcript stay in `LessonsModule`.
 */
@Module({
  imports: [LessonsModule, LlmModule],
  controllers: [ClassroomController],
  providers: [ClassroomSummariesService, ClassroomTurnsService],
})
export class ClassroomModule {}
