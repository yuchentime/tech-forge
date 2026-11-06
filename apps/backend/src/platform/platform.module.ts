import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';

/** Composition point for backend platform capabilities. */
@Module({ imports: [HealthModule] })
export class PlatformModule {}