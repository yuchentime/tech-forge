import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Name of the per-user root that owns every TeachForge file outside the install directory.
 *
 * Config, knowledge copies, session files, agent memory, managed document copies and the SQLite
 * database all live here, so one directory is enough to back up or relocate an installation.
 */
const USER_ROOT_DIRECTORY_NAME = '.tech-forge';

/**
 * Resolves the configuration root (`config.toml`, `SOULS.md`, knowledge, sessions, memory).
 *
 * `TEACHFORGE_CONFIG_DIR` relocates it for portable installs and isolated integration tests.
 * Evaluated per call so tests can set the variable before Nest constructs the providers.
 */
export function resolveTeachForgeConfigDirectory(): string {
  return process.env.TEACHFORGE_CONFIG_DIR ?? join(homedir(), USER_ROOT_DIRECTORY_NAME);
}

/**
 * Resolves the persisted-data root: `teachforge.db` (plus WAL/SHM) and managed document copies.
 *
 * `TEACHFORGE_DATA_DIR` relocates it for portable installs and isolated integration tests. Without
 * it the default is the same per-user root used for configuration, never the process working
 * directory. Electron reports an older `userData` root through `TEACHFORGE_LEGACY_DATA_DIR` instead
 * of forcing this value; `migrateLegacyDataDirectory` then moves that data here on first start.
 */
export function resolveTeachForgeDataDirectory(): string {
  return process.env.TEACHFORGE_DATA_DIR ?? join(homedir(), USER_ROOT_DIRECTORY_NAME);
}

/**
 * Moves data written by older builds into the current data root.
 *
 * Earlier builds kept `teachforge.db` under Electron's `userData` (or `<cwd>/.data`) while the
 * configuration already lived in `~/.tech-forge`. The move happens only when the current root has no
 * database yet, so it never overwrites newer data, and the WAL/SHM side files travel with the main
 * file so uncheckpointed writes are not lost. Returns the target root when something moved.
 */
export function migrateLegacyDataDirectory(
  legacyDirectory: string | undefined,
): string | undefined {
  if (!legacyDirectory) return undefined;
  const target = resolveTeachForgeDataDirectory();
  if (resolve(legacyDirectory) === target) return undefined;
  if (existsSync(join(target, 'teachforge.db'))) return undefined;
  const sourceDatabase = join(legacyDirectory, 'teachforge.db');
  if (!existsSync(sourceDatabase)) return undefined;

  mkdirSync(target, { recursive: true });
  if (!movePath(sourceDatabase, join(target, 'teachforge.db'))) return undefined;
  for (const suffix of ['-wal', '-shm']) {
    movePath(`${sourceDatabase}${suffix}`, join(target, `teachforge.db${suffix}`));
  }
  const sourceDocuments = join(legacyDirectory, 'documents');
  if (existsSync(sourceDocuments) && !movePath(sourceDocuments, join(target, 'documents'))) {
    process.stderr.write(
      `[data-migration] kept ${sourceDocuments}: ${join(target, 'documents')} already exists\n`,
    );
  }
  return target;
}

/**
 * Moves one file or directory, copying then deleting only when the two paths sit on different
 * volumes. Returns false when the destination already exists, so nothing is ever merged into it.
 */
function movePath(source: string, destination: string): boolean {
  if (!existsSync(source) || existsSync(destination)) return false;
  try {
    renameSync(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  if (statSync(source).isDirectory()) {
    cpSync(source, destination, { recursive: true });
  } else {
    copyFileSync(source, destination);
  }
  rmSync(source, { recursive: true, force: true });
  return true;
}
