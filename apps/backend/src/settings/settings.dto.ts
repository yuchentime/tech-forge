import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
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

/** Validates one OpenAI-compatible provider's name, endpoint, model and key. */
export class CustomSettingsInput {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(2048)
  baseUrl!: string;

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

/** Validates the current Provider selection and both Provider form snapshots. */
export class LlmSettingsInput {
  @IsIn(['deepseek', 'custom'])
  provider!: 'deepseek' | 'custom';

  @IsDefined()
  @ValidateNested()
  @Type(() => DeepseekSettingsInput)
  deepseek!: DeepseekSettingsInput;

  @IsDefined()
  @ValidateNested()
  @Type(() => CustomSettingsInput)
  custom!: CustomSettingsInput;
}

/** Validates a complete user-owned local settings update. */
export class SaveSettingsInput {
  @IsString()
  @MaxLength(4096)
  workspacePath!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => LlmSettingsInput)
  llm!: LlmSettingsInput;

  @IsString()
  @MaxLength(131072)
  souls!: string;
}
