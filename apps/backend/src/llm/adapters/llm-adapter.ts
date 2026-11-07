import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** Connects one provider's configuration to the Pi SDK model runtime. */
export interface LLMAdapter {
  readonly providerId: string;
  register(runtime: ModelRuntime): void;
  isConfigured(): boolean;
  getConfigurationError(): string | undefined;
}

export type PiProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_PROVIDER_ID = 'deepseek';
export const DEEPSEEK_MODEL_ID = 'deepseek-flash';
export const CUSTOM_PROVIDER_ID = 'custom';

const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function createOpenAiCompatibleModel(
  id: string,
  name: string,
): NonNullable<PiProviderConfig['models']>[number] {
  return {
    id,
    name,
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    cost: defaultCost,
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
