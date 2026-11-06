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

/** Adds request-scoped cancellation to streamed LLM calls. */
export interface LlmStreamOptions extends LlmRequestOptions {
  signal?: AbortSignal;
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
/** Provides shared model generation and streaming with request-scoped Pi sessions. */
export class LlmService {
  private piSdkPromise?: Promise<PiSdk>;
  private billionContextFactoryPromise?: Promise<PiExtensionFactory>;
  private piSubagentsFactoryPromise?: Promise<PiExtensionFactory>;
  private modelRuntimePromise?: Promise<PiModelRuntime>;

  /** Injects the configured provider adapters used to create model runtimes. */
  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly customAdapter: CustomLLMAdapter,
  ) {}

  /** Generates a complete response for callers that do not need deltas. */
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

  /**
   * 逐段产出模型文本，并在请求取消时中止底层 Pi run。
   * async generator 被调用时先返回生成器对象；只有消费者调用 next() 后，函数体才开始执行。
   * 每次 yield 会把一个文本片段交给消费者，并暂停在当前位置，等下一次 next() 再继续。
   */
  async *stream(
    prompt: string,
    options: LlmStreamOptions = {},
  ): AsyncGenerator<string> {
    if (options.signal?.aborted) return;

    const session = await this.createSession(options);
    // deltas 是生产者（模型事件回调）与消费者（下面的生成器循环）之间的缓冲队列。
    const deltas: string[] = [];
    // 只表示 session.prompt() 整次运行已结束或失败；结束后仍要把队列里剩余片段交完。
    let runSettled = false;
    let runError: unknown;
    let hasRunError = false;
    // 暂存当前 await 所对应的 Promise resolve；有新片段或运行结束时由 wake() 调用。
    let wakeConsumer: (() => void) | undefined;
    let unsubscribe = (): void => undefined;
    let abortPromise: Promise<void> | undefined;

    const wake = (): void => {
      // wake 不传递文本，只负责解除消费者的等待；文本仍保存在 deltas 队列中。
      const wake = wakeConsumer;
      wakeConsumer = undefined;
      wake?.();
    };

    /** Aborts the Pi run once and wakes a consumer waiting for another delta. */
    const abortSession = (): void => {
      if (!abortPromise) {
        try {
          abortPromise = session.abort().catch(() => undefined);
        } catch {
          abortPromise = Promise.resolve();
        }
      }
      wake();
    };

    try {
      options.signal?.addEventListener('abort', abortSession, { once: true });
      if (options.signal?.aborted) {
        abortSession();
        return;
      }

      unsubscribe = session.subscribe((event) => {
        if (
          event.type === 'message_update' &&
          event.assistantMessageEvent.type === 'text_delta'
        ) {
          // 模型每产生一个文本片段就先入队，再唤醒正在等待的生成器循环。
          deltas.push(event.assistantMessageEvent.delta);
          wake();
        }
      });

      // 先启动底层模型请求，它与下方消费队列的循环并行推进。
      // 请求成功或失败时都设置结束状态并唤醒循环，避免最后没有新片段时一直等待。
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

      // 运行尚未结束，或还有未交付的片段时继续；这样能排空最后一批缓冲文本。
      while (!runSettled || deltas.length > 0) {
        if (options.signal?.aborted) {
          deltas.length = 0;
          break;
        }

        if (deltas.length > 0) {
          // yield 把一个片段作为 iterator.next() 的 value 交给 Controller，随后暂停本生成器。
          yield deltas.shift()!;
          continue;
        }

        // 队列暂时为空时挂起本生成器（不会阻塞 JS 线程）。
        // Promise executor 会立即把 resolve 保存到 wakeConsumer；新片段到达后 wake() 调用它，
        // await 才会恢复并重新检查队列。这里保存 resolve 而不调用它，所以不会立刻继续循环。
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }

      await run;
      if (options.signal?.aborted) return;
      if (hasRunError) {
        throw runError;
      }

      this.readAssistantText(session);
    } finally {
      // 无论自然结束、报错还是取消，都解除监听并释放本次请求的 session。
      options.signal?.removeEventListener('abort', abortSession);
      if (options.signal?.aborted) await abortPromise;
      unsubscribe();
      session.dispose();
    }
  }

  /** Creates a request-scoped Pi session with the configured model and extensions. */
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

  /** Loads and caches the Pi SDK module. */
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

  /** Creates one cached model runtime and registers configured adapters. */
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

  /** Reads the latest assistant text and rejects empty provider completions. */
  private readAssistantText(session: PiAgentSession): string {
    const text = session.getLastAssistantText();
    if (!text?.trim()) {
      throw new Error('Pi SDK completed without returning assistant text.');
    }
    return text;
  }
}
