require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));
const { LessonTranscriptStore } = load('lessons/lesson-transcript.store.js');
const { LessonCorruptError } = load('lessons/lesson.errors.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-transcript-'));
test.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** Store with a throwaway settings seam; no Nest container is needed. */
function createStore() {
  const root = mkdtempSync(join(scratchRoot, 'lesson-'));
  return {
    root,
    store: new LessonTranscriptStore({
      getLessonDirectory: (lessonId) => join(root, lessonId),
    }),
  };
}

test('runExclusive serializes tasks per lesson instead of interleaving them', async () => {
  const { store } = createStore();
  const events = [];
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

  const first = store.runExclusive('lesson-a', async () => {
    events.push('a-start');
    await sleep(20);
    events.push('a-end');
  });
  const second = store.runExclusive('lesson-a', async () => {
    events.push('b-start');
  });
  await Promise.all([first, second]);

  // Without the queue this would be a-start, b-start, a-end.
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start']);
});

test('a failed task does not block the next one and the queue is cleaned up', async () => {
  const { store } = createStore();
  await assert.rejects(
    () =>
      store.runExclusive('lesson-a', async () => {
        throw new Error('first failed');
      }),
    /first failed/,
  );
  const value = await store.runExclusive('lesson-a', async () => 'second ran');
  assert.equal(value, 'second ran');
  // Cleanup runs in a microtask after the queue entry settles.
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(store.pendingQueueCount, 0);
});

test('corrupt lines are reported by read() and fatal for readStrict()', async () => {
  const { root, store } = createStore();
  const lessonId = 'lesson-a';
  mkdirSync(join(root, lessonId), { recursive: true });
  writeFileSync(
    join(root, lessonId, 'messages.jsonl'),
    '{"id":"1","speaker":"teacher","text":"ok","createdAt":"2026-01-01T00:00:00.000Z"}\n{"broken":\n',
    'utf8',
  );

  const transcript = await store.read(lessonId);
  assert.equal(transcript.messages.length, 1);
  assert.deepEqual(transcript.corruptLineNumbers, [2]);
  await assert.rejects(() => store.readStrict(lessonId), LessonCorruptError);
});
