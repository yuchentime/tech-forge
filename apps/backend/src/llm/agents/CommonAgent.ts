import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent as PiAgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  clipLogText,
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../../logging/structured-logger';
import {
  PiAgentRuntime,
  getRequestLogContext,
} from '../pi-agent-runtime';
import type { LlmRequestOptions as CommonLlmRequestOptions } from '../llm-contracts';
export type {
  LlmConversationContext,
  LlmConversationHistoryMessage,
  LlmInputImage,
  LlmRequestOptions,
  LlmStreamOptions,
  PiThinkingLevel,
} from '../llm-contracts';

/**
 * Raised when the provider stopped on its output-token limit.
 *
 * DeepSeek counts reasoning tokens against that limit, so a reasoning model can spend the whole
 * budget before emitting visible text. Callers must report a truncated answer instead of
 * treating the empty text as a broken provider response.
 */
export class LlmResponseTruncatedError extends Error {
  constructor() {
    super("Provider stopped at the output token limit before returning assistant text.");
    this.name = "LlmResponseTruncatedError";
  }
}

/**
 * Raised when the provider answered the run with an error instead of a completion.
 *
 * Pi records that answer as an assistant message with `stopReason: "error"` and the provider's
 * text in `errorMessage`, then settles the run normally. Without reading the message first, the
 * empty content looks like a broken model and the actual cause (a rejected request) is invisible.
 */
export class LlmProviderRejectedError extends Error {
  constructor(readonly providerMessage: string) {
    super(
      providerMessage.trim() ||
        "Provider rejected the request without an error message.",
    );
    this.name = "LlmProviderRejectedError";
  }
}

/** Classifies the latest assistant message once a Pi run has settled. */
export type AssistantCompletion =
  | { kind: "text"; text: string }
  | { kind: "truncated" }
  | { kind: "cancelled" }
  | { kind: "rejected"; providerMessage: string }
  | { kind: "empty" };

/**
 * Options for one non-streamed generation.
 *
 * Rehearsal planning, answer decisions and reports are JSON calls, not chat turns. They may read a
 * parent conversation's history, but they never persist a Pi snapshot or a conversation message.
 */
export interface LlmGenerateOptions extends CommonLlmRequestOptions {
  signal?: AbortSignal;
  /** Replaces the default chat system-prompt append; rehearsal passes its fixed drill prompt. */
  systemPromptAppend?: string;
  /** Explicit tool allowlist; rehearsal passes an empty array. */
  tools?: readonly string[];
  /**
   * Whether long-term memory is loaded for this call.
   *
   * `generate()` is used for internal JSON work (rehearsal, knowledge facts), so it defaults to
   * `false`; chat `stream()` defaults to `true` in `PiAgentRuntime.createSession()`.
   */
  loadMemory?: boolean;
  /** Abort the provider call after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Reports the coarse phase of this call before each expensive step.
   *
   * Rehearsal uses it to name what the preparing screen is waiting on; chat never passes it.
   * The callback is diagnostic only and must not influence the call.
   */
  onPhase?: (phase: "session" | "provider") => void;
  /**
   * Builds the final user prompt after the provider/model for this call has been resolved.
   *
   * The callback receives the same context window used by the created session, so callers can
   * budget the prompt against the actual model instead of reading settings a second time. Throwing
   * fails the call before the provider runs. Existing string-only callers keep passing `prompt`.
   */
  buildPrompt?: (context: { contextWindow: number | null }) => string;
}

/**
 * Runs non-streamed model calls through the shared Pi runtime.
 *
 * Session setup, tools, extensions, skills, restoration and snapshots belong to PiAgentRuntime;
 * this class owns the common generate-call lifecycle and classifies the returned completion.
 */
@Injectable()
export class CommonAgent {
  private readonly logger = new Logger(CommonAgent.name);

  /** Injects the Pi runtime used by every common generation call. */
  constructor(private readonly piAgentRuntime: PiAgentRuntime) {}

  /** Runs one non-streamed model call and returns the classified assistant text. */
  async generate(
    prompt: string,
    options: LlmGenerateOptions = {},
  ): Promise<string> {
    const requestId = options.requestId ?? randomUUID();
    const logContext = getRequestLogContext(options, requestId);
    const startedAt = Date.now();
    let phase = "session_create";
    let timedOut = false;
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let session: PiAgentSession | undefined;
    let unsubscribeSessionEvents: (() => void) | undefined;

    writeStructuredEvent(this.logger, "log", "llm.generate.started", {
      ...logContext,
      promptLength: Array.from(prompt).length,
      historyMessageCount: options.conversation?.history.length ?? 0,
    });
    // Phase reporting is diagnostic; a faulty callback must never break generation.
    const reportPhase = (phase: 'session' | 'provider'): void => {
      try {
        options.onPhase?.(phase);
      } catch {
        // Ignore: the caller's UI hint is not part of the call contract.
      }
    };

    try {
      reportPhase("session");
      const { resolved, modelSettings } =
        await this.piAgentRuntime.resolveRequest(options);
      let resolvedContextWindow: number | null = null;
      session = await this.piAgentRuntime.createSession(
        resolved,
        modelSettings,
        undefined,
        {
          systemPromptAppend: options.systemPromptAppend,
          tools: options.tools,
          loadMemory: options.loadMemory ?? false,
          // Internal JSON calls must never spend Search/Fetch budget.
          webTools: false,
          onModelResolved: (contextWindow) => {
            resolvedContextWindow = contextWindow;
          },
        },
      );
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
          writeStructuredEvent(this.logger, "error", "llm.generate.abort.failed", {
            ...logContext,
            ...getSafeErrorLogFields(error),
          });
        });
      };
      const onAbortSignal = (): void => {
        aborted.reject(
          new Error(
            timedOut ? "LLM generation timed out." : "LLM generation cancelled.",
          ),
        );
      };
      abortController.signal.addEventListener("abort", onAbortSignal, {
        once: true,
      });
      options.signal?.addEventListener("abort", abortSession, { once: true });
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            abortSession();
          }, options.timeoutMs)
        : undefined;

      try {
        if (options.signal?.aborted) abortSession();
        phase = "provider_run";
        reportPhase("provider");
        const modelPrompt = options.buildPrompt
          ? options.buildPrompt({ contextWindow: resolvedContextWindow })
          : composeModelPrompt(prompt, options.promptContext);
        const run = session.prompt(modelPrompt, { expandPromptTemplates: false });
        // The abort race may settle first; keep the provider promise from becoming unhandled.
        void run.catch(() => undefined);
        await Promise.race([run, aborted.promise]);

        if (timedOut) {
          throw new Error("LLM generation timed out.");
        }
        if (options.signal?.aborted || abortController.signal.aborted) {
          throw new Error("LLM generation cancelled.");
        }

        const completion = classifyAssistantCompletion(
          session.messages,
          session.getLastAssistantText(),
        );
        if (completion.kind === "cancelled") {
          throw new Error("LLM generation cancelled.");
        }
        const text = this.readAssistantText(completion);
        outcome = "completed";
        writeStructuredEvent(this.logger, "log", "llm.generate.completed", {
          ...logContext,
          resultLength: Array.from(text).length,
          elapsedMs: Date.now() - startedAt,
        });
        return text;
      } finally {
        clearTimeout(timer);
        abortController.signal.removeEventListener("abort", onAbortSignal);
        options.signal?.removeEventListener("abort", abortSession);
      }
    } catch (error) {
      outcome = options.signal?.aborted ? "cancelled" : "failed";
      writeStructuredEvent(
        this.logger,
        outcome === "cancelled" ? "warn" : "error",
        outcome === "cancelled"
          ? "llm.generate.cancelled"
          : "llm.generate.failed",
        {
          ...logContext,
          phase: timedOut ? "timeout" : phase,
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
            "error",
            "llm.session.dispose.failed",
            { ...logContext, ...getSafeErrorLogFields(error) },
          );
        }
      }
      writeStructuredEvent(
        this.logger,
        outcome === "completed"
          ? "log"
          : outcome === "cancelled"
            ? "warn"
            : "error",
        "llm.generate.terminated",
        {
          ...logContext,
          outcome,
          phase: timedOut ? "timeout" : phase,
          elapsedMs: Date.now() - startedAt,
        },
      );
    }
  }

  /** Turns a settled completion into text and preserves useful provider failure types. */
  readAssistantText(
    completion: Exclude<AssistantCompletion, { kind: 'cancelled' }>,
  ): string {
    if (completion.kind === 'truncated') {
      throw new LlmResponseTruncatedError();
    }
    if (completion.kind === 'rejected') {
      throw new LlmProviderRejectedError(completion.providerMessage);
    }
    if (completion.kind === 'empty') {
      throw new Error('Pi SDK completed without returning assistant text.');
    }
    return completion.text;
  }
}

/**
 * Classifies the latest assistant message by its terminal stop reason before reading its text.
 *
 * Pi's own `getLastAssistantText()` skips only aborted messages with zero blocks, so a reasoning
 * model that stopped on `length` or `aborted` after a thinking block looks like an empty
 * completion. Reading the stop reason first keeps truncation and cancellation distinguishable.
 */
export function classifyAssistantCompletion(
  messages: PiAgentSession["messages"],
  text: string | undefined,
): AssistantCompletion {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (lastAssistant?.role === "assistant") {
    if (lastAssistant.stopReason === "aborted") return { kind: "cancelled" };
    if (lastAssistant.stopReason === "length") return { kind: "truncated" };
    if (lastAssistant.stopReason === "error") {
      return {
        kind: "rejected",
        providerMessage: lastAssistant.errorMessage ?? "",
      };
    }
  }
  if (!text?.trim()) return { kind: "empty" };
  return { kind: "text", text };
}

/** Adds the provider's rejection text, which explains a settled run with no assistant text. */
export function getProviderRejectionLogFields(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof LlmProviderRejectedError)) return {};
  return { providerErrorMessage: clipLogText(error.providerMessage, 600) };
}

/**
 * Logs Pi's compaction lifecycle with token metrics.
 *
 * Pi decides when to compact: threshold crossing, overflow recovery, or a manual `/compact`. This
 * app never calls `session.compact()`. The summary is an extra provider request that rewrites the
 * model context, so both the trigger and the failure must be visible to operators.
 */
export function logPiCompactionEvent(
  logger: Logger,
  logContext: RequestLogContext,
  session: PiAgentSession,
  event: PiAgentSessionEvent,
): void {
  if (event.type === "compaction_start") {
    const usage = session.getContextUsage();
    writeStructuredEvent(logger, "log", "llm.compaction.started", {
      ...logContext,
      reason: event.reason,
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      contextPercent: usage?.percent ?? null,
    });
    return;
  }
  if (event.type !== "compaction_end") return;

  const usage = session.getContextUsage();
  const fields = {
    ...logContext,
    reason: event.reason,
    aborted: event.aborted,
    willRetry: event.willRetry,
    tokensBefore: event.result?.tokensBefore ?? null,
    estimatedTokensAfter: event.result?.estimatedTokensAfter ?? null,
    summaryChars: event.result
      ? Array.from(event.result.summary).length
      : null,
    summaryUsageTotalTokens: event.result?.usage?.totalTokens ?? null,
    contextTokens: usage?.tokens ?? null,
    contextPercent: usage?.percent ?? null,
  };
  if (event.result) {
    writeStructuredEvent(logger, "log", "llm.compaction.completed", fields);
    return;
  }
  if (event.aborted) {
    writeStructuredEvent(logger, "warn", "llm.compaction.cancelled", fields);
    return;
  }
  // The raw provider message may echo payloads; only its size is safe to log.
  writeStructuredEvent(logger, "error", "llm.compaction.failed", {
    ...fields,
    errorMessageChars: event.errorMessage?.length ?? 0,
  });
}

/**
 * Prepends one turn's reference material to the user's own text.
 *
 * Context goes first and the question last, so the model reads the evidence and then the task; the
 * marker keeps the boundary explicit when the material is a long document.
 */
export function composeModelPrompt(prompt: string, context?: string): string {
  const material = context?.trim();
  if (!material) return prompt;
  return `${material}\n\n## 用户输入\n${prompt}`;
}
