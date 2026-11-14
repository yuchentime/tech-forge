import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type * as PiSdkModule from '@earendil-works/pi-coding-agent';
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent as PiAgentSessionEvent,
  ExtensionFactory as PiExtensionFactory,
  ModelRuntime as PiModelRuntime,
  SessionMessageEntry as PiSessionMessageEntry,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { DEEPSEEK_PROVIDER_ID } from './adapters/llm-adapter';
import { parsePersistedPiMessage } from '../conversations/conversation-transcript';
import { PiSessionSnapshotsService } from '../conversations/pi-session-snapshots.service';
import { SettingsService, type StoredLlmSettings } from '../settings/settings.service';
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
  type RequestLogContext,
} from '../logging/structured-logger';
import { checkSessionEntries, replaceInjectedUserText } from './session-entries';
import { BUNDLED_SKILLS_ASSET_PATH, installBundledSkills } from './skills';
import { areWebToolsEnabled, createWebTools, WEB_TOOL_NAMES } from './tools/web-tools';
import {
  createWorkspaceFileTools,
  isPathWithin,
  prepareWorkspaceDirectory,
} from './tools/workspace-file-tools';
import { pruneImageWritePayloads } from './snapshot-image-prune';
import type {
  LlmConversationContext,
  LlmConversationHistoryMessage,
  LlmRequestOptions,
  PiThinkingLevel as ContractPiThinkingLevel,
} from './llm-contracts';

export type PiSdk = typeof PiSdkModule;
export type PiThinkingLevel = ContractPiThinkingLevel;
type SessionRestoreSource = 'session_snapshot' | 'rebuilt_history';

/** The concrete model resolved from the user's local DeepSeek settings. */
export type PiModel = NonNullable<ReturnType<PiModelRuntime['getModel']>>;

const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

// The backend is compiled as CommonJS while Pi publishes an ESM-only entry point.
const importPiSdk = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<PiSdk>;

let piSdkPromise: Promise<PiSdk> | undefined;


/** Controls the tools, memory and prompt used to assemble one app-owned Pi session. */
export interface PiSessionBuildOptions {
  systemPromptAppend?: string;
  tools?: readonly string[];
  /** Whether to register long-term memory tools; JSON-only calls pass `false`. */
  loadMemory?: boolean;
  /** Whether to register DeepSeek web tools; internal JSON calls pass `false`. */
  webTools?: boolean;
  /** Publishes the resolved model's context window to the caller that builds the prompt. */
  onModelResolved?: (contextWindow: number | null) => void;
}
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

/** One persisted content block, narrowed from the stored JSON before Pi restores it. */
function isStoredTextBlock(
  block: unknown,
): block is { type: "text"; text: string } {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return false;
  }
  if (!("type" in block) || !("text" in block)) return false;
  return block.type === "text" && typeof block.text === "string";
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
export function getRequestLogContext(
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


/** Loads and caches the Pi SDK module shared by the internal classroom agents. */
export function getPiSdk(): Promise<PiSdk> {
  piSdkPromise ??= importPiSdk(PI_SDK_PACKAGE);
  return piSdkPromise;
}

/** Everything one app-owned Pi session needs, resolved once per turn. */
export interface PiAgentEnvironment {
  sdk: PiSdk;
  modelRuntime: PiModelRuntime;
  model: PiModel;
  agentDir: string;
  cwd: string;
}

/**
 * Resolves the local DeepSeek configuration into a ready Pi runtime, model and working directory.
 *
 * The runtime is created per caller so two agents never share provider registration state; the
 * workspace is only a neutral cwd here — these sessions register no file tools.
 */
export async function resolvePiAgentEnvironment(
  adapter: DeepseekLLMAdapter,
  settings: SettingsService,
): Promise<PiAgentEnvironment> {
  const sdk = await getPiSdk();
  const modelSettings = await settings.getLlmSettings();
  if (!modelSettings.deepseek.apiKey) {
    throw new Error(
      'DeepSeek API Key is missing. Open Settings to configure it.',
    );
  }

  const modelRuntime = await sdk.ModelRuntime.create({
    refreshOnCreate: false,
  });
  adapter.register(modelRuntime, modelSettings.deepseek);
  const model = modelRuntime.getModel(
    DEEPSEEK_PROVIDER_ID,
    modelSettings.deepseek.modelId,
  );
  if (!model) {
    throw new Error(
      `Pi SDK model not found: ${DEEPSEEK_PROVIDER_ID}/${modelSettings.deepseek.modelId}.`,
    );
  }

  return {
    sdk,
    modelRuntime,
    model,
    agentDir: sdk.getAgentDir(),
    cwd: resolve(await settings.getWorkspacePath()),
  };
}

/**
 * Creates a Pi session that loads no extensions, skills, prompt templates, themes or context files.
 *
 * `systemPrompt` replaces Pi's coding-agent prompt instead of appending to it: an internal agent
 * never touches the workspace, and leftover file/tool instructions would invite calls it cannot
 * serve. No tools are registered, and compaction is off because each session runs one short turn.
 */
export async function createCleanPiSession(
  environment: PiAgentEnvironment,
  systemPrompt: string,
  thinkingLevel: PiThinkingLevel = 'high',
): Promise<PiAgentSession> {
  const { sdk, modelRuntime, model, agentDir, cwd } = environment;
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  settingsManager.applyOverrides({
    retry: { enabled: true, maxRetries: 3 },
    // One short turn: compaction would spend a second provider request for no benefit.
    compaction: { enabled: false },
  });

  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    resourceLoader,
    // No restore: the caller owns the classroom state, not Pi's session store.
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager,
    // No tools at all, built-in or custom.
    tools: [],
  });
  await session.bindExtensions({});
  return session;
}

/** Request-scoped cancellation for one Pi turn. */
export interface PiTurnOptions {
  signal?: AbortSignal;
  /** Abort the provider call after this many milliseconds. */
  timeoutMs?: number;
}



/**
 * Runs one prompt against an already-created clean session and returns its assistant text.
 *
 * Cancellation and timeouts abort the Pi run and reject with a distinct error instead of waiting
 * for the provider; the caller's `finally` still disposes the session.
 */
export async function runPiTurn(
  session: PiAgentSession,
  prompt: string,
  options: PiTurnOptions = {},
): Promise<string> {
  // An already-cancelled caller must not start a provider request at all.
  if (options.signal?.aborted) {
    throw new Error('Pi agent turn cancelled.');
  }

  const abortController = new AbortController();
  const cancelled = Promise.withResolvers<never>();
  let timedOut = false;

  const abortSession = (): void => {
    if (abortController.signal.aborted) return;
    abortController.abort();
    // A failed abort is secondary to the cancellation error this race already reports.
    void session.abort().catch(() => undefined);
  };
  const onAbortSignal = (): void => {
    cancelled.reject(
      new Error(
        timedOut ? 'Pi agent turn timed out.' : 'Pi agent turn cancelled.',
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
    const run = session.prompt(prompt, { expandPromptTemplates: false });
    // The abort race may settle first; keep the provider promise from becoming unhandled.
    void run.catch(() => undefined);
    await Promise.race([run, cancelled.promise]);

    if (timedOut || abortController.signal.aborted) {
      throw new Error(
        timedOut ? 'Pi agent turn timed out.' : 'Pi agent turn cancelled.',
      );
    }
    return readAssistantText(session);
  } finally {
    clearTimeout(timer);
    abortController.signal.removeEventListener('abort', onAbortSignal);
    options.signal?.removeEventListener('abort', abortSession);
  }
}

/**
 * Reads the settled assistant text, naming the terminal stop reason first.
 *
 * Pi's `getLastAssistantText()` reports a provider rejection or a token-limit stop as an empty
 * answer, which would look like a broken model; classifying the last message keeps the cause.
 */
export function readAssistantText(session: PiAgentSession): string {
  const lastAssistant = [...session.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (lastAssistant?.role === 'assistant') {
    if (lastAssistant.stopReason === 'aborted') {
      throw new Error('Pi agent turn cancelled.');
    }
    if (lastAssistant.stopReason === 'length') {
      throw new Error(
        'Provider stopped at the output token limit before returning assistant text.',
      );
    }
    if (lastAssistant.stopReason === 'error') {
      throw new Error(
        lastAssistant.errorMessage?.trim() ||
          'Provider rejected the request without an error message.',
      );
    }
  }

  const text = session.getLastAssistantText()?.trim();
  if (!text) {
    throw new Error('Pi SDK completed without returning assistant text.');
  }
  return text;
}

/** Owns Pi session construction, extensions, skills, tools and persisted model context. */
@Injectable()
export class PiAgentRuntime {
  private readonly logger = new Logger(PiAgentRuntime.name);
  /** One-shot skill installation is shared by concurrent session creations. */
  private installedSkillsPromise?: Promise<void>;

  /** Injects provider configuration, local settings and persisted Pi snapshots. */
  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly settings: SettingsService,
    private readonly piSessionSnapshots: PiSessionSnapshotsService,
  ) {}

  /** Resolves a single settings snapshot and stamps its selected model on the request. */
  async resolveRequest<T extends LlmRequestOptions>(
    options: T,
  ): Promise<{ resolved: T; modelSettings: StoredLlmSettings }> {
    const modelSettings = await this.settings.getLlmSettings();
    return {
      resolved: { ...options, ...getSelectedModelIds(modelSettings) },
      modelSettings,
    };
  }

  /** Creates a fully configured app session and restores its prior model context when present. */
  async createSession(
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
      const sdk = await getPiSdk();
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
      // SettingsService owns config.toml, PREFERENCE.md and IDENTIFY.md; pass only their paths so
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
      // App-owned `read`/`edit`/`write` with the same names as Pi's built-ins, so they shadow them
      // in the session: these carry the workspace boundary, the app-file guard and the artifact
      // callback. Dropping them from `customTools` below silently falls back to the built-ins, which
      // enforce nothing and never report a written path — the Agent still says it wrote a file, but
      // no artifact row exists and the file sidebar stays empty.
      const workspaceFileTools = await createWorkspaceFileTools(
        sdk,
        cwd,
        undefined,
        {
          protectedPaths: managedFilePaths,
          // Only stream() supplies this raw current-turn text. generate() has no grant.
          currentUserRequest,
          ...(options.onFileWritten
            ? { onFileWritten: options.onFileWritten }
            : {}),
          onFileReadResolution: ({
            outcome,
            pathScope,
            protectedPathCount,
            elapsedMs,
          }) => {
            writeStructuredEvent(
              this.logger,
              outcome === "resolved" ? "log" : "warn",
              "llm.file_tool.read.resolution",
              {
                ...logContext,
                outcome,
                pathScope,
                protectedPathCount,
                elapsedMs,
              },
            );
          },
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
      // `workspaceFileTools` must stay in this array: it is the only source of `onFileWritten`, and
      // `tools:` below is just an allowlist of names — a name without a registered custom tool
      // resolves to the built-in one instead.
      const customTools = [...workspaceFileTools, ...webTools];
      // Chat turns load long-term memory; internal JSON calls (`generate`) opt out.
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

      const toolAllowlist = buildOptions.tools ?? [
        "read",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        ...(webToolsEnabled ? [...WEB_TOOL_NAMES] : []),
      ];
      let customSystemPrompt: string;
      if (buildOptions.systemPromptAppend?.trim()) {
        // Rehearsal supplies its own fixed prompt; chat rules, identity and style preference would
        // conflict with the student role and are intentionally skipped.
        customSystemPrompt = buildOptions.systemPromptAppend;
      } else {
        const [stylePreference, identity] = await Promise.all([
          this.settings.getStylePreference(),
          this.settings.getIdentitySetting(),
        ]);
        const knowledgeBaseIndex = this.settings.getKnowledgeCatalogPath();
        const promptSections = [
          "\n\n## Adaptive teaching",
          "- Infer the user's familiarity with the current concept from conversation context, available memory, and demonstrated understanding. Distinguish exposure from mastery; do not assume expertise without evidence.",
          "- Adapt teaching to the current concept: favor explanations, examples, and guided steps for beginners; gradually introduce questions and scaffolding as understanding grows; use Socratic questioning, counterexamples, and application challenges when the user shows sufficient foundations.",
          "- Treat these as flexible preferences, not fixed stages. Reassess understanding as new evidence emerges and reduce question difficulty or explain directly when the user struggles.",
          "- Respect the user's immediate intent. Answer direct questions directly when appropriate, and avoid unnecessary quizzes or repetitive probing.",
          "- When knowledge level is uncertain, start accessibly and calibrate through natural interaction rather than mandatory assessments.",
          "\n\n## Workspace and file rules:",
          `- Your working directory is: ${cwd}.`,
          "- Create files only when explicitly requested by the user. Answer ordinary questions directly in chat.",
          "- Write generated files to the working directory by default. Writing outside it requires an explicit destination in the current user request.",
          "- Choose the most appropriate file format, structure, and presentation based on the user's intent. Prioritize clarity and usability.",
          "- For mind maps, prefer SVG with a left-to-right tree layout.",
          "\n\n## Knowledge library:",
          `- The catalog of knowledge base: ${knowledgeBaseIndex}.`,
          "- When the user needs to search the knowledge base, use the knowledge base catalog to locate and read the relevant original documents.",
        ];
        if (identity.trim()) {
          // User-authored context about who they are and what they are working toward. It steers
          // examples and depth without overriding the current request.
          promptSections.push(`\n\n## User identity:\n${identity.trim()}`);
        }
        if (stylePreference.trim()) {
          promptSections.push(`\n\n## User preferences: \n${stylePreference}`);
        }
        customSystemPrompt = promptSections.join("\n");
      }

      // Bundled skill templates are copied into the config root once. The user can then inspect,
      // edit or replace them without depending on the backend install directory.
      await this.ensureInstalledSkills();

      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // Context discovery stays disabled: every instruction this session needs comes from the
        // system prompt above, so no workspace or ancestor AGENTS.md can steer a conversation.
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

  /** Cleans turn-only inputs and persists the durable model context for the next request. */
  async saveConversationSnapshot(input: {
    conversation: LlmConversationContext | undefined;
    session: PiAgentSession;
    prompt: string;
    skip: boolean;
    logContext: RequestLogContext;
  }): Promise<void> {
    if (!input.conversation || input.skip) return;
    const conversation = input.conversation;
    // Map every historical user row back to its clean stored text so old injected blocks are
    // removed too, not only the current turn's.
    const userTextById = new Map<string, string>();
    for (const message of conversation.history) {
      if (message.role !== "user") continue;
      try {
        userTextById.set(
          message.id,
          this.parseTextBlocks(message.contentJson)
            .map((block) => block.text)
            .join("\n"),
        );
      } catch {
        // A malformed historical row is left untouched; the current prompt still gets cleaned.
      }
    }
    const entries: SessionEntry[] = replaceInjectedUserText(
      input.session.sessionManager.getEntries(),
      input.prompt,
      userTextById,
    );
    if (entries.length === 0) return;
    // An image or SVG the model just wrote is already on disk; replaying its body on every later
    // turn only spends context, so the snapshot keeps a placeholder that still names the path.
    const pruned = pruneImageWritePayloads(entries, (writtenPath) =>
      this.isPrunableSessionFile(conversation.id, writtenPath),
    );
    if (pruned.prunedWrites > 0) {
      writeStructuredEvent(
        this.logger,
        "log",
        "llm.session_snapshot.image_payload_pruned",
        {
          ...input.logContext,
          prunedWrites: pruned.prunedWrites,
          bytesRemoved: pruned.bytesRemoved,
        },
      );
    }
    try {
      await this.piSessionSnapshots.saveSnapshot(
        conversation.id,
        pruned.entries,
      );
    } catch (error) {
      writeStructuredEvent(
        this.logger,
        "error",
        "llm.session_snapshot.save.failed",
        {
          ...input.logContext,
          entryCount: entries.length,
          ...getSafeErrorLogFields(error),
        },
      );
    }
  }

  /**
   * Reports whether one written path is still a file inside this conversation's workspace.
   *
   * The prune guard: a body is only replaced when the file it describes still exists where the
   * session can read it again. Relative paths resolve against the workspace, which is the working
   * directory the model writes into.
   */
  private isPrunableSessionFile(
    conversationId: string,
    writtenPath: string,
  ): boolean {
    try {
      const workspaceRoot = resolve(
        this.settings.getSessionWorkspaceDirectory(conversationId),
      );
      const absolutePath = isAbsolute(writtenPath)
        ? writtenPath
        : resolve(workspaceRoot, writtenPath);
      if (!isPathWithin(workspaceRoot, absolutePath)) return false;
      return statSync(absolutePath, { throwIfNoEntry: false })?.isFile() ?? false;
    } catch {
      return false;
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
    // A broken tool pair makes every later provider call fail, so the restored entries are
    // checked on both sources, and a repair is persisted before the provider runs.
    const checked = checkSessionEntries(restored.entries);
    const changed =
      checked.removedToolResults + checked.strippedToolCalls + checked.relinkedEntries > 0;
    if (changed) {
      writeStructuredEvent(this.logger, "warn", "llm.session_snapshot.repaired", {
        ...logContext,
        source: restored.source,
        removedToolResults: checked.removedToolResults,
        strippedToolCalls: checked.strippedToolCalls,
        relinkedEntries: checked.relinkedEntries,
        restoredEntryCount: checked.entries.length,
      });
      try {
        await this.piSessionSnapshots.saveSnapshot(conversation.id, checked.entries);
      } catch (error) {
        writeStructuredEvent(
          this.logger,
          "error",
          "llm.session_snapshot.repair_save.failed",
          {
            ...logContext,
            ...getSafeErrorLogFields(error),
          },
        );
      }
    }
    writeStructuredEvent(this.logger, "log", "llm.session.restore.completed", {
      ...logContext,
      source: restored.source,
      rebuiltEntryCount: rebuiltEntries.length,
      snapshotEntryCount: snapshotEntries?.length ?? 0,
      restoredEntryCount: checked.entries.length,
    });
    return checked.entries;
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
    if (!Array.isArray(value) || !value.every(isStoredTextBlock)) {
      throw new Error("Stored conversation content is not valid text blocks.");
    }
    return value;
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

}
