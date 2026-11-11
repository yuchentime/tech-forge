const assert = require('node:assert/strict');
const test = require('node:test');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

/** Isolated build output, shared with the other backend suites. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const {
  migrateLegacyDataDirectory,
  resolveTeachForgeDatabasePath,
} = require(join(buildDirectory, 'platform/local-paths.js'));

const scratchDirectories = [];

/** Creates a temporary directory that the suite removes afterwards. */
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

test.after(() => {
  delete process.env.TEACHFORGE_DATA_DIR;
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resolves the database under the data root db directory', () => {
  const dataDirectory = scratch('teachforge-paths-resolve-');
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  assert.equal(
    resolveTeachForgeDatabasePath(),
    join(dataDirectory, 'db', 'teachforge.db'),
  );
});

test('moves a root-level database and side files into db', () => {
  const dataDirectory = scratch('teachforge-paths-root-');
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;
  writeFileSync(join(dataDirectory, 'teachforge.db'), 'main');
  writeFileSync(join(dataDirectory, 'teachforge.db-wal'), 'wal');
  writeFileSync(join(dataDirectory, 'teachforge.db-shm'), 'shm');

  assert.equal(migrateLegacyDataDirectory(undefined), dataDirectory);
  assert.equal(existsSync(join(dataDirectory, 'teachforge.db')), false);
  assert.equal(
    readFileSync(join(dataDirectory, 'db', 'teachforge.db'), 'utf8'),
    'main',
  );
  assert.equal(
    readFileSync(join(dataDirectory, 'db', 'teachforge.db-wal'), 'utf8'),
    'wal',
  );
  assert.equal(
    readFileSync(join(dataDirectory, 'db', 'teachforge.db-shm'), 'utf8'),
    'shm',
  );
});

test('moves a legacy userData database and documents into the data root', () => {
  const dataDirectory = scratch('teachforge-paths-legacy-target-');
  const legacyDirectory = scratch('teachforge-paths-legacy-source-');
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;
  writeFileSync(join(legacyDirectory, 'teachforge.db'), 'legacy');
  mkdirSync(join(legacyDirectory, 'documents'));
  writeFileSync(join(legacyDirectory, 'documents', 'note.md'), 'note');

  assert.equal(migrateLegacyDataDirectory(legacyDirectory), dataDirectory);
  assert.equal(
    readFileSync(join(dataDirectory, 'db', 'teachforge.db'), 'utf8'),
    'legacy',
  );
  assert.equal(
    readFileSync(join(dataDirectory, 'documents', 'note.md'), 'utf8'),
    'note',
  );
});

test('does not overwrite a database already stored under db', () => {
  const dataDirectory = scratch('teachforge-paths-existing-');
  const legacyDirectory = scratch('teachforge-paths-existing-legacy-');
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;
  mkdirSync(join(dataDirectory, 'db'));
  writeFileSync(join(dataDirectory, 'db', 'teachforge.db'), 'current');
  writeFileSync(join(dataDirectory, 'teachforge.db'), 'root');
  writeFileSync(join(legacyDirectory, 'teachforge.db'), 'legacy');

  assert.equal(migrateLegacyDataDirectory(legacyDirectory), undefined);
  assert.equal(
    readFileSync(join(dataDirectory, 'db', 'teachforge.db'), 'utf8'),
    'current',
  );
  assert.equal(
    readFileSync(join(dataDirectory, 'teachforge.db'), 'utf8'),
    'root',
  );
  assert.equal(existsSync(join(legacyDirectory, 'teachforge.db')), true);
});
