import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

/** One saved excerpt as the 学习笔记 page renders it. */
export interface FocusItemDto {
  id: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  /** 1-based position among the conversation's visible messages; display only. */
  messageIndex: number;
  quote: string;
  /** User-written study note; null when there is no note. */
  note: string | null;
  createdAt: string;
}

/** Validates one save request from the chat selection action. */
export class CreateFocusItemDto {
  @IsUUID('4')
  conversationId!: string;

  @IsUUID('4')
  messageId!: string;

  @IsString()
  quote!: string;

  @IsInt()
  @Min(1)
  messageIndex!: number;

  /** Study note written in the same dialog; omitted or blank means "no note". */
  @IsOptional()
  @IsString()
  note?: string;
}

/** Validates one note replacement; emptiness and length are enforced in the service. */
export class UpdateFocusItemNoteDto {
  @IsString()
  note!: string;
}
