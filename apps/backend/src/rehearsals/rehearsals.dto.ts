import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MAX_ANSWER_LENGTH,
  MAX_PERSONA_LENGTH,
} from './rehearsal.constants';

/** Starts one rehearsal batch from the current conversation. */
export class StartRehearsalDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PERSONA_LENGTH)
  persona?: string;

  @IsUUID('4')
  startRequestId!: string;
}

/** Submits one answer for the current question. */
export class AnswerRehearsalDto {
  @IsUUID('4')
  turnId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ANSWER_LENGTH)
  answer!: string;

  @IsUUID('4')
  answerRequestId!: string;
}

/** Skips the current question without evaluating it. */
export class SkipRehearsalDto {
  @IsUUID('4')
  turnId!: string;
}

/** Reads one page of rehearsal history for a conversation. */
export class ListRehearsalsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsUUID('4')
  cursor?: string;

  @IsOptional()
  @IsIn(['all', 'active', 'completed', 'failed'])
  status?: 'all' | 'active' | 'completed' | 'failed';
}

/** Saves the student persona shared by every conversation's drill. */
export class SaveRehearsalPersonaDto {
  @IsString()
  @MaxLength(MAX_PERSONA_LENGTH)
  persona!: string;
}
