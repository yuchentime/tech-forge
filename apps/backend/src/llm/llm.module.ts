import { Module } from '@nestjs/common';
import { CustomLLMAdapter } from './adapters/custom-llm.adapter';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { LlmService } from './llm.service';

@Module({ providers: [LlmService, DeepseekLLMAdapter, CustomLLMAdapter] })
export class LlmModule {}
