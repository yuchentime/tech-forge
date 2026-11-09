import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsModule } from '../settings/settings.module';
import { ArtifactEntity } from './artifact.entity';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';

/** Registers artifact persistence, the read API and the shared artifact owner. */
@Module({
  imports: [TypeOrmModule.forFeature([ArtifactEntity]), SettingsModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
