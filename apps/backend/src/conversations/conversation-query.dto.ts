import { IsOptional, IsUUID } from 'class-validator';

/** Describes one sidebar row returned by the Conversation list API. */
export interface ConversationSummaryDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Describes one visible text message with optional safe user-turn tool summaries. */
export interface ConversationMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  toolActivities?: ConversationToolActivityDto[];
}

/** Describes a safe tool lifecycle summary attached to its initiating user message. */
export interface ConversationToolActivityDto {
  toolCallId: string;
  toolName: string;
  path?: string;
  status: 'completed' | 'failed';
  durationMs?: number;
}

/** Describes one bounded visible-message page and whether an older page exists. */
export interface ConversationMessagePageDto {
  messages: ConversationMessageDto[];
  hasMore: boolean;
}

/** Validates the optional same-conversation message cursor for history paging. */
export class ConversationMessagesQueryDto {
  @IsOptional()
  @IsUUID('4')
  beforeMessageId?: string;
}
