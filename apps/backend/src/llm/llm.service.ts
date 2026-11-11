import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent as PiAgentSessionEvent,
  ExtensionFactory as PiExtensionFactory,
  ModelRuntime as PiModelRuntime,
  SessionMessageEntry as PiSessionMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DeepseekLLMAdapter } from "./adapters/deepseek-llm.adapter";
import { DEEPSEEK_PROVIDER_ID } from "./adapters/llm-adapter";
import {
  SettingsService,
  type StoredLlmSettings,
} from "../settings/settings.service";
import {
  createWorkspaceFileTools,
  prepareWorkspaceDirectory,
} from "./tools/workspace-file-tools";
import {
  areWebToolsEnabled,
  createWebTools,
  WEB_TOOL_NAMES,
} from "./tools/web-tools";
import {
  BUNDLED_SKILLS_ASSET_PATH,
  installBundledSkills,
} from "./skills";
import { parsePersistedPiMessage } from "../conversations/conversation-transcript";
import { PiSessionSnapshotsService } from "../conversations/pi-session-snapshots.service";
import { MemoryService } from "../memory/memory.service";
import { replaceInjectedUserText } from "./session-entries";
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from "../logging/structured-logger";
import { of } from "rxjs";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type BillionContextPi = typeof import("billion-context-pi");
type PiSubagents = typeof import("pi-subagents");
type PiThinkingLevel = "off" | "low" | "medium" | "high";
type PiModel = NonNullable<ReturnType<PiModelRuntime["getModel"]>>;

/** Describes one completed chat message used to restore an external transcript. */
export interface LlmConversationHistoryMessage {
  id: string;
  role: string;
  contentJson: string;
  status: string;
  createdAt: Date | string;
}

/** Supplies SQLite-owned conversation identity and history to a Pi session. */
export interface LlmConversationContext {
  id: string;
  history: readonly LlmConversationHistoryMessage[];
}

export interface LlmRequestOptions {
  requestId?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: PiThinkingLevel;
  conversation?: LlmConversationContext;
  persistConversationEvent?: (event: PiAgentSessionEvent) => Promise<void>;
  /**
   * Per-turn reference material (attachment text, knowledge chunks) composed by ChatService.
   *
   * It is prepended to the user message sent to the model, never to the system prompt: the system
   * prompt stays byte-identical across turns so provider prefix caching keeps working, and per-turn
   * data stays where it belongs. The stored transcript keeps only the user's own text — see
   * `replaceInjectedUserText`.
   */
  promptContext?: string;
  /**
   * Durable context appended to the Pi session as its own custom message entry.
   *
   * Unlike `promptContext`, this survives the snapshot cleanup: Pi keeps the entry, later turns
   * restore it, and the model reads it as a regular user message instead of the system prompt.
   * `display: false` keeps it out of the visible transcript, so callers must send it exactly once.
   */
  contextMessage?: { type: string; text: string };
  /** Ordered durable entries, kept outside the system prompt and visible user text. */
  contextMessages?: Array<{ type: string; text: string; details?: unknown }>;
  /**
   * Called after the Agent created or modified a file, with the resolved absolute path.
   *
   * The chat layer uses it to index artifacts; the LLM layer stays unaware of that store.
   */
  onFileWritten?: (input: {
    absolutePath: string;
    tool: "write" | "edit";
  }) => Promise<void> | void;
  /**
   * Pi skill expanded at the start of this turn's model prompt.
   *
   * The skill body becomes part of the user message, not the system prompt, so per-turn context
   * (attachments, knowledge chunks) can still follow it. The stored transcript and snapshot keep
   * the user's own text: the caller passes that text as `prompt`, while this option only changes
   * what the model reads. `createSession` fails loudly when the named skill is not discoverable.
   */
  skillName?: string;
}

/** Adds request-scoped cancellation to streamed LLM calls. */
export interface LlmStreamOptions extends LlmRequestOptions {
  signal?: AbortSignal;
}

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

/** Classifies the latest assistant message once a Pi run has settled. */
type AssistantCompletion =
  | { kind: "text"; text: string }
  | { kind: "truncated" }
  | { kind: "cancelled" }
  | { kind: "empty" };

/**
 * Options for one non-streamed generation.
 *
 * Rehearsal planning, answer decisions and reports are JSON calls, not chat turns. They may read a
 * parent conversation's history, but they never persist a Pi snapshot or a conversation message.
 */
export interface LlmGenerateOptions extends LlmRequestOptions {
  signal?: AbortSignal;
  /** Replaces the default chat system-prompt append; rehearsal passes its fixed drill prompt. */
  systemPromptAppend?: string;
  /** Explicit tool allowlist; rehearsal passes an empty array. */
  tools?: readonly string[];
  /**
   * Whether long-term memory is loaded for this call.
   *
   * `generate()` is used for internal JSON work (rehearsal, knowledge facts), so it defaults to
   * `false`; chat `stream()` defaults to `true` in `createSession()`.
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

/** Controls how one Pi session is assembled without changing business-level request options. */
interface PiSessionBuildOptions {
  systemPromptAppend?: string;
  tools?: readonly string[];
  /** Whether to register long-term memory tools; JSON-only calls pass `false`. */
  loadMemory?: boolean;
  /** Whether to register DeepSeek web tools; internal JSON calls pass `false`. */
  webTools?: boolean;
  /** Publishes the resolved model's context window to the caller that builds the prompt. */
  onModelResolved?: (contextWindow: number | null) => void;
}

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

// The backend is compiled as CommonJS while Pi publishes an ESM-only entry point.
const importPiSdk = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<PiSdk>;

/** Identifies which stored context the Pi session was rebuilt from. */
type SessionRestoreSource = "session_snapshot" | "rebuilt_history";

/** Supplies a valid zero-usage record for restored assistant text messages. */
function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

/** Registers awaited Pi event hooks so database commits precede later Pi work. */
function createConversationPersistenceExtension(
  persistEvent: (event: PiAgentSessionEvent) => Promise<void>,
): PiExtensionFactory {
  return (pi) => {
    pi.on("message_start", (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on("message_update", (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on("message_end", (event) => persistEvent(event as PiAgentSessionEvent));
    pi.on("tool_execution_start", (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on("tool_execution_update", (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on("tool_execution_end", (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
  };
}

@Injectable()
/** Provides shared model generation and streaming with request-scoped Pi sessions. */
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private piSdkPromise?: Promise<PiSdk>;
  /** One-shot seeding of bundled skills into `<configDir>/skills`; retried after a failure. */
  private installedSkillsPromise?: Promise<void>;

  /** Injects local settings, the DeepSeek adapter, and the per-conversation Pi snapshot store. */
  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly settings: SettingsService,
    private readonly piSessionSnapshots: PiSessionSnapshotsService,
    private readonly memory: MemoryService,
  ) {}

  /**
   * 按序产出 Pi session 事件，并在请求取消时中止底层 Pi run。
   * async generator 被调用时先返回生成器对象；只有消费者调用 next() 后，函数体才开始执行。
   * 每次 yield 会把一个事件交给消费者，并暂停在当前位置，等下一次 next() 再继续。
   */
  async *stream(
    prompt: string,
    options: LlmStreamOptions = {},
  ): AsyncGenerator<PiAgentSessionEvent> {
    const requestId = options.requestId ?? randomUUID();
    const logContext = getRequestLogContext(options, requestId);
    const startedAt = Date.now();
    const eventCounts = new Map<string, number>();
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    let phase = "session_create";
    if (options.signal?.aborted) {
      writeStructuredEvent(this.logger, "warn", "llm.stream.cancelled", {
        ...logContext,
        phase: "before_session_create",
        reason: "signal_already_aborted",
      });
      return;
    }
    writeStructuredEvent(this.logger, "log", "llm.stream.started", {
      ...logContext,
      promptLength: Array.from(prompt).length,
      historyMessageCount: options.conversation?.history.length ?? 0,
    });

    let activeSession: PiAgentSession | undefined;
    let hasPersistenceError = false;
    let persistenceError: unknown;
    let persistenceAbortPromise: Promise<void> | undefined;
    const persistConversationEvent = options.persistConversationEvent
      ? async (event: PiAgentSessionEvent): Promise<void> => {
          try {
            await options.persistConversationEvent!(event);
          } catch (error) {
            hasPersistenceError = true;
            persistenceError = error;
            writeStructuredEvent(
              this.logger,
              "error",
              "llm.persistence_event.failed",
              {
                ...logContext,
                eventType: event.type,
                ...getSafeErrorLogFields(error),
              },
            );
            if (!persistenceAbortPromise && activeSession) {
              try {
                persistenceAbortPromise = activeSession
                  .abort()
                  .catch((abortError: unknown) => {
                    writeStructuredEvent(
                      this.logger,
                      "error",
                      "llm.persistence_abort.failed",
                      {
                        ...logContext,
                        ...getSafeErrorLogFields(abortError),
                      },
                    );
                  });
              } catch (abortError) {
                writeStructuredEvent(
                  this.logger,
                  "error",
                  "llm.persistence_abort.failed",
                  {
                    ...logContext,
                    ...getSafeErrorLogFields(abortError),
                  },
                );
                persistenceAbortPromise = Promise.resolve();
              }
            }
            throw error;
          }
        }
      : undefined;
    let session: PiAgentSession;
    try {
      const modelSettings = await this.settings.getLlmSettings();
      options = {
        ...options,
        ...getSelectedModelIds(modelSettings),
      };
      session = await this.createSession(
        {
          ...options,
          requestId,
          persistConversationEvent,
        },
        modelSettings,
        prompt,
      );
    } catch (error) {
      writeStructuredEvent(this.logger, "error", "llm.stream.failed", {
        ...logContext,
        phase,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      writeStructuredEvent(this.logger, "error", "llm.stream.terminated", {
        ...logContext,
        outcome: "failed",
        phase,
        elapsedMs: Date.now() - startedAt,
        eventCounts: Object.fromEntries(eventCounts),
      });
      throw error;
    }
    activeSession = session;
    // events 是 Pi 事件生产者与异步生成器消费者之间的本轮缓冲队列。
    const events: PiAgentSessionEvent[] = [];
    // 只表示 session.prompt() 整次运行已结束或失败；结束后仍要把队列里的事件交完。
    let runSettled = false;
    let runError: unknown;
    let hasRunError = false;
    // 暂存当前 await 所对应的 Promise resolve；有新片段或运行结束时由 wake() 调用。
    let wakeConsumer: (() => void) | undefined;
    let unsubscribe = (): void => undefined;
    let abortPromise: Promise<void> | undefined;

    const wake = (): void => {
      // wake 不传递事件，只负责解除消费者的等待；事件仍保存在 events 队列中。
      const resume = wakeConsumer;
      wakeConsumer = undefined;
      resume?.();
    };

    /** 只中止一次 Pi run，并唤醒正在等待下一事件的生成器消费者。 */
    const abortSession = (): void => {
      if (!abortPromise) {
        try {
          abortPromise = session.abort().catch((error: unknown) => {
            writeStructuredEvent(this.logger, "error", "llm.abort.failed", {
              ...logContext,
              ...getSafeErrorLogFields(error),
            });
          });
        } catch (error) {
          writeStructuredEvent(this.logger, "error", "llm.abort.failed", {
            ...logContext,
            ...getSafeErrorLogFields(error),
          });
          abortPromise = Promise.resolve();
        }
      }
      wake();
    };

    try {
      phase = "subscribe";
      options.signal?.addEventListener("abort", abortSession, { once: true });
      if (options.signal?.aborted) {
        abortSession();
        return;
      }

      unsubscribe = session.subscribe((event) => {
        // Pi owns the compaction trigger (threshold, overflow recovery, or manual `/compact`).
        // Log it here because the summary is an extra provider request that changes model context.
        logPiCompactionEvent(this.logger, logContext, session, event);
        // 所有 Pi 事件按回调顺序入队；ChatService 随后决定哪些字段可以出站。
        if (hasPersistenceError) {
          wake();
          return;
        }
        eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
        events.push(event);
        wake();
      });

      // 先启动底层模型请求，它与下方消费队列的循环并行推进。
      // 请求成功或失败时都设置结束状态并唤醒循环，避免最后没有新片段时一直等待。
      phase = "provider_run";
      // Durable context goes in as a message entry, never into the system prompt or the user text:
      // Pi stores it in the session, so the snapshot restores it on later turns instead of the
      // caller re-sending it every time. Appended before the usage read so logs include its tokens.
      const contextEntries: Array<{ type: string; text: string; details?: unknown }> = [
        ...(options.contextMessage ? [{ ...options.contextMessage, details: undefined }] : []),
        ...(options.contextMessages ?? []),
      ];
      for (const contextEntry of contextEntries) {
        if (!contextEntry.text.trim()) continue;
        session.sessionManager.appendCustomMessageEntry(
          contextEntry.type,
          contextEntry.text.trim(),
          false,
          contextEntry.details,
        );
      }
      const startingContextUsage = session.getContextUsage();
      writeStructuredEvent(this.logger, "log", "llm.provider_run.started", {
        ...logContext,
        providerId: options.providerId,
        modelId: options.modelId,
        historyMessageCount: options.conversation?.history.length ?? 0,
        contextTokens: startingContextUsage?.tokens ?? null,
        contextWindow: startingContextUsage?.contextWindow ?? null,
        contextPercent: startingContextUsage?.percent ?? null,
        skillName: options.skillName ?? null,
      });
      // A skill command must be the first token for Pi to expand it. The per-turn context is part
      // of its arguments, so the model reads the skill first and then the evidence and user text.
      const composedPrompt = composeModelPrompt(prompt, options.promptContext);
      const modelPrompt = options.skillName
        ? `/skill:${options.skillName} ${composedPrompt}`
        : composedPrompt;
      const run = session.prompt(modelPrompt, {
        expandPromptTemplates: Boolean(options.skillName),
      }).then(
        () => {
          runSettled = true;
          wake();
        },
        (error: unknown) => {
          runError = error;
          hasRunError = true;
          runSettled = true;
          wake();
        },
      );

      // 运行尚未结束，或还有未交付事件时继续；这样能排空最后一批缓冲事件。
      while (!runSettled || events.length > 0) {
        if (options.signal?.aborted) {
          events.length = 0;
          break;
        }

        if (events.length > 0) {
          // yield 将一个 Pi 事件交给 ChatService；消费方处理后再调用 next() 继续。
          yield events.shift()!;
          continue;
        }

        // 队列暂时为空时挂起本生成器（不会阻塞 JS 线程）。
        // Promise executor 会立即把 resolve 保存到 wakeConsumer；新事件到达后 wake() 调用它，
        // await 才会恢复并重新检查队列。这里保存 resolve 而不调用它，所以不会立刻继续循环。
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }

      await run;
      if (hasPersistenceError) {
        throw persistenceError;
      }
      if (options.signal?.aborted) {
        outcome = "cancelled";
        return;
      }
      if (hasRunError) {
        throw runError;
      }

      const completion = classifyAssistantCompletion(
        session.messages,
        session.getLastAssistantText(),
      );
      if (completion.kind === "cancelled") {
        outcome = "cancelled";
        writeStructuredEvent(this.logger, "warn", "llm.stream.cancelled", {
          ...logContext,
          phase,
          eventCounts: Object.fromEntries(eventCounts),
          elapsedMs: Date.now() - startedAt,
          reason: "assistant_run_aborted",
        });
        return;
      }
      const responseText = this.readAssistantText(completion);
      outcome = "completed";
      const finishedContextUsage = session.getContextUsage();
      writeStructuredEvent(this.logger, "log", "llm.stream.completed", {
        ...logContext,
        resultLength: Array.from(responseText).length,
        eventCounts: Object.fromEntries(eventCounts),
        contextTokens: finishedContextUsage?.tokens ?? null,
        contextPercent: finishedContextUsage?.percent ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      outcome = options.signal?.aborted ? "cancelled" : "failed";
      writeStructuredEvent(
        this.logger,
        outcome === "cancelled" ? "warn" : "error",
        outcome === "cancelled" ? "llm.stream.cancelled" : "llm.stream.failed",
        {
          ...logContext,
          phase,
          eventCounts: Object.fromEntries(eventCounts),
          elapsedMs: Date.now() - startedAt,
          ...getSafeErrorLogFields(error),
        },
      );
      throw error;
    } finally {
      // 无论自然结束、报错还是取消，都解除监听并释放本次请求的 session。
      if (options.signal?.aborted && outcome !== "failed") {
        outcome = "cancelled";
      }
      options.signal?.removeEventListener("abort", abortSession);
      if (options.signal?.aborted) await abortPromise;
      if (persistenceAbortPromise) await persistenceAbortPromise;

      // The snapshot must not keep the per-turn context: the next request restores from it.
      // Map every historical user row back to its clean stored text so old injected blocks are
      // removed too, not only the current turn's.
      const userTextById = new Map<string, string>();
      for (const message of options.conversation?.history ?? []) {
        if (message.role !== 'user') continue;
        try {
          userTextById.set(
            message.id,
            this.parseTextBlocks(message.contentJson)
              .map((block) => block.text)
              .join('\n'),
          );
        } catch {
          // A malformed historical row is left untouched; the current prompt still gets cleaned.
        }
      }
      const entries: SessionEntry[] = replaceInjectedUserText(
        session.sessionManager.getEntries(),
        prompt,
        userTextById,
      );
      if (options.conversation && !hasPersistenceError && entries.length > 0) {
        try {
          await this.piSessionSnapshots.saveSnapshot(
            options.conversation.id,
            entries,
          );
        } catch (error) {
          writeStructuredEvent(
            this.logger,
            "error",
            "llm.session_snapshot.save.failed",
            {
              ...logContext,
              entryCount: entries.length,
              ...getSafeErrorLogFields(error),
            },
          );
        }
      }

      unsubscribe();
      try {
        session.dispose();
      } catch (error) {
        outcome = "failed";
        writeStructuredEvent(
          this.logger,
          "error",
          "llm.session.dispose.failed",
          {
            ...logContext,
            ...getSafeErrorLogFields(error),
          },
        );
        throw error;
      } finally {
        writeStructuredEvent(
          this.logger,
          outcome === "completed"
            ? "log"
            : outcome === "cancelled"
              ? "warn"
              : "error",
          "llm.stream.terminated",
          {
            ...logContext,
            outcome,
            phase,
            eventCounts: Object.fromEntries(eventCounts),
            elapsedMs: Date.now() - startedAt,
          },
        );
      }
    }
  }

  /**
   * Runs one non-streamed model call and returns the assistant text.
   *
   * Rehearsal uses this for structured JSON decisions. The call may read a parent conversation's
   * history through `conversation`, but it never persists a snapshot or a conversation message;
   * the caller owns the rehearsal state and its own transcript.
   */
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
      const modelSettings = await this.settings.getLlmSettings();
      const resolved: LlmGenerateOptions = {
        ...options,
        ...getSelectedModelIds(modelSettings),
      };
      let resolvedContextWindow: number | null = null;
      session = await this.createSession(resolved, modelSettings, undefined, {
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

  /** Creates a request-scoped Pi session rooted in the configured Agent workspace. */
  private async createSession(
    options: LlmRequestOptions,
    modelSettings: StoredLlmSettings,
    currentUserRequest?: string,
    buildOptions: PiSessionBuildOptions = {},
  ): Promise<PiAgentSession> {
    const startedAt = Date.now();
    const requestId = options.requestId ?? randomUUID();
    const logContext = getRequestLogContext(options, requestId);
    let phase = "pi_sdk_load";
    writeStructuredEvent(this.logger, "log", "llm.session.create.started", {
      ...logContext,
      phase,
      providerId: options.providerId,
      modelId: options.modelId,
      historyMessageCount: options.conversation?.history.length ?? 0,
    });
    try {
      const sdk = await this.getPiSdk();
      phase = "model_runtime_load";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
      });
      const modelRuntime = await sdk.ModelRuntime.create({
        refreshOnCreate: false,
      });

      phase = "model_configuration";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
      });
      if (!modelSettings.deepseek.apiKey) {
        throw new Error(
          "DeepSeek API Key is missing. Open Settings to configure it.",
        );
      }
      this.deepseekAdapter.register(modelRuntime, modelSettings.deepseek);

      const model =
        options.providerId && options.modelId
          ? modelRuntime.getModel(options.providerId, options.modelId)
          : undefined;

      if (options.providerId && options.modelId && !model) {
        throw new Error(
          `Pi SDK model not found: ${options.providerId}/${options.modelId}.`,
        );
      }
      if (options.conversation && !model) {
        throw new Error(
          "A configured Pi model is required to restore conversation history.",
        );
      }
      // Hand the already-resolved window to the caller's prompt builder. Reading settings again
      // there could observe a different model than the session actually uses.
      buildOptions.onModelResolved?.(model?.contextWindow ?? null);

      const agentDir = sdk.getAgentDir();
      phase = "workspace_tool_load";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
      });
      // SettingsService owns config.toml and SOULS.md; pass only their paths so
      // the Agent tools can deny access while SettingsService remains their owner.
      //
      // The Agent's working directory is the conversation workspace, so a relative path the model
      // writes lands in this conversation and disappears with it. Without a conversation the tools
      // fall back to the configured root, which is the only case that still needs it.
      const configuredWorkspace = await this.settings.getWorkspacePath();
      const resourceRoot = resolve(configuredWorkspace);
      const sessionWorkspace = options.conversation
        ? this.settings.getSessionWorkspaceDirectory(options.conversation.id)
        : configuredWorkspace;
      const cwd = await prepareWorkspaceDirectory(sessionWorkspace);
      const managedFilePaths = await this.settings.getManagedFilePaths();
      const workspaceFileTools = await createWorkspaceFileTools(
        sdk,
        cwd,
        undefined,
        {
          protectedPaths: managedFilePaths,
          // Reads are allowed by default everywhere except this guarded subtree, which needs an
          // explicit path in the current user request (same shape as the external write grant).
          guardedDirectories: [this.settings.getKnowledgeDirectory()],
          // Only stream() supplies this raw current-turn text. generate() has no grant.
          currentUserRequest,
          ...(options.onFileWritten
            ? { onFileWritten: options.onFileWritten }
            : {}),
          onFileOperationFailed: ({
            toolName,
            operation,
            pathScope,
            elapsedMs,
            error,
          }) => {
            const errorFields = getSafeErrorLogFields(error);
            const isPolicyDenied = errorFields.errorCode === "EWORKSPACE";
            writeStructuredEvent(
              this.logger,
              isPolicyDenied ? "warn" : "error",
              "llm.file_tool.operation.failed",
              {
                ...logContext,
                toolName,
                operation,
                pathScope,
                elapsedMs,
                ...(isPolicyDenied
                  ? { failureReason: "workspace_policy_denied" }
                  : {}),
                ...errorFields,
              },
            );
          },
        },
      );
      // Retrieval is not a model tool: the knowledge command decides, and ChatService passes the
      // already-built context block into this request.
      //
      // Web tools bill the DeepSeek account per successful request. Chat and skill turns get them;
      // `generate()` opts out. The deep-research skill decides when web evidence is useful.
      const webToolsEnabled = areWebToolsEnabled(
        { apiKey: modelSettings.deepseek.apiKey },
        { enabled: buildOptions.webTools ?? true },
      );
      const webTools = webToolsEnabled
        ? createWebTools({
            apiKey: modelSettings.deepseek.apiKey,
            requestId,
            ...(options.conversation
              ? { conversationId: options.conversation.id }
              : {}),
            ...(currentUserRequest?.trim()
              ? { originalQuestion: currentUserRequest }
              : {}),
            logger: this.logger,
          })
        : [];
      const customTools = [...workspaceFileTools, ...webTools];
      // Chat turns load long-term memory; internal JSON calls (`generate`) opt out.
      const loadMemory = buildOptions.loadMemory ?? true;
      // Extensions are in-process only. `noExtensions` keeps Pi from discovering packages, so a
      // session registers exactly the persistence hook plus the allowlisted memory tools.
      const extensionFactories: PiExtensionFactory[] = [];
      if (options.persistConversationEvent) {
        extensionFactories.push(
          createConversationPersistenceExtension(
            options.persistConversationEvent,
          ),
        );
      }
      if (loadMemory) {
        const memoryExtension = await this.memory.createToolExtension();
        if (memoryExtension) extensionFactories.push(memoryExtension);
      }

      const toolAllowlist = buildOptions.tools ?? [
        "read",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        ...(loadMemory ? ["memory_*"] : []),
        ...(webToolsEnabled ? [...WEB_TOOL_NAMES] : []),
      ];
      let customSystemPrompt: string;
      if (buildOptions.systemPromptAppend?.trim()) {
        // Rehearsal supplies its own fixed prompt; chat rules and style preference would conflict
        // with the student role and are intentionally skipped.
        customSystemPrompt = buildOptions.systemPromptAppend;
      } else {
        const stylePreference = await this.settings.getStylePreference();
        customSystemPrompt = [
          "\n\nWorkspace and file rules:",
          `- Your working directory is: ${cwd}.`,
          "- Create files only when explicitly requested by the user. Answer ordinary questions directly in chat.",
          "- Write generated files to the working directory by default. Writing outside it requires an explicit destination in the current user request.",
          "- Choose the most appropriate file format, structure, and presentation based on the user's intent. Prioritize clarity and usability.",
          "- For mind maps, prefer SVG with a left-to-right tree layout.",
          "- When the user states a durable preference, identity, or explicitly asks you to remember something, call memory_write. Never record one-off task details, file contents, teaching mastery (scores/weak spots), or answer style.",
          `\n\nUser preferences: ${stylePreference}`,
        ].join("\n");
      }

      // Bundled skill templates are copied into the config root once. The user can then inspect,
      // edit or replace them without depending on the backend install directory.
      await this.ensureInstalledSkills();
      const agentsPolicy = await readFile(this.settings.getAgentsFilePath(), "utf8");

      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // Context discovery stays disabled: only this protected, audited policy is loaded.
        agentsFilesOverride: () => ({
          agentsFiles: [{ path: this.settings.getAgentsFilePath(), content: agentsPolicy }],
        }),
        // `noExtensions` disables package discovery; extensionFactories still load explicitly.
        extensionFactories,
        // These stay anchored to the configured root instead of the session cwd, so per-session
        // workspaces never change where user-provided skills and prompt templates are looked up.
        // `noSkills` only disables discovery, not these explicit paths. The config-root directory
        // is the installed location (`<configDir>/skills`); the workspace directory remains for
        // users who keep project-local skills next to their other Agent files.
        additionalSkillPaths: [
          this.settings.getSkillsDirectory(),
          join(resourceRoot, "skills"),
        ],
        additionalPromptTemplatePaths: [join(resourceRoot, "prompts")],
        appendSystemPromptOverride: (base) => [...base, customSystemPrompt],
      });
      // The SDK does not reload an explicitly supplied resourceLoader. Load
      // only these allowlisted extensions before session creation.
      phase = "resource_loader_reload";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
      });
      await resourceLoader.reload();

      // `/skill:name` silently stays literal when the skill is missing. A caller that asked for a
      // skill must get a real error here instead of a model turn that can no longer follow the
      // procedure it was promised.
      if (options.skillName) {
        const requestedSkill = resourceLoader
          .getSkills()
          .skills.find((skill) => skill.name === options.skillName);
        if (!requestedSkill) {
          throw new Error(`Pi skill not found: ${options.skillName}.`);
        }
      }

      const settingsManager = sdk.SettingsManager.create(
        cwd,
        sdk.getAgentDir(),
      );
      settingsManager.applyOverrides({
        retry: {
          enabled: true,
          maxRetries: 3,
        },
        // Force compaction on for app-owned sessions. `setCompactionEnabled()` also writes the
        // value into the user's global Pi settings file; overrides stay inside this session.
        compaction: {
          enabled: true,
        },
      });
      const compactionSettings = settingsManager.getCompactionSettings(model);

      phase = "history_restore";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
        historyMessageCount: options.conversation?.history.length ?? 0,
      });
      // 快照是模型上下文；仅缺失或落后于最新 SQLite 消息时用 UI 历史重建。
      const restoredEntries = options.conversation
        ? await this.restoreEntries(options.conversation, model!, logContext)
        : undefined;
      const sessionManager = options.conversation
        ? sdk.SessionManager.inMemory(
            cwd,
            { id: options.conversation.id },
            restoredEntries!,
          )
        : sdk.SessionManager.inMemory(cwd);

      phase = "agent_session_create";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
      });
      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        thinkingLevel: options.thinkingLevel ?? "high",
        resourceLoader,
        sessionManager,
        settingsManager,
        // The allowlist covers every registered tool name, so extension tools are listed too.
        tools: [...toolAllowlist],
        excludeTools: ["bash"],
        customTools,
      });

      // Extensions receive `session_start` only through this binding; the persistence hook relies
      // on it to attach its awaited event handlers.
      phase = "extension_bind";
      writeStructuredEvent(this.logger, "log", "llm.session.create.phase", {
        ...logContext,
        phase,
      });
      await session.bindExtensions({});

      writeStructuredEvent(this.logger, "log", "llm.session.create.completed", {
        ...logContext,
        providerId: options.providerId,
        modelId: options.modelId,
        historyMessageCount: options.conversation?.history.length ?? 0,
        restoredEntryCount: restoredEntries?.length ?? 0,
        extensionCount: extensionFactories.length,
        customToolCount: customTools.length,
        toolCount: toolAllowlist.length,
        loadMemory,
        memoryToolAvailable: loadMemory && this.memory.isAvailable(),
        webToolsEnabled,
        webToolCount: webTools.length,
        skillsDirectory: this.settings.getSkillsDirectory(),
        compactionEnabled: compactionSettings.enabled,
        compactionReserveTokens: compactionSettings.reserveTokens,
        compactionKeepRecentTokens: compactionSettings.keepRecentTokens,
        modelContextWindow: model?.contextWindow ?? null,
        // Pi compacts when contextTokens > contextWindow - reserveTokens.
        compactionThresholdTokens: model
          ? Math.max(0, model.contextWindow - compactionSettings.reserveTokens)
          : null,
        elapsedMs: Date.now() - startedAt,
      });
      return session;
    } catch (error) {
      writeStructuredEvent(this.logger, "error", "llm.session.create.failed", {
        ...logContext,
        providerId: options.providerId,
        modelId: options.modelId,
        phase,
        historyMessageCount: options.conversation?.history.length ?? 0,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /**
   * Restores the model context by preferring the stored Pi snapshot; SQLite
   * history is rebuilt only when the snapshot is missing or lags behind it.
   */
  private async restoreEntries(
    conversation: LlmConversationContext,
    model: PiModel,
    logContext: RequestLogContext,
  ): Promise<SessionEntry[]> {
    const rebuiltEntries = this.createSessionEntries(
      conversation.history,
      model,
    );
    let snapshotEntries: SessionEntry[] | null = null;
    try {
      snapshotEntries = await this.piSessionSnapshots.getSnapshot(
        conversation.id,
      );
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        "warn",
        "llm.session_snapshot.load.failed",
        {
          ...logContext,
          ...getSafeErrorLogFields(error),
        },
      );
    }

    const restored = pickSessionEntries(rebuiltEntries, snapshotEntries);
    writeStructuredEvent(this.logger, "log", "llm.session.restore.completed", {
      ...logContext,
      source: restored.source,
      rebuiltEntryCount: rebuiltEntries.length,
      snapshotEntryCount: snapshotEntries?.length ?? 0,
      restoredEntryCount: restored.entries.length,
    });
    return restored.entries;
  }

  /** Converts persisted plain-text turns into the Pi SDK's authoritative entry tree. */
  private createSessionEntries(
    history: readonly LlmConversationHistoryMessage[],
    model: PiModel,
  ): PiSessionMessageEntry[] {
    let parentId: string | null = null;
    const entries: PiSessionMessageEntry[] = [];

    for (const storedMessage of history) {
      const createdAt = new Date(storedMessage.createdAt);
      const timestamp = createdAt.getTime();
      const persistedPiMessage = parsePersistedPiMessage(
        storedMessage.contentJson,
      );
      if (persistedPiMessage) {
        const nestedTimestamp = persistedPiMessage.message.timestamp;
        const entryTimestamp = Number.isFinite(nestedTimestamp)
          ? new Date(nestedTimestamp).toISOString()
          : createdAt.toISOString();
        const piEntry: PiSessionMessageEntry = {
          type: "message",
          id: storedMessage.id,
          parentId,
          timestamp: entryTimestamp,
          message: persistedPiMessage.message,
        };
        entries.push(piEntry);
        parentId = piEntry.id;
        continue;
      }

      if (storedMessage.role === "user") {
        const userMessage: PiSessionMessageEntry["message"] = {
          role: "user",
          content: this.parseTextBlocks(storedMessage.contentJson),
          timestamp,
        };
        const userEntry: PiSessionMessageEntry = {
          type: "message",
          id: storedMessage.id,
          parentId,
          timestamp: createdAt.toISOString(),
          message: userMessage,
        };
        entries.push(userEntry);
        parentId = userEntry.id;
        continue;
      }
      if (storedMessage.role !== "assistant") continue;

      const content = this.parseTextBlocks(storedMessage.contentJson);
      if (content.length === 0) continue;
      const assistantMessage: PiSessionMessageEntry["message"] = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: createEmptyUsage(),
        stopReason:
          storedMessage.status === "completed"
            ? "stop"
            : storedMessage.status === "cancelled"
              ? "aborted"
              : "error",
        timestamp,
      };
      const assistantEntry: PiSessionMessageEntry = {
        type: "message",
        id: storedMessage.id,
        parentId,
        timestamp: createdAt.toISOString(),
        message: assistantMessage,
      };
      entries.push(assistantEntry);
      parentId = assistantEntry.id;
    }

    return entries;
  }

  /** Parses the stored text-block format and rejects content Pi history cannot restore. */
  private parseTextBlocks(
    contentJson: string,
  ): Array<{ type: "text"; text: string }> {
    const value: unknown = JSON.parse(contentJson);
    if (
      !Array.isArray(value) ||
      !value.every(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          !Array.isArray(block) &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
    ) {
      throw new Error("Stored conversation content is not valid text blocks.");
    }
    return value as Array<{ type: "text"; text: string }>;
  }

  /**
   * Seeds bundled skill templates into `<configDir>/skills` once per process.
   *
   * The promise is retained so concurrent sessions do not race the same copies; a failure clears
   * it so the next session retries instead of permanently disabling skills.
   */
  private ensureInstalledSkills(): Promise<void> {
    this.installedSkillsPromise ??= Promise.resolve()
      .then(() =>
        installBundledSkills(
          BUNDLED_SKILLS_ASSET_PATH,
          this.settings.getSkillsDirectory(),
        ),
      )
      .catch((error: unknown) => {
        this.installedSkillsPromise = undefined;
        throw error;
      });
    return this.installedSkillsPromise;
  }

  /** Loads and caches the Pi SDK module. */
  private getPiSdk(): Promise<PiSdk> {
    this.piSdkPromise ??= importPiSdk(PI_SDK_PACKAGE);
    return this.piSdkPromise;
  }

  /** Turns a settled completion into text, naming truncation and legitimately empty runs. */
  private readAssistantText(
    completion: Exclude<AssistantCompletion, { kind: "cancelled" }>,
  ): string {
    if (completion.kind === "truncated") {
      throw new LlmResponseTruncatedError();
    }
    if (completion.kind === "empty") {
      throw new Error("Pi SDK completed without returning assistant text.");
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
function classifyAssistantCompletion(
  messages: PiAgentSession["messages"],
  text: string | undefined,
): AssistantCompletion {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (lastAssistant?.role === "assistant") {
    if (lastAssistant.stopReason === "aborted") return { kind: "cancelled" };
    if (lastAssistant.stopReason === "length") return { kind: "truncated" };
  }
  if (!text?.trim()) return { kind: "empty" };
  return { kind: "text", text };
}

/** Identifies one Pi message independently of SQLite row and Pi entry IDs. */
function getPiMessageSignature(
  message: PiSessionMessageEntry["message"],
): string {
  return JSON.stringify({
    role: message.role,
    content: "content" in message ? message.content : undefined,
    ...("toolCallId" in message ? { toolCallId: message.toolCallId } : {}),
  });
}

/**
 * Picks the last message that corresponds to a persisted transcript row,
 * skipping Pi-only entries such as compaction or system context messages.
 */
function findLastRestorableMessageSignature(
  entries: readonly SessionEntry[],
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    const { role } = entry.message;
    if (role === "user" || role === "assistant" || role === "toolResult") {
      return getPiMessageSignature(entry.message);
    }
  }
  return undefined;
}

/**
 * Prefers the stored model-context snapshot. It is rejected only when its last
 * persisted message lags behind SQLite, which means the previous run crashed or
 * could not save the snapshot; SQLite history then rebuilds the context.
 */
function pickSessionEntries(
  rebuilt: PiSessionMessageEntry[],
  snapshot: SessionEntry[] | null,
): { entries: SessionEntry[]; source: SessionRestoreSource } {
  if (!snapshot || rebuilt.length === 0) {
    return { entries: rebuilt, source: "rebuilt_history" };
  }
  const latestRebuilt = rebuilt[rebuilt.length - 1];
  const snapshotTail = findLastRestorableMessageSignature(snapshot);
  if (snapshotTail === getPiMessageSignature(latestRebuilt.message)) {
    return { entries: snapshot, source: "session_snapshot" };
  }
  return { entries: rebuilt, source: "rebuilt_history" };
}

/**
 * Logs Pi's compaction lifecycle with token metrics.
 *
 * Pi decides when to compact: threshold crossing, overflow recovery, or a manual `/compact`. This
 * app never calls `session.compact()`. The summary is an extra provider request that rewrites the
 * model context, so both the trigger and the failure must be visible to operators.
 */
function logPiCompactionEvent(
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

/** Builds the shared internal request correlation fields for LLM logs. */
function getRequestLogContext(
  options: LlmRequestOptions,
  requestId: string,
): RequestLogContext {
  return {
    requestId,
    ...(options.conversation
      ? { conversationId: options.conversation.id }
      : {}),
  };
}

/** Resolves the safe provider/model identifiers for one settings snapshot. */
function getSelectedModelIds(
  settings: StoredLlmSettings,
): Pick<LlmRequestOptions, "providerId" | "modelId"> {
  return {
    providerId: DEEPSEEK_PROVIDER_ID,
    modelId: settings.deepseek.modelId,
  };
}

/**
 * Prepends one turn's reference material to the user's own text.
 *
 * Context goes first and the question last, so the model reads the evidence and then the task; the
 * marker keeps the boundary explicit when the material is a long document.
 */
function composeModelPrompt(prompt: string, context?: string): string {
  const material = context?.trim();
  if (!material) return prompt;
  return `${material}\n\n## 用户输入\n${prompt}`;
}
