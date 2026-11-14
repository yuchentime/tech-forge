import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
} from '../../logging/structured-logger';
import {
  classifyAssistantCompletion,
  composeModelPrompt,
  getProviderRejectionLogFields,
  getRequestLogContext,
  logPiCompactionEvent,
  PiAgentRuntime,
  readClassifiedAssistantText,
  type LlmGenerateOptions,
} from '../pi-agent-runtime';

/** Owns the request lifecycle for independent, non-streamed model calls. */
@Injectable()
export class OneShotLlmAgent {
  private readonly logger = new Logger(OneShotLlmAgent.name);

  /** Injects the runtime used to resolve request settings and create Pi sessions. */
  constructor(private readonly piAgentRuntime: PiAgentRuntime) {}

  /** Runs one non-streamed model call and returns the classified assistant text. */
  async generate(
    prompt: string,
    options: LlmGenerateOptions = {},
  ): Promise<string> {
    const requestId = options.requestId ?? randomUUID();
    const logContext = getRequestLogContext(options, requestId);
    const startedAt = Date.now();
    let phase = 'session_create';
    let timedOut = false;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    let session: PiAgentSession | undefined;
    let unsubscribeSessionEvents: (() => void) | undefined;

    writeStructuredEvent(this.logger, 'log', 'llm.generate.started', {
      ...logContext,
      promptLength: Array.from(prompt).length,
      historyMessageCount: options.conversation?.history.length ?? 0,
    });
    // Phase reporting is diagnostic; a faulty callback must never break generation.
    const reportPhase = (reportedPhase: 'session' | 'provider'): void => {
      try {
        options.onPhase?.(reportedPhase);
      } catch {
        // Ignore: the caller's UI hint is not part of the call contract.
      }
    };

    try {
      reportPhase('session');
      const { resolved, modelSettings } = await this.piAgentRuntime.resolveRequest(options);
      let resolvedContextWindow: number | null = null;
      session = await this.piAgentRuntime.createSession(resolved, modelSettings, undefined, {
        systemPromptAppend: options.systemPromptAppend,
        tools: options.tools,
        loadMemory: options.loadMemory ?? false,
        // Internal JSON calls must never spend Search/Fetch budget.
        webTools: false,
        onModelResolved: (contextWindow) => {
          resolvedContextWindow = contextWindow;
        },
      });
      const activeSession = session;
      unsubscribeSessionEvents = activeSession.subscribe((event) =>
        logPiCompactionEvent(this.logger, logContext, activeSession, event),
      );

      const abortController = new AbortController();
      const aborted = Promise.withResolvers<never>();
      const abortSession = (): void => {
        if (abortController.signal.aborted) return;
        abortController.abort();
        void session?.abort().catch((error: unknown) => {
          writeStructuredEvent(this.logger, 'error', 'llm.generate.abort.failed', {
            ...logContext,
            ...getSafeErrorLogFields(error),
          });
        });
      };
      const onAbortSignal = (): void => {
        aborted.reject(
          new Error(
            timedOut ? 'LLM generation timed out.' : 'LLM generation cancelled.',
          ),
        );
      };
      abortController.signal.addEventListener('abort', onAbortSignal, {
        once: true,
      });
      options.signal?.addEventListener('abort', abortSession, { once: true });
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            abortSession();
          }, options.timeoutMs)
        : undefined;

      try {
        if (options.signal?.aborted) abortSession();
        phase = 'provider_run';
        reportPhase('provider');
        const modelPrompt = options.buildPrompt
          ? options.buildPrompt({ contextWindow: resolvedContextWindow })
          : composeModelPrompt(prompt, options.promptContext);
        const run = session.prompt(modelPrompt, { expandPromptTemplates: false });
        // The abort race may settle first; keep the provider promise from becoming unhandled.
        void run.catch(() => undefined);
        await Promise.race([run, aborted.promise]);

        if (timedOut) {
          throw new Error('LLM generation timed out.');
        }
        if (options.signal?.aborted || abortController.signal.aborted) {
          throw new Error('LLM generation cancelled.');
        }

        const completion = classifyAssistantCompletion(
          session.messages,
          session.getLastAssistantText(),
        );
        if (completion.kind === 'cancelled') {
          throw new Error('LLM generation cancelled.');
        }
        const text = readClassifiedAssistantText(completion);
        outcome = 'completed';
        writeStructuredEvent(this.logger, 'log', 'llm.generate.completed', {
          ...logContext,
          resultLength: Array.from(text).length,
          elapsedMs: Date.now() - startedAt,
        });
        return text;
      } finally {
        clearTimeout(timer);
        abortController.signal.removeEventListener('abort', onAbortSignal);
        options.signal?.removeEventListener('abort', abortSession);
      }
    } catch (error) {
      outcome = options.signal?.aborted ? 'cancelled' : 'failed';
      writeStructuredEvent(
        this.logger,
        outcome === 'cancelled' ? 'warn' : 'error',
        outcome === 'cancelled'
          ? 'llm.generate.cancelled'
          : 'llm.generate.failed',
        {
          ...logContext,
          phase: timedOut ? 'timeout' : phase,
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
          ...getProviderRejectionLogFields(error),
        },
      );
      throw error;
    } finally {
      unsubscribeSessionEvents?.();
      if (session) {
        try {
          session.dispose();
        } catch (error) {
          writeStructuredEvent(
            this.logger,
            'error',
            'llm.session.dispose.failed',
            { ...logContext, ...getSafeErrorLogFields(error) },
          );
        }
      }
      writeStructuredEvent(
        this.logger,
        outcome === 'completed'
          ? 'log'
          : outcome === 'cancelled'
            ? 'warn'
            : 'error',
        'llm.generate.terminated',
        {
          ...logContext,
          outcome,
          phase: timedOut ? 'timeout' : phase,
          elapsedMs: Date.now() - startedAt,
        },
      );
    }
  }
}
