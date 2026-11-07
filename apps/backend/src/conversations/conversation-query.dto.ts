/** Describes one sidebar row returned by the Conversation list API. */
export interface ConversationSummaryDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Describes one visible, text-only user or assistant history message. */
export interface ConversationMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'failed' | 'cancelled';
  createdAt: string;
}
