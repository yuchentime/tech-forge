import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsModule } from '../settings/settings.module';
import { ConversationEntity } from './conversation.entity';
import { MessageEntity } from './message.entity';
import { ConversationsService } from './conversations.service';
import { PiSessionSnapshotsService } from './pi-session-snapshots.service';
import { ConversationsController } from './conversations.controller';

/** Registers conversation persistence repositories for the conversation feature. */
@Module({
  imports: [TypeOrmModule.forFeature([ConversationEntity, MessageEntity]), SettingsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, PiSessionSnapshotsService],
  exports: [ConversationsService, PiSessionSnapshotsService],
})
export class ConversationsModule {}
