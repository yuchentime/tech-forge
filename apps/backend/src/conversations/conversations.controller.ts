import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConversationsService } from './conversations.service';
import type {
  ConversationKnowledgeScopeDto,
  ConversationMessagePageDto,
  ConversationSummaryDto,
} from './conversation-query.dto';
import {
  ConversationMessagesQueryDto,
  SetKnowledgeScopeDto,
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

  /** Returns one bounded visible-message page for an existing UUIDv4 conversation. */
  @Get(':conversationId/messages')
  getMessages(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
    @Query() query: ConversationMessagesQueryDto,
  ): Promise<ConversationMessagePageDto> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    writeStructuredEvent(
      this.logger,
      'log',
      'conversations.http.messages.accepted',
      { requestId, conversationId, hasCursor: Boolean(query.beforeMessageId) },
    );
    return this.conversations
      .getConversationMessages(conversationId, query.beforeMessageId, {
        requestId,
        conversationId,
      })
      .then((result) => {
        writeStructuredEvent(
          this.logger,
          'log',
          'conversations.http.messages.completed',
          {
            requestId,
            conversationId,
            messageCount: result.messages.length,
            hasMore: result.hasMore,
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

  /** Returns which documents this conversation may search. */
  @Get(':conversationId/knowledge-scope')
  async getKnowledgeScope(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) conversationId: string,
  ): Promise<ConversationKnowledgeScopeDto> {
    return this.conversations.getKnowledgeScope(conversationId);
  }

  /** Replaces the explicit knowledge scope; an empty list restores the default range. */
  @Put(':conversationId/knowledge-scope')
  async setKnowledgeScope(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) conversationId: string,
    @Body() input: SetKnowledgeScopeDto,
  ): Promise<ConversationKnowledgeScopeDto> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    writeStructuredEvent(this.logger, 'log', 'conversations.http.knowledge_scope.accepted', {
      requestId,
      conversationId,
      documentCount: input.documentIds.length,
    });
    try {
      const result = await this.conversations.setKnowledgeScope(
        conversationId,
        input.documentIds,
        { requestId, conversationId },
      );
      writeStructuredEvent(this.logger, 'log', 'conversations.http.knowledge_scope.completed', {
        requestId,
        conversationId,
        documentCount: result.documentIds.length,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        'error',
        'conversations.http.knowledge_scope.failed',
        {
          requestId,
          conversationId,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    }
  }
}
