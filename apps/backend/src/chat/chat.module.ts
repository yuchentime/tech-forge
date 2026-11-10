import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { DocumentsModule } from '../documents/documents.module';
import { LlmModule } from '../llm/llm.module';
import { RehearsalsModule } from '../rehearsals/rehearsals.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [
    AttachmentsModule,
    ArtifactsModule,
    ConversationsModule,
    DocumentsModule,
    LlmModule,
    RehearsalsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
/** Composes the Chat HTTP boundary with its shared LLM dependency. */
export class ChatModule {}
