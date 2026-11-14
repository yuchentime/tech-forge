import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent as PiAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getSafeErrorLogFields,
  writeStructuredEvent,
} from "../../logging/structured-logger";
import {
  CommonAgent,
  classifyAssistantCompletion,
  composeModelPrompt,
  getProviderRejectionLogFields,
  logPiCompactionEvent,
  type LlmStreamOptions,
} from "./CommonAgent";
import { PiAgentRuntime, getRequestLogContext } from "../pi-agent-runtime";

/**
 * Streams one chat turn as ordered Pi events.
 *
 * `PiAgentRuntime` builds the session and owns its snapshot; this class owns the streaming loop,
 * event queue and request cancellation. It keeps no message state: the durable transcript stays
 * in SQLite and the model context in the Pi snapshot.
 */
@Injectable()
export class LearnAgent {
  private readonly logger = new Logger(LearnAgent.name);

  /** Injects the Pi session runtime and common response classifier. */
  constructor(
    private readonly piAgentRuntime: PiAgentRuntime,
    private readonly commonAgent: CommonAgent,
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
      const { resolved, modelSettings } =
        await this.piAgentRuntime.resolveRequest(options);
      options = resolved;
      session = await this.piAgentRuntime.createSession(
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
        ...(options.images && options.images.length > 0
          ? {
              images: options.images.map((image) => ({
                type: 'image' as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            }
          : {}),
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
        // 只保存 resolve；新事件到达后 wake() 调用它，await 才会恢复并重新检查队列。
        const parked = Promise.withResolvers<void>();
        wakeConsumer = parked.resolve;
        await parked.promise;
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
      const responseText = this.commonAgent.readAssistantText(completion);
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
          ...getProviderRejectionLogFields(error),
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
      await this.piAgentRuntime.saveConversationSnapshot({
        conversation: options.conversation,
        session,
        prompt,
        skip: hasPersistenceError,
        logContext,
      });

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
}
