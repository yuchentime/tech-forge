import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** Supplies model fields used to register the DeepSeek OpenAI-compatible API. */
export interface DeepseekAdapterSettings {
  modelId: string;
  apiKey: string;
}

export type PiProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_PROVIDER_ID = 'deepseek';
export const DEEPSEEK_MODEL_ID = 'deepseek-flash';

const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Builds the Pi model descriptor for one OpenAI-compatible chat completion model. */
export function createOpenAiCompatibleModel(
  id: string,
  name: string,
): NonNullable<PiProviderConfig['models']>[number] {
  return {
    id,
    name,
    api: 'openai-completions',
    reasoning: false,
    input: ['text', 'image'],
    cost: defaultCost,
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
