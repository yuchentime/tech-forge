import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsModule } from '../settings/settings.module';
import { LessonEntity } from './lesson.entity';
import { LessonsService } from './lessons.service';

/** Owns classroom lesson rows and their local JSONL transcripts. */
@Module({
  imports: [TypeOrmModule.forFeature([LessonEntity]), SettingsModule],
  providers: [LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
