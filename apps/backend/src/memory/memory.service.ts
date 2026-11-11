import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { mkdir } from 'node:fs/promises';
import type { ExtensionFactory as PiExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { MemoryEntry, MemorySearchResult } from '@db0-ai/core';
import { EmbeddingService } from '../embedding/embedding.service';
import { SettingsService } from '../settings/settings.service';
import {
  MemoryLockedError,
  memoryEmbeddingId,
  openMemoryEngine,
  type MemoryEngine,
} from './memory-engine';
import { createMemoryToolsExtension } from './memory-extension';
import {
  MemoryRejectedError,
  MemoryUnavailableError,
} from './memory-errors';
export { MemoryRejectedError, MemoryUnavailableError } from './memory-errors';
import {
  isExcludedMemory,
  memoryPolarity,
  normalizeMemoryText,
  selectMemoryCandidates,
} from './memory-policy';

/** Rendered header for the per-turn memory block. */
export const MEMORY_CONTEXT_HEADER = '## 长期记忆';
/** db0 estimates tokens as text.length / 4; the item cap covers the Chinese undercount. */
const MEMORY_TOKEN_BUDGET = 400;
/** Maximum memories injected into one turn. */
const MEMORY_MAX_ITEMS = 3;
/** Similarity floor for injection, calibrated on Chinese bge probes. */
const MEMORY_MIN_SCORE = 0.65;
/** Characters kept from one memory in the prompt block. */
const MEMORY_CONTENT_MAX_CHARS = 200;
/** Injection must never delay the first token noticeably. */
const MEMORY_CONTEXT_TIMEOUT_MS = 1500;
/** Tool search is intentionally looser than injection so the assistant can judge. */
const MEMORY_TOOL_MIN_SCORE = 0.35;
/** Similarity needed before a write may supersede an opposite-polarity memory. */
const MEMORY_SUPERSEDE_SCORE = 0.8;

/** One memory as exposed to tools and the local management API. */
export interface MemoryRecord {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  score?: number;
}

/** Outcome of one write; `duplicate` and `superseded` must be distinguishable to the model. */
export interface MemoryWriteResult {
  status: 'saved' | 'duplicate' | 'superseded';
  id: string | null;
  supersedes?: string;
}

/** Disabled reasons surfaced in diagnostics and tests. */
export type MemoryDisabledReason = 'locked' | 'init_failed';

/**
 * Owns long-term memory: the db0 engine, local embeddings, Pi tools, prompt context, and the
 * explicit user-statement capture path.
 *
 * Memory is user-scoped and global across conversations. Every failure degrades to "no memory":
 * chat must never fail because the memory database, the lock, or the embedding model is broken.
 */
@Injectable()
export class MemoryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MemoryService.name);
  private enginePromise?: Promise<MemoryEngine>;
  private engine?: MemoryEngine;
  /** Serializes writes because sql.js persists the whole file on every mutation. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private disabledReason: MemoryDisabledReason | null = null;
  /** Stops the delayed warmup from reopening the database after shutdown. */
  private closed = false;
  /** Emits the ready line once, not on every buildChatContext/tool call. */
  private engineLogged = false;

  /** Injects the local embedding model and the config-root path owner. */
  constructor(
    private readonly embedding: EmbeddingService,
    private readonly settings: SettingsService,
  ) {}

  /** Creates the memory root and warms the engine/model without blocking startup. */
  async onModuleInit(): Promise<void> {
    const directory = this.settings.getMemoryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      this.logger.warn(
        `memory.directory.failed ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const timer = setTimeout(() => {
      if (!this.closed) void this.warmUp();
    }, 2000);
    timer.unref?.();
  }

  /** Releases the lock and closes the database. */
  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    try {
      const engine = this.engine ?? (await this.enginePromise);
      engine?.close();
    } catch {
      // Initialization already logged its failure; shutdown must stay quiet.
    } finally {
      this.engine = undefined;
      this.enginePromise = undefined;
    }
  }

  /** True when the engine initialized and no lock/init failure disabled it. */
  isAvailable(): boolean {
    return this.disabledReason === null;
  }

  /** Returns the current disabled reason for diagnostics and tests. */
  getDisabledReason(): MemoryDisabledReason | null {
    return this.disabledReason;
  }

  /** Returns the prompt block for one turn; empty on any failure. */
  async buildChatContext(userPrompt: string): Promise<string> {
    const prompt = userPrompt.trim();
    if (prompt.length === 0) return '';
    const engine = await this.ensureEngine();
    if (!engine) return '';
    const startedAt = Date.now();
    try {
      const packed = await withTimeout(
        engine.getHarness('context').context().pack(prompt, {
          scopes: ['user'],
          tokenBudget: MEMORY_TOKEN_BUDGET,
          maxItems: MEMORY_MAX_ITEMS,
          minScore: MEMORY_MIN_SCORE,
        }),
        MEMORY_CONTEXT_TIMEOUT_MS,
      );
      const items = packed.memories
        .filter((memory) => memory.status === 'active')
        .sort(
          (left, right) =>
            right.score - left.score ||
            Date.parse(right.createdAt) - Date.parse(left.createdAt),
        )
        .slice(0, MEMORY_MAX_ITEMS);
      if (items.length === 0) return '';
      const lines = items.map((memory) => `- ${formatMemoryLine(memory)}`);
      this.logger.log(
        `memory.context.built items=${lines.length} elapsedMs=${Date.now() - startedAt}`,
      );
      return [
        MEMORY_CONTEXT_HEADER,
        '以下内容来自跨会话长期记忆；只在与当前请求相关时使用，不要逐条复述。若与用户当前指令或 SOULS 风格设置冲突，以当前指令 / SOULS 为准。',
        ...lines,
      ].join('\n');
    } catch (error) {
      this.logger.warn(
        `memory.context.failed elapsedMs=${Date.now() - startedAt} errorType=${error instanceof Error ? error.name : 'unknown'}`,
      );
      return '';
    }
  }

  /** Returns the Pi extension factory that registers memory tools. */
  async createToolExtension(): Promise<PiExtensionFactory | undefined> {
    const engine = await this.ensureEngine();
    if (!engine) return undefined;
    return createMemoryToolsExtension(this);
  }

  /** Stores one fact through dedup, Chinese polarity conflict detection, then ingestion. */
  async write(content: string, tags: string[] = []): Promise<MemoryWriteResult> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new MemoryRejectedError('记忆内容不能为空。');
    }
    if (trimmed.length > 1000) {
      throw new MemoryRejectedError('记忆内容超过 1000 字。');
    }
    if (isExcludedMemory(trimmed)) {
      throw new MemoryRejectedError(
        '这类内容不写入长期记忆（教学掌握度、凭据或一次性任务）。',
      );
    }
    const engine = await this.ensureEngine();
    if (!engine) throw new MemoryUnavailableError();

    return this.enqueue(async () => {
      const embedding = await this.embedding.embedOne(trimmed);
      const harness = engine.getHarness('write');
      const similar = await harness.memory().search({
        embedding,
        scope: ['user'],
        limit: 5,
        minScore: MEMORY_SUPERSEDE_SCORE,
      });
      const normalized = normalizeMemoryText(trimmed);
      const duplicate = similar.find(
        (memory) => normalizeMemoryText(memoryText(memory)) === normalized,
      );
      if (duplicate) {
        this.logger.log('memory.write.deduped');
        return { status: 'duplicate', id: duplicate.id };
      }

      const polarity = memoryPolarity(trimmed);
      const target =
        polarity === 'neutral'
          ? undefined
          : similar.find((memory) => {
              const previous = memoryPolarity(memoryText(memory));
              return previous !== 'neutral' && previous !== polarity;
            });
      if (target) {
        const entry = await harness.memory().write({
          content: trimmed,
          scope: 'user',
          embedding,
          tags,
          supersedes: target.id,
          metadata: { reason: 'polarity-change' },
        });
        this.logger.log('memory.write.superseded');
        return { status: 'superseded', id: entry.id, supersedes: target.id };
      }

      const result = await harness.context().ingest(trimmed, {
        scope: 'user',
        embedding,
        tags,
      });
      if (result.deduped) {
        this.logger.log('memory.write.deduped');
        return { status: 'duplicate', id: result.id };
      }
      this.logger.log('memory.write.saved');
      return { status: 'saved', id: result.id };
    });
  }

  /** Searches memories with a looser threshold for the model's own tool call. */
  async search(query: string, limit = 5): Promise<MemoryRecord[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const engine = await this.ensureEngine();
    if (!engine) throw new MemoryUnavailableError();
    const embedding = await this.embedding.embedOne(trimmed);
    const results = await engine.getHarness('search').memory().search({
      embedding,
      scope: ['user'],
      limit: Math.min(Math.max(limit, 1), 10),
      minScore: MEMORY_TOOL_MIN_SCORE,
    });
    return results.map(toRecord);
  }

  /** Lists active memories for the model, capped to keep the tool result small. */
  async list(): Promise<MemoryRecord[]> {
    const engine = await this.ensureEngine();
    if (!engine) throw new MemoryUnavailableError();
    const entries = await engine.getHarness('list').memory().list('user');
    return entries
      .filter((entry) => entry.status === 'active')
      .slice(0, 50)
      .map(toRecord);
  }

  /** Lists memories for the local settings view, newest first. */
  async listForUi(): Promise<MemoryRecord[]> {
    const engine = await this.ensureEngine();
    if (!engine) return [];
    const entries = await engine.getHarness('manage').memory().list('user');
    return entries
      .filter((entry) => entry.status === 'active')
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 100)
      .map(toRecord);
  }

  /** Physically removes one memory; missing ids surface as 404. */
  async deleteMemory(id: string): Promise<{ deleted: number }> {
    const engine = await this.ensureEngine();
    if (!engine) throw new MemoryUnavailableError();
    return this.enqueue(async () => {
      const memory = engine.getHarness('manage').memory();
      const entry = await memory.get(id);
      if (!entry) throw new NotFoundException('记忆不存在。');
      await memory.delete(id);
      return { deleted: 1 };
    });
  }

  /** Removes every stored memory, including superseded history. */
  async clearMemories(): Promise<{ deleted: number }> {
    const engine = await this.ensureEngine();
    if (!engine) return { deleted: 0 };
    return this.enqueue(async () => {
      const memory = engine.getHarness('manage').memory();
      const entries = await memory.list();
      for (const entry of entries) {
        await memory.delete(entry.id);
      }
      return { deleted: entries.length };
    });
  }

  /** Captures explicit memory intent from one user message; never throws. */
  captureUserMessage(text: string): void {
    const candidates = selectMemoryCandidates(text);
    if (candidates.length === 0) return;
    void (async () => {
      for (const candidate of candidates) {
        try {
          await this.write(candidate, ['explicit']);
        } catch (error) {
          this.logger.warn(
            `memory.capture.failed errorType=${error instanceof Error ? error.name : 'unknown'}`,
          );
        }
      }
    })();
  }

  /** Runs one write on the shared queue. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** Lazily opens the engine; failure is sticky until the next process start. */
  private async ensureEngine(): Promise<MemoryEngine | null> {
    if (this.closed || this.disabledReason) return null;
    this.enginePromise ??= openMemoryEngine({
      directory: this.settings.getMemoryDirectory(),
      embedding: this.embedding,
      logger: this.logger,
    }).catch((error: unknown) => {
      this.disabledReason =
        error instanceof MemoryLockedError ? 'locked' : 'init_failed';
      this.logger.warn(
        `memory.disabled reason=${this.disabledReason} errorType=${error instanceof Error ? error.name : 'unknown'}`,
      );
      throw error;
    });
    try {
      const engine = await this.enginePromise;
      this.engine = engine;
      if (!this.engineLogged) {
        this.engineLogged = true;
        this.logger.log(`memory.engine.ready embeddingId=${engine.embeddingId}`);
      }
      return engine;
    } catch {
      return null;
    }
  }

  /** Loads the engine and embedding model in the background so the first turn is fast. */
  private async warmUp(): Promise<void> {
    const engine = await this.ensureEngine();
    if (!engine) return;
    try {
      await this.embedding.embedOne('记忆预热');
    } catch {
      // A missing model is reported by the first real call; warmup stays best-effort.
    }
  }
}

/** Resolves after `ms`, rejecting with a timeout marker for diagnostics. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error('memory context timeout')), ms);
  timer.unref?.();
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads db0's string-or-object content as text. */
function memoryText(memory: Pick<MemoryEntry, 'content'>): string {
  return typeof memory.content === 'string'
    ? memory.content
    : JSON.stringify(memory.content);
}

/** Formats one injected memory with its date and a hard character cap. */
function formatMemoryLine(memory: MemorySearchResult): string {
  const created = new Date(memory.createdAt);
  const date = Number.isNaN(created.getTime())
    ? '日期未知'
    : created.toISOString().slice(0, 10);
  const text = memoryText(memory).replace(/\s+/gu, ' ').trim();
  return `[${date}] ${text.slice(0, MEMORY_CONTENT_MAX_CHARS)}`;
}

/** Projects a db0 entry or search result into the API shape. */
function toRecord(memory: MemoryEntry | MemorySearchResult): MemoryRecord {
  return {
    id: memory.id,
    content: memoryText(memory),
    tags: memory.tags,
    createdAt: memory.createdAt,
    ...('score' in memory ? { score: memory.score } : {}),
  };
}
