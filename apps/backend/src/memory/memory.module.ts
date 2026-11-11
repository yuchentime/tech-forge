import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { SettingsModule } from '../settings/settings.module';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

/** Provides long-term memory storage, tools and the local management API. */
@Module({
  imports: [EmbeddingModule, SettingsModule],
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
