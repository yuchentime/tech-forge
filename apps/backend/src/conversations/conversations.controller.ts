import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import type {
  ConversationMessageDto,
  ConversationSummaryDto,
} from './conversation-query.dto';

/** Exposes read-only conversation summaries and visible message history. */
@Controller('conversations')
export class ConversationsController {
  /** Injects the domain-owned query service for the conversation read API. */
  constructor(private readonly conversations: ConversationsService) {}

  /** Returns sidebar summaries without exposing message or tool payloads. */
  @Get()
  list(): Promise<ConversationSummaryDto[]> {
    return this.conversations.listConversations();
  }

  /** Returns visible user and assistant text for one existing UUIDv4 conversation. */
  @Get(':conversationId/messages')
  getMessages(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
  ): Promise<ConversationMessageDto[]> {
    return this.conversations.getConversationMessages(conversationId);
  }
}
