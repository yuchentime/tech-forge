import { Module } from '@nestjs/common';
import { TeachingService } from './teaching.service';

@Module({ providers: [TeachingService] })
export class TeachingModule {}