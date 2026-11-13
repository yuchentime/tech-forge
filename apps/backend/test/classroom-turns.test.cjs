require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { join, resolve } = require('node:path');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));
const { ClassroomTurnsService } = load('classroom/classroom-turns.service.js');

/** Builds a lock service around a fake agent, so no provider call is made. */
function createService(agent) {
  return new ClassroomTurnsService(agent);
}

test('a second turn for the same lesson is rejected while the first runs', async () => {
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  const service = createService({ run: () => gate });

  const running = service.runTurn('lesson-a', '讲课');
  assert.equal(service.isRunning('lesson-a'), true);
  await assert.rejects(
    () => service.runTurn('lesson-a', '再讲一次'),
    /already running/,
  );

  release({ lessonId: 'lesson-a', messages: [] });
  await running;
  assert.equal(service.isRunning('lesson-a'), false);
});

test('different lessons run concurrently', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  const service = createService({
    run: (text, options) => {
      calls.push(options.lessonId);
      return gate.then(() => ({ lessonId: options.lessonId, messages: [] }));
    },
  });

  const first = service.runTurn('lesson-a', 'A');
  const second = service.runTurn('lesson-b', 'B');
  assert.deepEqual(calls, ['lesson-a', 'lesson-b']);

  release();
  await Promise.all([first, second]);
  assert.equal(service.isRunning('lesson-a'), false);
  assert.equal(service.isRunning('lesson-b'), false);
});

test('the lock is released when the turn fails', async () => {
  const service = createService({
    run: async () => {
      throw new Error('provider failed');
    },
  });

  await assert.rejects(() => service.runTurn('lesson-a', '讲课'), /provider failed/);
  assert.equal(service.isRunning('lesson-a'), false);
});
