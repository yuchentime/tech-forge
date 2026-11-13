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

/**
 * Documented context length for both DeepSeek model ids (模型 & 价格 page: 1M). The decimal
 * value understates the window if it is really 1,048,576, so Pi compacts slightly early instead
 * of sending a request the provider would reject.
 */
const DEEPSEEK_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * DeepSeek's own output ceiling when `max_tokens` is unset, per the Chat Completions reference:
 * 64K in thinking mode (8K without thinking, 128K when `reasoning_effort=max`). Sessions here let
 * DeepSeek pick the mode, so 64K is the ceiling the provider itself would apply.
 *
 * The field must stay explicit: Pi always sends `max_tokens` — `buildBaseOptions()` resolves it
 * from `options.maxTokens ?? model.maxTokens`, and a model definition without `maxTokens` silently
 * becomes the SDK default 16,384. Omitting it here would therefore impose a cap smaller than the
 * provider default, not defer to the provider. A reasoning-and-tool turn can spend most of the cap
 * on thinking, so a small value truncates tool arguments before they are written.
 */
const DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

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
    contextWindow: DEEPSEEK_CONTEXT_WINDOW_TOKENS,
    maxTokens: DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}
