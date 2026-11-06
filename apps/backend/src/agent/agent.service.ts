import { Injectable } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';

/** Owns one-turn Agent prompt execution and delegates model work to LlmService. */
@Injectable()
export class AgentService {
  /** Creates the Agent use case with the shared LLM capability. */
  constructor(private readonly llm: LlmService) {}

  /** Streams one prompt using the configured DeepSeek model and request signal. */
  stream(prompt: string, signal: AbortSignal): AsyncGenerator<string> {
    return this.llm.stream(prompt, {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      signal,
    });
  }
}
