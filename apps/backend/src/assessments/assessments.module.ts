import { Module } from '@nestjs/common';
import { AssessmentsService } from './assessments.service';

@Module({ providers: [AssessmentsService] })
export class AssessmentsModule {}