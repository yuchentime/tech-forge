import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Defines and normalizes prompt and optional conversation identity for Agent. */
export class AgentPromptDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  prompt!: string;

  @IsOptional()
  @IsUUID('4')
  conversationId?: string;
}
