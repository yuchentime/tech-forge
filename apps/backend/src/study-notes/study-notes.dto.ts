import { IsOptional, IsString, IsUUID } from 'class-validator';

/** One user-written note as the 学习笔记 page renders it. */
export interface StudyNoteDto {
  id: string;
  /** Conversation the note refers to; null when the note stands alone. */
  conversationId: string | null;
  /** Current conversation title; null without a conversation. */
  conversationTitle: string | null;
  content: string;
  createdAt: string;
}

/** Validates one manual note submitted from the add-note dialog. */
export class CreateStudyNoteDto {
  @IsString()
  content!: string;

  /** Optional conversation the note belongs to; omitted means "no conversation". */
  @IsOptional()
  @IsUUID('4')
  conversationId?: string;
}
