const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const READY_PREFIX = 'TEACHFORGE_BACKEND_READY=';
const STARTUP_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 90_000;

/** Waits for a backend readiness line without exposing inherited credentials. */
function waitForBackend(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Timed out starting backend.')), STARTUP_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const readyLine = output
        .split(/\r?\n/)
        .find((line) => line.startsWith(READY_PREFIX));
      if (!readyLine) return;
      clearTimeout(timer);
      const { port } = JSON.parse(readyLine.slice(READY_PREFIX.length));
      resolve({ port, getStderr: () => stderr });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited before readiness (code ${code}). ${stderr}`));
    });
  });
}

/** Parses complete SSE frames from an incremental response stream. */
function parseSseFrames(buffer) {
  const frames = [];
  let remaining = buffer;
  while (true) {
    const separator = remaining.search(/\r?\n\r?\n/);
    if (separator < 0) break;
    const frame = remaining.slice(0, separator);
    const match = frame.match(/^event: ([^\r\n]+)\r?\ndata: (.*)$/s);
    if (match) frames.push({ event: match[1], data: JSON.parse(match[2]) });
    const delimiter = remaining.slice(separator).match(/^\r?\n\r?\n/)[0];
    remaining = remaining.slice(separator + delimiter.length);
  }
  return { frames, remaining };
}

/** Verifies real local authentication and one explicitly requested DeepSeek stream. */
async function main() {
  const runLiveProvider = process.env.TEACHFORGE_AGENT_LIVE_TEST === '1';
  if (runLiveProvider && !process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required for the live Agent stream check.');
  }

  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'teachforge-agent-stream-'));
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      TEACHFORGE_PORT: '0',
      TEACHFORGE_AUTH_TOKEN: token,
      TEACHFORGE_DATA_DIR: dataDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  try {
    const backend = await waitForBackend(child);
    const endpoint = `http://127.0.0.1:${backend.port}/api/chat/stream`;
    const missingToken = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(missingToken.status, 401);
    assert.doesNotMatch(missingToken.headers.get('content-type') ?? '', /text\/event-stream/);

    const wrongToken = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teachforge-token': 'invalid-token',
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(wrongToken.status, 401);

    const forbiddenOrigin = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teachforge-token': token,
        origin: 'http://example.invalid',
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(forbiddenOrigin.status, 403);

    const healthResponse = await fetch(`http://127.0.0.1:${backend.port}/api/health`, {
      headers: { 'x-teachforge-token': token },
    });
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).status, 'ok');

    const invalidPrompt = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teachforge-token': token,
      },
      body: JSON.stringify({ prompt: '  \n ' }),
    });
    assert.equal(invalidPrompt.status, 400);
    assert.doesNotMatch(invalidPrompt.headers.get('content-type') ?? '', /text\/event-stream/);

    const missingPrompt = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teachforge-token': token,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missingPrompt.status, 400);

    const unknownField = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teachforge-token': token,
      },
      body: JSON.stringify({ prompt: 'hello', extra: true }),
    });
    assert.equal(unknownField.status, 400);

    if (!runLiveProvider) {
      console.log('Local Agent HTTP and health checks passed; live DeepSeek request skipped.');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-teachforge-token': token,
        },
        body: JSON.stringify({
          prompt: '请用中文分 8 点解释缓存雪崩及其防护，每一点写两句话。不要调用工具。',
        }),
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.ok(response.body);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events = [];
      let doneAt;
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.remaining;
        for (const event of parsed.frames) {
          events.push(event);
          if (event.event === 'done') doneAt = Date.now();
          if (event.event === 'error') {
            throw new Error(`Agent stream failed: ${event.data.message}`);
          }
        }
        if (done || doneAt) break;
      }
      await reader.cancel();
      assert.ok(events.some((event) => event.event === 'delta'));
      assert.equal(events.at(-1)?.event, 'done');
      assert.ok(doneAt >= startedAt);
      console.log(`Live DeepSeek stream passed (${events.filter((event) => event.event === 'delta').length} deltas).`);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (child.exitCode === null && !child.killed) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
        resolve();
      }, 2_000).unref();
    });
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
