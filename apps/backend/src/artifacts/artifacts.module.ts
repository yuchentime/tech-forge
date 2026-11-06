import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactEntity } from './artifact.entity';
import { ArtifactsService } from './artifacts.service';

/** Registers the artifact persistence repository. */
@Module({
  imports: [TypeOrmModule.forFeature([ArtifactEntity])],
  providers: [ArtifactsService],
})
export class ArtifactsModule {}
