import { ArrayMaxSize, IsArray, IsString, IsUUID } from 'class-validator';

/** Describes one sidebar row returned by the Conversation list API. */
export interface ConversationSummaryDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Describes one attachment referenced by a user message. */
export interface ConversationAttachmentDto {
  attachmentId: string;
  name: string;
}

/** Describes one visible text message with optional safe user-turn tool summaries. */
export interface ConversationMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  toolActivities?: ConversationToolActivityDto[];
  /** Attachments sent with this user message; empty for assistant rows. */
  attachments?: ConversationAttachmentDto[];
  /** Files this turn produced or rewrote; empty for user rows. */
  generatedFiles?: ConversationGeneratedFileDto[];
}

/** Describes one file a turn produced, as the response footer and sidebar need it. */
export interface ConversationGeneratedFileDto {
  id: string;
  fileName: string;
  contentFormat: string;
  /** True when the stored path no longer exists on disk. */
  missing: boolean;
  /** True when the user asked for a destination outside the session workspace. */
  external: boolean;
}

/** Describes a safe tool lifecycle summary attached to its initiating user message. */
export interface ConversationToolActivityDto {
  toolCallId: string;
  toolName: string;
  path?: string;
  /** Safe grep pattern, present only for knowledge/file searches. */
  pattern?: string;
  /** 1-based first line a `read` requested; used to tell repeated reads apart. */
  offset?: number;
  /** Requested line count for that `read`. */
  limit?: number;
  status: 'completed' | 'failed';
  durationMs?: number;
}

/** Describes the explicit knowledge scope of one conversation. */
export interface ConversationKnowledgeScopeDto {
  /** Documents this conversation may search; empty means the default range applies. */
  documentIds: string[];
}

/** Validates one conversation title replacement; length and emptiness are enforced in the service. */
export class RenameConversationDto {
  @IsString()
  title!: string;
}

/** Validates an explicit knowledge scope replacement. */
export class SetKnowledgeScopeDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  documentIds!: string[];
}

/** Describes the complete visible message history of one conversation. */
export interface ConversationMessagesDto {
  messages: ConversationMessageDto[];
}
