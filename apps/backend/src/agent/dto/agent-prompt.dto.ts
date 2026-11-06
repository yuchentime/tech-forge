import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Defines and normalizes the prompt accepted by the one-turn Agent endpoint. */
export class AgentPromptDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  prompt!: string;
}
