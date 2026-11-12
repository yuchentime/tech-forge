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
import { dirname, join, resolve } from 'node:path';

/**
 * Name of the per-user root that owns every TeachForge file outside the install directory.
 *
 * Config, knowledge copies, session files, agent memory, managed document copies and the SQLite
 * database all live here, so one directory is enough to back up or relocate an installation.
 */
const USER_ROOT_DIRECTORY_NAME = '.tech-forge';

/**
 * Subdirectory of the persisted-data root that owns the SQLite database and its WAL/SHM files.
 *
 * Keeping the database out of the root leaves it parallel to user-facing directories such as
 * `documents/`, so backing up or inspecting the data root does not have to filter side files.
 */
const DATABASE_DIRECTORY_NAME = 'db';

/** SQLite file name, unchanged across the root-level and `db/` layouts. */
const DATABASE_FILE_NAME = 'teachforge.db';

/**
 * Resolves the configuration root (`config.toml`, `PREFERENCE.md`, knowledge, sessions, memory).
 *
 * `TEACHFORGE_CONFIG_DIR` relocates it for portable installs and isolated integration tests.
 * Evaluated per call so tests can set the variable before Nest constructs the providers.
 */
export function resolveTeachForgeConfigDirectory(): string {
  return process.env.TEACHFORGE_CONFIG_DIR ?? join(homedir(), USER_ROOT_DIRECTORY_NAME);
}

/**
 * Resolves the persisted-data root: the SQLite database (under `db/`) and managed document copies.
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
 * Resolves the SQLite database file inside the persisted-data root.
 *
 * WAL and SHM side files share this `db/` directory. The caller creates the directory because
 * resolving a path must not touch the filesystem.
 */
export function resolveTeachForgeDatabasePath(): string {
  return databasePathIn(resolveTeachForgeDataDirectory());
}

/** Builds the SQLite path for a supplied data root, keeping layout changes in one place. */
function databasePathIn(dataRoot: string): string {
  return join(dataRoot, DATABASE_DIRECTORY_NAME, DATABASE_FILE_NAME);
}

/**
 * Moves data written by older builds into the current layout.
 *
 * Two older locations are handled, newest first:
 * 1. `<dataRoot>/teachforge.db` from builds before the `db/` subdirectory existed.
 * 2. `<legacyDirectory>/teachforge.db` from builds that kept the database under Electron
 *    `userData` (or `<cwd>/.data`).
 *
 * A move happens only while `<dataRoot>/db/teachforge.db` is absent, so newer data is never
 * overwritten. WAL/SHM side files travel with the main file so uncheckpointed writes are not lost.
 * Returns the target root when anything moved.
 */
export function migrateLegacyDataDirectory(
  legacyDirectory: string | undefined,
): string | undefined {
  const target = resolveTeachForgeDataDirectory();
  const targetDatabase = databasePathIn(target);
  let moved = migrateDatabaseIntoSubdirectory(target);

  if (legacyDirectory && resolve(legacyDirectory) !== target && !existsSync(targetDatabase)) {
    const sourceDatabase = join(legacyDirectory, DATABASE_FILE_NAME);
    if (existsSync(sourceDatabase) && moveDatabase(sourceDatabase, targetDatabase)) {
      moved = true;
      const sourceDocuments = join(legacyDirectory, 'documents');
      if (existsSync(sourceDocuments) && !movePath(sourceDocuments, join(target, 'documents'))) {
        process.stderr.write(
          `[data-migration] kept ${sourceDocuments}: ${join(target, 'documents')} already exists\n`,
        );
      }
    }
  }

  return moved ? target : undefined;
}

/**
 * Moves a root-level database into `<dataRoot>/db/` for installs upgraded from the previous layout.
 * Returns whether the database moved.
 */
function migrateDatabaseIntoSubdirectory(dataRoot: string): boolean {
  return moveDatabase(join(dataRoot, DATABASE_FILE_NAME), databasePathIn(dataRoot));
}

/**
 * Moves one SQLite database and its WAL/SHM side files to `destination`.
 *
 * Creates the destination directory when needed. Returns false when the source is missing or the
 * destination already exists, so an existing database is never replaced.
 */
function moveDatabase(source: string, destination: string): boolean {
  if (!existsSync(source) || existsSync(destination)) return false;
  mkdirSync(dirname(destination), { recursive: true });
  if (!movePath(source, destination)) return false;
  for (const suffix of ['-wal', '-shm']) {
    movePath(`${source}${suffix}`, `${destination}${suffix}`);
  }
  return true;
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
