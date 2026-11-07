import { Controller, Get, Logger, Param, ParseUUIDPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConversationsService } from './conversations.service';
import type {
  ConversationMessageDto,
  ConversationSummaryDto,
} from './conversation-query.dto';
import { getSafeErrorLogFields, writeStructuredEvent } from '../logging/structured-logger';

/** Exposes read-only conversation summaries and visible message history. */
@Controller('conversations')
export class ConversationsController {
  private readonly logger = new Logger(ConversationsController.name);

  /** Injects the domain-owned query service for the conversation read API. */
  constructor(private readonly conversations: ConversationsService) {}

  /** Returns sidebar summaries without exposing message or tool payloads. */
  @Get()
  async list(): Promise<ConversationSummaryDto[]> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    writeStructuredEvent(this.logger, 'log', 'conversations.http.list.accepted', {
      requestId,
    });
    try {
      const result = await this.conversations.listConversations({ requestId });
      writeStructuredEvent(this.logger, 'log', 'conversations.http.list.completed', {
        requestId,
        conversationCount: result.length,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'conversations.http.list.failed', {
        requestId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Returns visible user and assistant text for one existing UUIDv4 conversation. */
  @Get(':conversationId/messages')
  getMessages(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
  ): Promise<ConversationMessageDto[]> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    writeStructuredEvent(
      this.logger,
      'log',
      'conversations.http.messages.accepted',
      { requestId, conversationId },
    );
    return this.conversations
      .getConversationMessages(conversationId, { requestId, conversationId })
      .then((result) => {
        writeStructuredEvent(
          this.logger,
          'log',
          'conversations.http.messages.completed',
          {
            requestId,
            conversationId,
            messageCount: result.length,
            elapsedMs: Date.now() - startedAt,
          },
        );
        return result;
      })
      .catch((error: unknown) => {
        writeStructuredEvent(
          this.logger,
          'error',
          'conversations.http.messages.failed',
          {
            requestId,
            conversationId,
            elapsedMs: Date.now() - startedAt,
            ...getSafeErrorLogFields(error),
          },
        );
        throw error;
      });
  }
}
