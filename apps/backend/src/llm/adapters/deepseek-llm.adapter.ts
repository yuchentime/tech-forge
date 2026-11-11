import { Injectable } from '@nestjs/common';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createOpenAiCompatibleModel,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_PROVIDER_ID,
  type PiProviderConfig,
  type DeepseekAdapterSettings,
} from './llm-adapter';

/** Registers the selected DeepSeek model from user-owned local settings. */
@Injectable()
export class DeepseekLLMAdapter {
  /** Adds the configured DeepSeek credentials and model to one Pi runtime. */
  register(runtime: ModelRuntime, settings: DeepseekAdapterSettings): void {
    const config: PiProviderConfig = {
      name: 'DeepSeek',
      baseUrl: DEEPSEEK_BASE_URL,
      api: 'openai-completions',
      apiKey: settings.apiKey,
      models: [createOpenAiCompatibleModel(settings.modelId, settings.modelId)],
    };
    runtime.registerProvider(DEEPSEEK_PROVIDER_ID, config);
  }
}
