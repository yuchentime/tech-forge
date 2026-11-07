import { Injectable } from '@nestjs/common';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createOpenAiCompatibleModel,
  CUSTOM_PROVIDER_ID,
  type LLMAdapter,
  type PiProviderConfig,
  type CustomAdapterSettings,
} from './llm-adapter';

/** Registers one user-defined OpenAI-compatible provider in a Pi runtime. */
@Injectable()
export class CustomLLMAdapter implements LLMAdapter<CustomAdapterSettings> {
  readonly providerId = CUSTOM_PROVIDER_ID;

  /** Validates and registers the supplied endpoint, name, key and model ID. */
  register(runtime: ModelRuntime, settings: CustomAdapterSettings): void {
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(settings.baseUrl);
    } catch {
      throw new Error('Custom provider Base URL must be a valid HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
      throw new Error('Custom provider Base URL must use HTTP or HTTPS.');
    }

    const config: PiProviderConfig = {
      name: settings.name,
      baseUrl: parsedBaseUrl.toString().replace(/\/$/, ''),
      api: 'openai-completions',
      apiKey: settings.apiKey || 'not-needed',
      models: [createOpenAiCompatibleModel(settings.modelId, settings.modelId)],
    };
    runtime.registerProvider(this.providerId, config);
  }
}
