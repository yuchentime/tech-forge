import { Module } from '@nestjs/common';
import { LessonsService } from './lessons.service';

@Module({ providers: [LessonsService] })
export class LessonsModule {}