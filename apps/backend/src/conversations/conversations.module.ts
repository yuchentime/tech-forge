import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationEntity } from './conversation.entity';
import { MessageEntity } from './message.entity';
import { ConversationsService } from './conversations.service';

/** Registers conversation persistence repositories for the conversation feature. */
@Module({
  imports: [TypeOrmModule.forFeature([ConversationEntity, MessageEntity])],
  providers: [ConversationsService],
})
export class ConversationsModule {}
