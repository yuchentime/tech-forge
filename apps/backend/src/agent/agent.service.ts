import { Injectable } from '@nestjs/common';
import {
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
} from '../llm/adapters/llm-adapter';
import { LlmService } from '../llm/llm.service';
import { projectAgentSessionEvent } from './agent-events';
import type { AgentStreamEvent } from './agent-events';

/** 负责单轮 Agent prompt，并将模型事件交给 LlmService 处理。 */
@Injectable()
export class AgentService {
  /** 注入共享的 LLM 调用能力。 */
  constructor(private readonly llm: LlmService) {}

  /** 使用固定 DeepSeek 模型流式转发经过筛选的 Pi 事件。 */
  async *stream(
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    const piEvents = this.llm.stream(prompt, {
      providerId: DEEPSEEK_PROVIDER_ID,
      modelId: DEEPSEEK_MODEL_ID,
      signal,
    });

    for await (const piEvent of piEvents) {
      const event = projectAgentSessionEvent(piEvent);
      if (event) yield event;
    }
  }
}
