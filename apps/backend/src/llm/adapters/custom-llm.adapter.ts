import { Injectable } from '@nestjs/common';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createOpenAiCompatibleModel,
  CUSTOM_PROVIDER_ID,
  type LLMAdapter,
  type PiProviderConfig,
} from './llm-adapter';

@Injectable()
export class CustomLLMAdapter implements LLMAdapter {
  readonly providerId = CUSTOM_PROVIDER_ID;
  private readonly baseUrl = process.env.CUSTOM_LLM_BASE_URL?.trim();
  private readonly apiKey = process.env.CUSTOM_LLM_API_KEY?.trim();
  private readonly modelId = process.env.CUSTOM_LLM_MODEL?.trim() || 'custom-model';

  register(runtime: ModelRuntime): void {
    if (!this.baseUrl) return;

    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(this.baseUrl);
    } catch {
      throw new Error('CUSTOM_LLM_BASE_URL must be a valid HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
      throw new Error('CUSTOM_LLM_BASE_URL must use HTTP or HTTPS.');
    }

    const config: PiProviderConfig = {
      name: 'Custom OpenAI-compatible API',
      baseUrl: parsedBaseUrl.toString().replace(/\/$/, ''),
      api: 'openai-completions',
      apiKey: this.apiKey || 'not-needed',
      models: [createOpenAiCompatibleModel(this.modelId, this.modelId)],
    };
    runtime.registerProvider(this.providerId, config);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  getConfigurationError(): string | undefined {
    return this.isConfigured()
      ? undefined
      : 'Set CUSTOM_LLM_BASE_URL to use the custom OpenAI-compatible provider.';
  }
}
