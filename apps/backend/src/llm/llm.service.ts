import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import type {
  AgentSession as PiAgentSession,
  ExtensionFactory as PiExtensionFactory,
  ModelRuntime as PiModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { CustomLLMAdapter } from './adapters/custom-llm.adapter';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type BillionContextPi = typeof import('billion-context-pi');
type PiSubagents = typeof import('pi-subagents');
type PiThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface LlmRequestOptions {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: PiThinkingLevel;
}

const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';
const BILLION_CONTEXT_PACKAGE = 'billion-context-pi';
const PI_SUBAGENTS_PACKAGE = 'pi-subagents';
const PI_SUBAGENTS_ROOT = dirname(dirname(require.resolve(PI_SUBAGENTS_PACKAGE)));
const SYSTEM_PROMPT =
  'You are a language model provider for TeachForge. Answer the supplied prompt directly. Do not access local files or invoke tools unless the user explicitly asks for work that requires them. Use context-management tools only to manage conversation context. Delegate only when the user requests delegation or the task clearly calls for parallel work.';

// The backend is compiled as CommonJS while Pi publishes an ESM-only entry point.
const importPiSdk = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<PiSdk>;
const importBillionContext = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<BillionContextPi>;
const importPiSubagents = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<PiSubagents>;

@Injectable()
export class LlmService {
  private piSdkPromise?: Promise<PiSdk>;
  private billionContextFactoryPromise?: Promise<PiExtensionFactory>;
  private piSubagentsFactoryPromise?: Promise<PiExtensionFactory>;
  private modelRuntimePromise?: Promise<PiModelRuntime>;

  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly customAdapter: CustomLLMAdapter,
  ) {}

  async generate(
    prompt: string,
    options: LlmRequestOptions = {},
  ): Promise<string> {
    const session = await this.createSession(options);

    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      return this.readAssistantText(session);
    } finally {
      session.dispose();
    }
  }

  async *stream(
    prompt: string,
    options: LlmRequestOptions = {},
  ): AsyncGenerator<string> {
    const session = await this.createSession(options);
    const deltas: string[] = [];
    let runSettled = false;
    let runError: unknown;
    let hasRunError = false;
    let wakeConsumer: (() => void) | undefined;
    let unsubscribe = (): void => undefined;

    const wake = (): void => {
      const wake = wakeConsumer;
      wakeConsumer = undefined;
      wake?.();
    };

    try {
      unsubscribe = session.subscribe((event) => {
        if (
          event.type === 'message_update' &&
          event.assistantMessageEvent.type === 'text_delta'
        ) {
          deltas.push(event.assistantMessageEvent.delta);
          wake();
        }
      });

      const run = session
        .prompt(prompt, { expandPromptTemplates: false })
        .then(
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

      while (!runSettled || deltas.length > 0) {
        if (deltas.length > 0) {
          yield deltas.shift()!;
          continue;
        }

        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }

      await run;
      if (hasRunError) {
        throw runError;
      }

      this.readAssistantText(session);
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  private async createSession(
    options: LlmRequestOptions,
  ): Promise<PiAgentSession> {
    const sdk = await this.getPiSdk();
    const modelRuntime = await this.getModelRuntime(sdk);

    if (Boolean(options.providerId) !== Boolean(options.modelId)) {
      throw new Error('providerId and modelId must be supplied together.');
    }

    if (options.providerId === this.deepseekAdapter.providerId) {
      const error = this.deepseekAdapter.getConfigurationError();
      if (error) throw new Error(error);
    } else if (options.providerId === this.customAdapter.providerId) {
      const error = this.customAdapter.getConfigurationError();
      if (error) throw new Error(error);
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

    const cwd = process.cwd();
    const agentDir = sdk.getAgentDir();
    const billionContextExtension = await this.getBillionContextExtension();
    const piSubagentsExtension = await this.getPiSubagentsExtension();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [billionContextExtension, piSubagentsExtension],
      additionalSkillPaths: [join(PI_SUBAGENTS_ROOT, 'skills')],
      additionalPromptTemplatePaths: [join(PI_SUBAGENTS_ROOT, 'prompts')],
      systemPrompt: SYSTEM_PROMPT,
    });

    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: options.thinkingLevel ?? 'medium',
      resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(),
      noTools: 'builtin',
    });

    return session;
  }

  private getPiSdk(): Promise<PiSdk> {
    this.piSdkPromise ??= importPiSdk(PI_SDK_PACKAGE);
    return this.piSdkPromise;
  }

  /** Loads ACP as the sole inline extension, without its auto-update or delegation side effects. */
  private getBillionContextExtension(): Promise<PiExtensionFactory> {
    this.billionContextFactoryPromise ??= importBillionContext(
      BILLION_CONTEXT_PACKAGE,
    ).then(({ createAcpExtension }) =>
      createAcpExtension({
        autoUpdate: false,
        delegate: false,
      }),
    );
    return this.billionContextFactoryPromise;
  }

  /** Loads pi-subagents and its package-declared skills and prompt templates. */
  private getPiSubagentsExtension(): Promise<PiExtensionFactory> {
    this.piSubagentsFactoryPromise ??= importPiSubagents(
      PI_SUBAGENTS_PACKAGE,
    ).then(({ default: registerExtension }) => registerExtension);
    return this.piSubagentsFactoryPromise;
  }

  private getModelRuntime(sdk: PiSdk): Promise<PiModelRuntime> {
    this.modelRuntimePromise ??= sdk.ModelRuntime.create({
      refreshOnCreate: false,
    }).then((runtime) => {
      this.deepseekAdapter.register(runtime);
      this.customAdapter.register(runtime);
      return runtime;
    });
    return this.modelRuntimePromise;
  }

  private readAssistantText(session: PiAgentSession): string {
    const text = session.getLastAssistantText();
    if (!text?.trim()) {
      throw new Error('Pi SDK completed without returning assistant text.');
    }
    return text;
  }
}
