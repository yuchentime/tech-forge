import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent as PiAgentSessionEvent,
  ExtensionFactory as PiExtensionFactory,
  FileEntry as PiFileEntry,
  ModelRuntime as PiModelRuntime,
  SessionMessageEntry as PiSessionMessageEntry,
} from '@earendil-works/pi-coding-agent';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { CustomLLMAdapter } from './adapters/custom-llm.adapter';
import {
  DEFAULT_LLM_TOOL_MODIFIERS,
  EXCLUDED_LLM_TOOLS,
} from './tools/default-tools';
import { createWorkspaceFileTools } from './tools/workspace-file-tools';
import { parsePersistedPiMessage } from '../conversations/conversation-transcript';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type BillionContextPi = typeof import('billion-context-pi');
type PiSubagents = typeof import('pi-subagents');
type PiThinkingLevel = 'off' | 'low' | 'medium' | 'high';
type PiModel = NonNullable<ReturnType<PiModelRuntime['getModel']>>;

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
  providerId?: string;
  modelId?: string;
  thinkingLevel?: PiThinkingLevel;
  conversation?: LlmConversationContext;
  persistConversationEvent?: (event: PiAgentSessionEvent) => Promise<void>;
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
  'You are a language model provider for TeachForge. Answer the supplied prompt directly. Use file tools only when the requested task needs local files. File tools are confined to the configured workspace; use relative paths and do not request extra permission for operations inside it. Do not use shell or delegate work. If a requested output path is outside the workspace, save the result inside the workspace under the same filename when possible, then report the actual path. Never claim an outside file was written.';

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
    pi.on('message_start', (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on('message_update', (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on('message_end', (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on('tool_execution_start', (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on('tool_execution_update', (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
    pi.on('tool_execution_end', (event) =>
      persistEvent(event as PiAgentSessionEvent),
    );
  };
}

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
   * 按序产出 Pi session 事件，并在请求取消时中止底层 Pi run。
   * async generator 被调用时先返回生成器对象；只有消费者调用 next() 后，函数体才开始执行。
   * 每次 yield 会把一个事件交给消费者，并暂停在当前位置，等下一次 next() 再继续。
   */
  async *stream(
    prompt: string,
    options: LlmStreamOptions = {},
  ): AsyncGenerator<PiAgentSessionEvent> {
    if (options.signal?.aborted) return;

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
            if (!persistenceAbortPromise && activeSession) {
              try {
                persistenceAbortPromise = activeSession
                  .abort()
                  .catch(() => undefined);
              } catch {
                persistenceAbortPromise = Promise.resolve();
              }
            }
            throw error;
          }
        }
      : undefined;
    const session = await this.createSession({
      ...options,
      persistConversationEvent,
    });
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
        // 所有 Pi 事件按回调顺序入队；AgentService 随后决定哪些字段可以出站。
        if (hasPersistenceError) {
          wake();
          return;
        }
        events.push(event);
        wake();
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

      // 运行尚未结束，或还有未交付事件时继续；这样能排空最后一批缓冲事件。
      while (!runSettled || events.length > 0) {
        if (options.signal?.aborted) {
          events.length = 0;
          break;
        }

        if (events.length > 0) {
          // yield 将一个 Pi 事件交给 AgentService；消费方处理后再调用 next() 继续。
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
      if (options.signal?.aborted) return;
      if (hasRunError) {
        throw runError;
      }

      this.readAssistantText(session);
    } finally {
      // 无论自然结束、报错还是取消，都解除监听并释放本次请求的 session。
      options.signal?.removeEventListener('abort', abortSession);
      if (options.signal?.aborted) await abortPromise;
      if (persistenceAbortPromise) await persistenceAbortPromise;
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
    if (options.conversation && !model) {
      throw new Error(
        'A configured Pi model is required to restore conversation history.',
      );
    }

    const cwd = process.cwd();
    const agentDir = sdk.getAgentDir();
    const workspaceFileTools = await createWorkspaceFileTools(sdk, cwd);
    const billionContextExtension = await this.getBillionContextExtension();
    const piSubagentsExtension = await this.getPiSubagentsExtension();
    const extensionFactories = [
      billionContextExtension,
      piSubagentsExtension,
    ];
    if (options.persistConversationEvent) {
      extensionFactories.push(
        createConversationPersistenceExtension(
          options.persistConversationEvent,
        ),
      );
    }
    const systemPrompt = `${SYSTEM_PROMPT}\n\nAgent workspace: ${cwd}`;
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories,
      additionalSkillPaths: [join(PI_SUBAGENTS_ROOT, 'skills')],
      additionalPromptTemplatePaths: [join(PI_SUBAGENTS_ROOT, 'prompts')],
      systemPrompt,
    });
    // The SDK does not reload an explicitly supplied resourceLoader; load only these allowlisted extensions before session creation.
    await resourceLoader.reload();

    const sessionManager = options.conversation
      ? sdk.SessionManager.inMemory(
          cwd,
          { id: options.conversation.id },
          this.createSessionEntries(options.conversation.history, model!),
        )
      : sdk.SessionManager.inMemory();
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: options.thinkingLevel ?? 'medium',
      resourceLoader,
      sessionManager,
      tools: [...DEFAULT_LLM_TOOL_MODIFIERS],
      excludeTools: [...EXCLUDED_LLM_TOOLS],
      customTools: workspaceFileTools,
    });

    return session;
  }

  /** Converts persisted plain-text turns into the Pi SDK's authoritative entry tree. */
  private createSessionEntries(
    history: readonly LlmConversationHistoryMessage[],
    model: PiModel,
  ): PiFileEntry[] {
    let parentId: string | null = null;
    const entries: PiFileEntry[] = [];

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
          type: 'message',
          id: storedMessage.id,
          parentId,
          timestamp: entryTimestamp,
          message: persistedPiMessage.message,
        };
        entries.push(piEntry);
        parentId = piEntry.id;
        continue;
      }

      if (storedMessage.role === 'user') {
        const userMessage: PiSessionMessageEntry['message'] = {
          role: 'user',
          content: this.parseTextBlocks(storedMessage.contentJson),
          timestamp,
        };
        const userEntry: PiSessionMessageEntry = {
          type: 'message',
          id: storedMessage.id,
          parentId,
          timestamp: createdAt.toISOString(),
          message: userMessage,
        };
        entries.push(userEntry);
        parentId = userEntry.id;
        continue;
      }
      if (storedMessage.role !== 'assistant') continue;

      const content = this.parseTextBlocks(storedMessage.contentJson);
      if (content.length === 0) continue;
      const assistantMessage: PiSessionMessageEntry['message'] = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: createEmptyUsage(),
        stopReason:
          storedMessage.status === 'completed'
            ? 'stop'
            : storedMessage.status === 'cancelled'
              ? 'aborted'
              : 'error',
        timestamp,
      };
      const assistantEntry: PiSessionMessageEntry = {
        type: 'message',
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
  ): Array<{ type: 'text'; text: string }> {
    const value: unknown = JSON.parse(contentJson);
    if (
      !Array.isArray(value) ||
      !value.every(
        (block) =>
          typeof block === 'object' &&
          block !== null &&
          !Array.isArray(block) &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
    ) {
      throw new Error('Stored conversation content is not valid text blocks.');
    }
    return value as Array<{ type: 'text'; text: string }>;
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
