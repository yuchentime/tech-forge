import { resolve } from 'node:path';
import type * as PiSdkModule from '@earendil-works/pi-coding-agent';
import type {
  AgentSession as PiAgentSession,
  ModelRuntime as PiModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { DEEPSEEK_PROVIDER_ID } from './adapters/llm-adapter';
import type { SettingsService } from '../settings/settings.service';

export type PiSdk = typeof PiSdkModule;
export type PiThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** The concrete model resolved from the user's local DeepSeek settings. */
export type PiModel = NonNullable<ReturnType<PiModelRuntime['getModel']>>;

const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

// The backend is compiled as CommonJS while Pi publishes an ESM-only entry point.
const importPiSdk = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<PiSdk>;

let piSdkPromise: Promise<PiSdk> | undefined;

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
