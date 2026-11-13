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
const { runPiTurn } = load('llm/pi-agent-runtime.js');

/** Minimal session whose prompt never settles, matching a hung provider. */
function createHangingSession() {
  return {
    aborted: 0,
    prompt: () => new Promise(() => undefined),
    async abort() {
      this.aborted += 1;
    },
    messages: [],
    getLastAssistantText: () => undefined,
  };
}

test('a turn without a provider answer fails at the timeout and aborts the session', async () => {
  const session = createHangingSession();
  await assert.rejects(
    () => runPiTurn(session, '讲课', { timeoutMs: 50 }),
    /timed out/,
  );
  assert.equal(session.aborted, 1);
});

test('an aborted caller cancels the turn instead of waiting', async () => {
  const session = createHangingSession();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    () => runPiTurn(session, '讲课', { signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(session.aborted, 1);
});

test('a caller signal that is already aborted never prompts', async () => {
  let prompted = false;
  const session = {
    ...createHangingSession(),
    prompt: () => {
      prompted = true;
      return new Promise(() => undefined);
    },
  };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runPiTurn(session, '讲课', { signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(prompted, false);
});
