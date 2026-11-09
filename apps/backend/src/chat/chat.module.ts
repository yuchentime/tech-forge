import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmModule } from '../llm/llm.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [ConversationsModule, KnowledgeModule, LlmModule],
  controllers: [ChatController],
  providers: [ChatService],
})
/** Composes the Chat HTTP boundary with its shared LLM dependency. */
export class ChatModule {}
