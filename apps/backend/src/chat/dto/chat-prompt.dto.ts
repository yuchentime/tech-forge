import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Defines and normalizes prompt and optional conversation identity for Chat. */
export class ChatPromptDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  prompt!: string;

  @IsOptional()
  @IsUUID('4')
  conversationId?: string;
}
