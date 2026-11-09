import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One file attached to this message: a client-side id plus the picked path. */
export class ChatAttachmentDto {
  @IsUUID('4')
  attachmentId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  path!: string;
}

/** Defines and normalizes prompt, conversation identity and attachments for one Chat turn. */
export class ChatPromptDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  prompt!: string;

  @IsOptional()
  @IsUUID('4')
  conversationId?: string;

  /**
   * Files attached to this message.
   *
   * Only paths travel: the backend copies each file into the conversation's session directory and
   * extracts the text itself, so the renderer never sends file bytes or document text.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ChatAttachmentDto)
  attachments?: ChatAttachmentDto[];
}
