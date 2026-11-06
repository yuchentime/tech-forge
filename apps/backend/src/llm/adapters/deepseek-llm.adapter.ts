import { Injectable } from '@nestjs/common';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createOpenAiCompatibleModel,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  type LLMAdapter,
  type PiProviderConfig,
} from './llm-adapter';

const DEFAULT_MODEL_ID = 'deepseek-chat';

@Injectable()
export class DeepseekLLMAdapter implements LLMAdapter {
  readonly providerId = DEEPSEEK_PROVIDER_ID;
  private readonly apiKey = process.env.DEEPSEEK_API_KEY;

  register(runtime: ModelRuntime): void {
    const config: PiProviderConfig = {
      name: 'DeepSeek',
      baseUrl: DEEPSEEK_BASE_URL,
      api: 'openai-completions',
      apiKey: this.apiKey ?? '',
      models: [createOpenAiCompatibleModel(DEFAULT_MODEL_ID, 'DeepSeek Chat')],
    };
    runtime.registerProvider(this.providerId, config);
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getConfigurationError(): string | undefined {
    return this.isConfigured()
      ? undefined
      : 'Set DEEPSEEK_API_KEY to use the DeepSeek provider.';
  }
}
