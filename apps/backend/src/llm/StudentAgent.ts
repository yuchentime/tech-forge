import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import {
  createCleanPiSession,
  resolvePiAgentEnvironment,
  runPiTurn,
  type PiTurnOptions,
} from './pi-agent-runtime';
import { SettingsService } from '../settings/settings.service';

/** Options for one student turn. */
export interface StudentAgentRunOptions extends PiTurnOptions {
  requestId?: string;
}

/** One student agent bound to a fixed persona prompt. */
export interface StudentAgentInstance {
  run(userPrompt: string, options?: StudentAgentRunOptions): Promise<string>;
}

/**
 * Creates the student agents a classroom simulation talks to.
 *
 * Each instance owns one persona prompt and opens a fresh, tool-less Pi session per turn: a
 * student has no cross-turn state to keep (the classroom transcript is supplied as prompt text),
 * and a disposed session must never be reused. Student turns never use a thinking level: the task
 * is one short, in-character sentence.
 */
@Injectable()
export class StudentAgent {
  private readonly logger = new Logger(StudentAgent.name);

  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Creates one student agent whose every turn uses `systemPrompt` unchanged.
   *
   * Creation is synchronous and does not touch the provider; DeepSeek settings are read when the
   * agent actually speaks, so a dispatched-but-silent student costs nothing.
   */
  createAgent(systemPrompt: string): StudentAgentInstance {
    const personaPrompt = systemPrompt.trim();
    if (!personaPrompt) {
      throw new Error('Student agent requires a non-empty system prompt.');
    }

    const adapter = this.deepseekAdapter;
    const settings = this.settings;
    const logger = this.logger;

    return {
      async run(
        userPrompt: string,
        options: StudentAgentRunOptions = {},
      ): Promise<string> {
        const prompt = userPrompt.trim();
        if (!prompt) {
          throw new Error('Student agent requires a non-empty prompt.');
        }

        const requestId = options.requestId ?? randomUUID();
        const startedAt = Date.now();
        let session: PiAgentSession | undefined;

        try {
          const environment = await resolvePiAgentEnvironment(adapter, settings);
          session = await createCleanPiSession(environment, personaPrompt, 'off');
          const text = await runPiTurn(session, prompt, options);
          logger.log({
            event: 'classroom.student.completed',
            requestId,
            resultLength: Array.from(text).length,
            elapsedMs: Date.now() - startedAt,
          });
          return text;
        } catch (error) {
          logger.error({
            event: 'classroom.student.failed',
            requestId,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          try {
            session?.dispose();
          } catch (error) {
            logger.error({
              event: 'classroom.student.dispose.failed',
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    };
  }
}
