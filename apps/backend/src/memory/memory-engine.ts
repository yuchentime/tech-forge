import { Logger } from '@nestjs/common';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Db0Backend, Harness } from '@db0-ai/core';
import type { EmbeddingService } from '../embedding/embedding.service';

type Db0Core = typeof import('@db0-ai/core');
type Db0Sqlite = typeof import('@db0-ai/backends-sqlite');

/** The backend resolves ESM-only db0 modules at runtime, like the Pi SDK loader. */
const importEsm = new Function('specifier', 'return import(specifier)') as <T>(
  specifier: string,
) => Promise<T>;

/** SQLite file name inside `<configDir>/memory`. */
const DATABASE_FILE = 'db0.sqlite';
/** Lock file guarding the single sql.js writer. */
const LOCK_FILE = '.lock';
/** Daily backups kept beside the live database. */
const BACKUP_LIMIT = 3;

/** Embedding identity persisted in `db0_meta`; changing it requires a re-embed. */
export function memoryEmbeddingId(embedding: EmbeddingService): string {
  return `local:${embedding.modelId}:${embedding.dimension}`;
}

/** Raised when another live process owns the memory database. */
export class MemoryLockedError extends Error {
  constructor(readonly holderPid: number | null) {
    super('Long-term memory is already open in another TeachForge process.');
    this.name = 'MemoryLockedError';
  }
}

/** One process-wide memory engine: a SQLite backend plus harness construction. */
export interface MemoryEngine {
  readonly embeddingId: string;
  /** Creates a stateless harness for one conversation; cheap and never opens a connection. */
  getHarness(conversationId: string): Harness;
  /** Removes the lock and closes the sql.js database. */
  close(): void;
}

/** Inputs shared by initialization and harness construction. */
export interface MemoryEngineOptions {
  directory: string;
  embedding: EmbeddingService;
  logger: Logger;
}

/**
 * Opens the process-wide memory database.
 *
 * Order matters: acquire the single-writer lock, back up yesterday's file, then load sql.js.
 * A second app instance must never be able to overwrite memories written by the first.
 */
export async function openMemoryEngine(
  options: MemoryEngineOptions,
): Promise<MemoryEngine> {
  const { directory, embedding, logger } = options;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = acquireLock(directory);
  try {
    backupDatabase(directory, logger);
    const [core, sqlite] = await Promise.all([
      importEsm<Db0Core>('@db0-ai/core'),
      importEsm<Db0Sqlite>('@db0-ai/backends-sqlite'),
    ]);
    const backend: Db0Backend = await sqlite.createSqliteBackend({
      dbPath: join(directory, DATABASE_FILE),
    });
    const embeddingId = memoryEmbeddingId(embedding);
    const embeddingFn = (text: string) => embedding.embedOne(text);
    const batchEmbeddingFn = (texts: string[]) => embedding.embed(texts);

    const getHarness = (conversationId: string): Harness =>
      core.db0.harness({
        agentId: 'teachforge',
        sessionId: conversationId,
        userId: 'local-user',
        backend,
        embeddingFn,
        batchEmbeddingFn,
        profile: core.mergeProfiles(core.PROFILE_CODING_ASSISTANT, {
          ...core.PROFILE_CODING_ASSISTANT,
          // Fallback only: every caller (prompt pack, tool search, write dedupe) passes its own
          // minScore/limit, so the injection floor lives in `memory.service.ts`.
          retrieval: {
            scoring: 'similarity',
            minScore: 0.65,
            topK: 3,
            graphExpand: { enabled: false },
          },
          context: { ...core.PROFILE_CODING_ASSISTANT.context, includeEdges: false },
        }),
      });

    const status = await getHarness('init').embeddingStatus(embeddingId);
    if (status.storedId === null) {
      await backend.metaSet('embedding_id', embeddingId);
    } else if (status.migrationNeeded) {
      const migrated = await getHarness('init').migrateEmbeddings(
        embeddingFn,
        batchEmbeddingFn,
        embeddingId,
      );
      logger.log(
        `memory.embedding.migrated reEmbedded=${migrated.reEmbedded} failed=${migrated.failed}`,
      );
    }

    return {
      embeddingId,
      getHarness,
      close: () => {
        backend.close();
        rmSync(lockPath, { force: true });
      },
    };
  } catch (error) {
    rmSync(lockPath, { force: true });
    throw error;
  }
}

/** Creates the lock with `wx`; a stale holder is reclaimed exactly once. */
function acquireLock(directory: string): string {
  const lockPath = join(directory, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      );
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readLockPid(lockPath);
      if (holder !== null && isProcessAlive(holder)) {
        throw new MemoryLockedError(holder);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new MemoryLockedError(null);
}

/** Reads the holder PID, treating an unreadable lock as stale. */
function readLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** Probes a PID without signaling it; EPERM still means the process exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Copies today's database once and keeps at most three dated backups. */
function backupDatabase(directory: string, logger: Logger): void {
  const databasePath = join(directory, DATABASE_FILE);
  if (!existsSync(databasePath)) return;
  const backupDirectory = join(directory, 'backup');
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const date = new Date().toISOString().slice(0, 10);
  const target = join(backupDirectory, `db0-${date}.sqlite`);
  if (existsSync(target)) return;
  try {
    copyFileSync(databasePath, target);
    const backups = readdirSync(backupDirectory)
      .filter((name) => /^db0-\d{4}-\d{2}-\d{2}\.sqlite$/u.test(name))
      .sort();
    while (backups.length > BACKUP_LIMIT) {
      const oldest = backups.shift();
      if (oldest) rmSync(join(backupDirectory, oldest), { force: true });
    }
    logger.log(`memory.backup.written ${target}`);
  } catch (error) {
    logger.warn(
      `memory.backup.failed ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
