import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Validates the editable DeepSeek model fields at the settings HTTP boundary. */
export class DeepseekSettingsInput {
  @IsString()
  @MaxLength(200)
  modelId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;
}

/** Validates the DeepSeek model form, the only supported provider. */
export class LlmSettingsInput {
  @IsDefined()
  @ValidateNested()
  @Type(() => DeepseekSettingsInput)
  deepseek!: DeepseekSettingsInput;
}

/** Validates a complete user-owned local settings update. */
export class SaveSettingsInput {
  /**
   * Legacy Agent output directory.
   *
   * The Agent now works inside each conversation's own directory, and the value is no longer
   * user-facing; an update that omits it keeps whatever is stored.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  workspacePath?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => LlmSettingsInput)
  llm!: LlmSettingsInput;

  @IsString()
  @MaxLength(131072)
  souls!: string;
}
