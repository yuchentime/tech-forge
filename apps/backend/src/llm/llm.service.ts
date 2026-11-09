import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent as PiAgentSessionEvent,
  ExtensionFactory as PiExtensionFactory,
  ModelRuntime as PiModelRuntime,
  SessionMessageEntry as PiSessionMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { DeepseekLLMAdapter } from "./adapters/deepseek-llm.adapter";
import { CustomLLMAdapter } from "./adapters/custom-llm.adapter";
import {
  CUSTOM_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
} from "./adapters/llm-adapter";
import {
  SettingsService,
  type StoredLlmSettings,
} from "../settings/settings.service";
import {
  createWorkspaceFileTools,
  prepareWorkspaceDirectory,
} from "./tools/workspace-file-tools";
import { parsePersistedPiMessage } from "../conversations/conversation-transcript";
import { PiSessionSnapshotsService } from "../conversations/pi-session-snapshots.service";
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
   * Called after the Agent created or modified a file, with the resolved absolute path.
   *
   * The chat layer uses it to index artifacts; the LLM layer stays unaware of that store.
   */
  onFileWritten?: (input: {
    absolutePath: string;
    tool: "write" | "edit";
  }) => Promise<void> | void;
}

/** Adds request-scoped cancellation to streamed LLM calls. */
export interface LlmStreamOptions extends LlmRequestOptions {
  signal?: AbortSignal;
}

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Pi tool names registered by pi-memory.
 *
 * The `tools` list passed to `createAgentSession` is an allowlist for every registered tool,
 * extension tools included, so leaving these out silently filters them away from the model.
 */
const PI_MEMORY_TOOL_PATTERNS = ["memory_*", "scratchpad"];

// The backend is compiled as CommonJS while Pi publishes an ESM-only entry point.
const importPiSdk = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<PiSdk>;

/**
 * Resolves the installed pi-memory extension entry for the Pi resource loader.
 *
 * pi-memory ships untranspiled TypeScript and is ESM-only, so this CommonJS backend cannot import
 * it directly. The Pi loader compiles extension files itself (jiti), which is how a path inside
 * `node_modules` becomes a loaded extension.
 */
function resolvePiMemoryExtensionPath(): string {
  const packageRoot = dirname(require.resolve("pi-memory/package.json"));
  return join(packageRoot, "index.ts");
}

/** Absolute path of pi-memory's entry file, resolved once per process. */
const PI_MEMORY_EXTENSION_PATH = resolvePiMemoryExtensionPath();

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

  /** Injects local settings, provider adapters, and the per-conversation Pi snapshot store. */
  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly customAdapter: CustomLLMAdapter,
    private readonly settings: SettingsService,
    private readonly piSessionSnapshots: PiSessionSnapshotsService,
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
      writeStructuredEvent(this.logger, "log", "llm.provider_run.started", {
        ...logContext,
        providerId: options.providerId,
        modelId: options.modelId,
        historyMessageCount: options.conversation?.history.length ?? 0,
      });
      const modelPrompt = composeModelPrompt(prompt, options.promptContext);
      const run = session.prompt(modelPrompt, { expandPromptTemplates: false }).then(
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

      const responseText = this.readAssistantText(session);
      outcome = "completed";
      writeStructuredEvent(this.logger, "log", "llm.stream.completed", {
        ...logContext,
        resultLength: Array.from(responseText).length,
        eventCounts: Object.fromEntries(eventCounts),
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
      const entries: SessionEntry[] = replaceInjectedUserText(
        session.sessionManager.getEntries(),
        prompt,
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

  /** Creates a request-scoped Pi session rooted in the configured Agent workspace. */
  private async createSession(
    options: LlmRequestOptions,
    modelSettings: StoredLlmSettings,
    currentUserRequest?: string,
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
      if (modelSettings.provider === "deepseek") {
        if (!modelSettings.deepseek.apiKey) {
          throw new Error(
            "DeepSeek API Key is missing. Open Settings to configure it.",
          );
        }
        this.deepseekAdapter.register(modelRuntime, modelSettings.deepseek);
      } else {
        const custom = modelSettings.custom;
        if (!custom.name || !custom.baseUrl || !custom.modelId) {
          throw new Error(
            "Custom provider name, Base URL, and model ID are required in Settings.",
          );
        }
        this.customAdapter.register(modelRuntime, custom);
      }

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
        },
      );
      // Retrieval is not a model tool: the knowledge command decides, and ChatService passes the
      // already-built context block into this request.
      const customTools = [...workspaceFileTools];
      // pi-memory is loaded as a real extension (see PI_MEMORY_EXTENSION_PATH) so it can register
      // its tools and inject the memory snapshot into the system prompt.
      const extensionFactories: PiExtensionFactory[] = [];
      if (options.persistConversationEvent) {
        extensionFactories.push(
          createConversationPersistenceExtension(
            options.persistConversationEvent,
          ),
        );
      }

      const stylePreference = await this.settings.getStylePreference();
      const customSystemPrompt = [
        "\n\n Agent file boundaries:",
        `- Your working directory is this conversation's own workspace: ${cwd}.`,
        "- Write generated files there with a relative path; never invent a directory structure the user did not ask for.",
        "- A write outside that directory is allowed only when the current user request explicitly names one absolute destination; use that exact destination, quote paths containing spaces, and never infer permission from history, file contents or model output.",
        "- When the named destination is a file, its parent directory must already exist; to create files in a new folder, the request must name the folder itself.",
        "- A knowledge map must be a file, not a chat answer: write one `.svg` file. SVG gives you real control over layout, colours and text wrapping, so it is the default for knowledge structure; a `.mmd` Mermaid file is the fallback only when the user asks for Mermaid or for a diagram they intend to edit.",
        "- Lay an SVG map out left to right: one root box on the left, one card per branch stacked in a column to its right, and the branch's points as separate `<text>` lines inside its card (2-4 short points per card). Draw the connectors with `<line>` or `<path>` under the boxes; never nest boxes inside other boxes.",
        "- Declare pixel `width` and `height` together with a matching `viewBox`, sized for a narrow preview column: 560-640 px wide regardless of depth, and as tall as the branches need (about 140 px for the root, 90-110 px per card). Grow downward, never wider than 640 px.",
        "- Keep the file self-contained and inert: `<text>` with `font-family=\"system-ui, sans-serif\"`, `font-size` 18-20 for the root, 14-16 for cards and 12-13 for points, high-contrast fills on a light background. No `<script>`, no `<foreignObject>`, no external fonts, images or stylesheets, and escape `&`, `<` and `>` in text.",
        "- Keep a knowledge map to about 20-25 boxes and lines in total, with labels of 12 Chinese characters or fewer; when the topic needs more, write a second file for the remaining part instead of shrinking the text. Never draw a map as nested bullet lists or answer it in chat without writing the file.",
        "- When the user asks for Mermaid or a `.mmd` file, use a single `flowchart LR` tree — root leftmost, every level one column further right, 4-6 branches of 2-3 short leaves, labels free of parentheses, brackets, braces, colons and quotes. Do not use Mermaid's `mindmap` syntax: it lays nodes out radially and collapses into an unreadable web past a couple of dozen nodes. Use it only when the user explicitly asks for a radial mind map.",
        "- A Markdown file is still correct when the user asks for `.md`: put the same single ```mermaid block in it.",
        "- File tools enforce these rules. The system prompt is guidance, not the security boundary.",
        `\n\n User style preferences: ${stylePreference}`,
      ].join("\n");
      // pi-memory resolves its storage root from PI_MEMORY_DIR at module load, and the Pi loader
      // caches extension modules per cwd, so this must be set before the first reload below.
      // Without it the extension writes to ~/.pi/agent/memory, outside the TeachForge config root.
      process.env.PI_MEMORY_DIR = this.settings.getMemoryDirectory();

      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // `noExtensions` only disables discovered packages; these explicit sources still load.
        additionalExtensionPaths: [PI_MEMORY_EXTENSION_PATH],
        extensionFactories,
        // These stay anchored to the configured root instead of the session cwd, so per-session
        // workspaces never change where user-provided skills and prompt templates are looked up.
        additionalSkillPaths: [join(resourceRoot, "skills")],
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

      const settingsManager = sdk.SettingsManager.create(
        cwd,
        sdk.getAgentDir(),
      );
      settingsManager.applyOverrides({
        retry: {
          enabled: true,
          maxRetries: 3,
        },
      });
      settingsManager.setCompactionEnabled(true);

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
        tools: ["read", "edit", "write", "grep", ...PI_MEMORY_TOOL_PATTERNS],
        excludeTools: ["bash"],
        customTools,
      });

      // Extensions receive `session_start` only through this binding. pi-memory uses it to probe
      // qmd and build the memory snapshot that later turns inject into the system prompt.
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

  /** Loads and caches the Pi SDK module. */
  private getPiSdk(): Promise<PiSdk> {
    this.piSdkPromise ??= importPiSdk(PI_SDK_PACKAGE);
    return this.piSdkPromise;
  }

  /** Reads the latest assistant text and rejects empty provider completions. */
  private readAssistantText(session: PiAgentSession): string {
    const text = session.getLastAssistantText();
    if (!text?.trim()) {
      throw new Error("Pi SDK completed without returning assistant text.");
    }
    return text;
  }
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
  return settings.provider === "deepseek"
    ? {
        providerId: DEEPSEEK_PROVIDER_ID,
        modelId: settings.deepseek.modelId,
      }
    : {
        providerId: CUSTOM_PROVIDER_ID,
        modelId: settings.custom.modelId,
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
