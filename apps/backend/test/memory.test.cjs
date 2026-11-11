const assert = require('node:assert/strict');
const test = require('node:test');
const { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const buildDirectory = join(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { MemoryService } = require(join(buildDirectory, 'memory/memory.service.js'));
const { SettingsService } = require(join(buildDirectory, 'settings/settings.service.js'));

/** One 512-dimension vector with a single hot axis, so tests control similarity exactly. */
function axisVector(axis) {
  const vector = new Float32Array(512);
  vector[axis] = 1;
  return vector;
}

/** Hash-based fallback embedding for ordinary text. */
function hashVector(text) {
  const vector = new Float32Array(512);
  const normalized = text.toLowerCase();
  for (let index = 0; index < normalized.length - 2; index += 1) {
    let hash = 0x811c9dc5;
    for (const char of normalized.slice(index, index + 3)) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193);
    }
    vector[Math.abs(hash) % 512] += (hash & 1) === 0 ? 1 : -1;
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (magnitude > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
  }
  return vector;
}

/** Builds a stub embedding service whose per-text behaviour tests can swap. */
function createEmbedding() {
  const state = { embed: (text) => hashVector(text) };
  return {
    state,
    embedding: {
      modelId: 'stub-bge',
      dimension: 512,
      embedOne: async (text) => state.embed(text),
      embed: async (texts) => texts.map((text) => state.embed(text)),
    },
  };
}

/** Creates one isolated config root and memory service pair. */
async function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'teachforge-memory-'));
  process.env.TEACHFORGE_CONFIG_DIR = root;
  const settings = new SettingsService();
  await settings.onModuleInit();
  const { embedding, state } = createEmbedding();
  const service = new MemoryService(embedding, settings);
  await service.onModuleInit();
  return { root, settings, service, state, embedding };
}

/** Closes the service and removes the temporary root. */
async function disposeHarness(harness) {
  await harness.service.onApplicationShutdown();
  delete process.env.TEACHFORGE_CONFIG_DIR;
  rmSync(harness.root, { recursive: true, force: true });
}


test('the bundled bge model produces 512-dimension vectors without network', async () => {
  const { EmbeddingService } = require(join(buildDirectory, 'embedding/embedding.service.js'));
  const embedding = new EmbeddingService();
  const vector = await embedding.embedOne('教师偏好先给结论，再给例子。');
  assert.equal(vector.length, 512);
  assert.ok(vector.some((value) => value !== 0));
});

test('memory database lives under the config root and stores 512-dimension vectors', async () => {
  const harness = await createHarness();
  try {
    const result = await harness.service.write('用户偏好：讲解知识点时先给结论。');
    assert.equal(result.status, 'saved');
    await harness.service.onApplicationShutdown();

    const databasePath = join(harness.root, 'memory', 'db0.sqlite');
    assert.equal(existsSync(databasePath), true);
    const Database = require('better-sqlite3');
    const database = new Database(databasePath, { readonly: true });
    try {
      const row = database
        .prepare('select length(embedding) / 4 as dimensions from db0_memory limit 1')
        .get();
      assert.equal(row.dimensions, 512);
      const meta = database
        .prepare("select value from db0_meta where key = 'embedding_id'")
        .get();
      assert.equal(meta.value, 'local:stub-bge:512');
    } finally {
      database.close();
    }
  } finally {
    await disposeHarness(harness);
  }
});

test('writes survive a fresh service and identical content is deduplicated', async () => {
  const harness = await createHarness();
  const first = await harness.service.write('用户是初中数学老师。');
  assert.equal(first.status, 'saved');
  const second = await harness.service.write('用户是初中数学老师。');
  assert.equal(second.status, 'duplicate');
  const records = await harness.service.list();
  assert.equal(records.length, 1);

  await harness.service.onApplicationShutdown();
  const reopened = new MemoryService(
    {
      modelId: 'stub-bge',
      dimension: 512,
      embedOne: async (text) => hashVector(text),
      embed: async (texts) => texts.map((text) => hashVector(text)),
    },
    harness.settings,
  );
  await reopened.onModuleInit();
  const listed = await reopened.list();
  assert.equal(listed.length, 1);
  assert.match(listed[0].content, /初中数学老师/u);
  await reopened.onApplicationShutdown();
  await disposeHarness(harness);
});

test('opposite-polarity content supersedes a similar memory', async () => {
  const harness = await createHarness();
  try {
    harness.state.embed = () => axisVector(0);
    const original = await harness.service.write('生成文档时使用英文标题。');
    assert.equal(original.status, 'saved');
    const corrected = await harness.service.write('以后不要用英文标题。');
    assert.equal(corrected.status, 'superseded');
    assert.equal(corrected.supersedes, original.id);

    const active = await harness.service.list();
    assert.equal(active.length, 1);
    assert.match(active[0].content, /不要用英文标题/u);

    const Database = require('better-sqlite3');
    const database = new Database(join(harness.root, 'memory', 'db0.sqlite'), {
      readonly: true,
    });
    try {
      const statuses = database
        .prepare('select status from db0_memory order by created_at')
        .all()
        .map((row) => row.status);
      assert.deepEqual(statuses, ['superseded', 'active']);
    } finally {
      database.close();
    }
  } finally {
    await disposeHarness(harness);
  }
});

test('excluded content and empty input are rejected before storage', async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      () => harness.service.write('学生正确率只有 60%'),
      /不写入长期记忆/u,
    );
    await assert.rejects(() => harness.service.write('   '), /不能为空/u);
    const records = await harness.service.list();
    assert.equal(records.length, 0);
  } finally {
    await disposeHarness(harness);
  }
});

test('explicit capture stores one sentence and ignores task chatter', async () => {
  const harness = await createHarness();
  try {
    harness.service.captureUserMessage('记住，以后都用简体中文。帮我看看这道题。');
    await waitFor(async () => (await harness.service.list()).length > 0, 3000);
    const records = await harness.service.list();
    assert.equal(records.length, 1);
    assert.match(records[0].content, /简体中文/u);

    harness.service.captureUserMessage('帮我看看这道题');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await harness.service.list()).length, 1);
  } finally {
    await disposeHarness(harness);
  }
});

test('context injection applies the relevance floor and item caps', async () => {
  const harness = await createHarness();
  try {
    harness.state.embed = () => axisVector(1);
    await harness.service.write('用户偏好：先给结论再给例子。');

    harness.state.embed = () => axisVector(2);
    assert.equal(await harness.service.buildChatContext('随便问问'), '');

    harness.state.embed = () => axisVector(1);
    const context = await harness.service.buildChatContext('怎么讲这道题');
    assert.match(context, /^## 长期记忆/u);
    assert.match(context, /先给结论/u);
    assert.match(context, /SOULS/u);
    assert.ok(context.split('\n').filter((line) => line.startsWith('- ')).length <= 3);
  } finally {
    await disposeHarness(harness);
  }
});

test('a live lock disables memory instead of writing a second database', async () => {
  const harness = await createHarness();
  try {
    await harness.service.onApplicationShutdown();
    writeFileSync(
      join(harness.root, 'memory', '.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const blocked = new MemoryService(harness.embedding, harness.settings);
    await blocked.onModuleInit();
    assert.equal(await blocked.createToolExtension(), undefined);
    assert.equal(blocked.getDisabledReason(), 'locked');
    await blocked.onApplicationShutdown();
  } finally {
    await disposeHarness(harness);
  }
});

test('opening an existing database writes a dated backup', async () => {
  const harness = await createHarness();
  try {
    await harness.service.write('用户喜欢用类比讲解。');
    await harness.service.onApplicationShutdown();
    const reopened = new MemoryService(harness.embedding, harness.settings);
    await reopened.onModuleInit();
    await reopened.list();
    const backups = readdirSync(join(harness.root, 'memory', 'backup')).filter((name) =>
      /^db0-\d{4}-\d{2}-\d{2}\.sqlite$/u.test(name),
    );
    assert.equal(backups.length, 1);
    await reopened.onApplicationShutdown();
  } finally {
    await disposeHarness(harness);
  }
});

test('management operations delete one memory and clear the rest', async () => {
  const harness = await createHarness();
  try {
    const first = await harness.service.write('用户喜欢先给结论。');
    const second = await harness.service.write('用户是数学老师。');
    assert.equal((await harness.service.listForUi()).length, 2);
    assert.deepEqual(await harness.service.deleteMemory(first.id), { deleted: 1 });
    assert.equal((await harness.service.listForUi()).length, 1);
    assert.deepEqual(await harness.service.clearMemories(), { deleted: 1 });
    assert.equal((await harness.service.listForUi()).length, 0);
    assert.ok(second.id);
  } finally {
    await disposeHarness(harness);
  }
});

/** Polls one condition without assuming a fixed write latency. */
async function waitFor(condition, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition not met before timeout');
}
