require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const Database = require('better-sqlite3');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));
const {
  LessonActiveUnique1794050000000,
} = load('database/migrations/1794050000000-lesson-active-unique.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-migration-'));
test.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** Builds the pre-index schema and seeds the legacy rows the migration must reconcile. */
async function createLegacyDatabase() {
  const root = mkdtempSync(join(scratchRoot, 'db-'));
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    driver: Database,
    database: join(root, 'legacy.sqlite'),
    entities: [],
    synchronize: false,
  });
  await dataSource.initialize();
  await dataSource.query(`
    CREATE TABLE "lessons" (
      "id" varchar PRIMARY KEY NOT NULL,
      "status" varchar NOT NULL,
      "endedAt" datetime,
      "summaryStatus" varchar NOT NULL DEFAULT 'none',
      "summaryMarkdown" text,
      "summaryError" text,
      "summaryGeneratedAt" datetime,
      "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
      "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await dataSource.query(
    `INSERT INTO "lessons" ("id", "status", "createdAt") VALUES
      ('older', 'active', '2026-01-01 00:00:00'),
      ('newer', 'active', '2026-01-02 00:00:00')`,
  );
  return { dataSource, root };
}

test('the active-unique migration closes older actives and keeps the newest', async () => {
  const { dataSource, root } = await createLegacyDatabase();
  try {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await new LessonActiveUnique1794050000000().up(runner);
    } finally {
      await runner.release();
    }

    const rows = await dataSource.query(
      'SELECT "id", "status", "endedAt" FROM "lessons" ORDER BY "id"',
    );
    const older = rows.find((row) => row.id === 'older');
    const newer = rows.find((row) => row.id === 'newer');
    assert.equal(older.status, 'ended');
    assert.ok(older.endedAt);
    assert.equal(newer.status, 'active');
    assert.equal(newer.endedAt, null);

    // The partial unique index must reject a second active row.
    await assert.rejects(
      () =>
        dataSource.query(
          `INSERT INTO "lessons" ("id", "status") VALUES ('another', 'active')`,
        ),
      /UNIQUE constraint failed/,
    );
  } finally {
    await dataSource.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
