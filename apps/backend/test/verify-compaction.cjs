const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

/**
 * Verifies that Pi's automatic threshold compaction runs inside one LlmService.stream() call.
 *
 * The check is offline: a local OpenAI-compatible endpoint serves both the summary request and the
 * chat response, and the temp Pi agent directory lowers the threshold to 2000 tokens so a small
 * restored history crosses it. It asserts the compaction lifecycle events, the structured log
 * lines, and the compacted snapshot entry.
 */

/** Serves the minimum OpenAI chat-completions SSE frames Pi needs for one assistant reply. */
function startMockProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        // The assertions below only need the request count; keep the server responsive.
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      requests.push({
        stream: payload.stream === true,
        messageCount: messages.length,
        firstRole: messages[0]?.role,
        firstText:
          typeof messages[0]?.content === 'string'
            ? messages[0].content.slice(0, 200)
            : '',
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const base = {
        id: 'chatcmpl-compaction-check',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? 'mock-model',
      };
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'PI_COMPACTION_OK' },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
        })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Builds stored history rows in the text-block JSON shape LlmService restores. */
function createHistory(messageCount, text) {
  const startedAt = Date.now() - messageCount * 1000;
  return Array.from({ length: messageCount }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    contentJson: JSON.stringify([{ type: 'text', text }]),
    status: 'completed',
    createdAt: new Date(startedAt + index * 1000),
  }));
}

/** Captures JSON log lines written by Nest during the verified run. */
function captureLogs() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = (chunk, ...args) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString();
    return originalWrite(chunk, ...args);
  };
  return {
    text: () => output,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'teachforge-compaction-'));
  const agentDir = path.join(root, 'agent');
  const workspaceRoot = path.join(root, 'workspace-root');
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const sessionWorkspace = path.join(root, 'sessions', conversationId, 'workspace');
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  // Threshold = 128000 - 126000 = 2000 estimated tokens. The restored history is far above it.
  // The global file disables compaction on purpose: the app must force it back on in memory only.
  await writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      compaction: {
        enabled: false,
        reserveTokens: 126000,
        keepRecentTokens: 500,
      },
    }),
    'utf8',
  );
  // The SDK resolves its agent directory at process start, before any session is created.
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const provider = await startMockProvider();
  const logs = captureLogs();
  const snapshots = [];
  try {
    const { LlmService } = require('../dist/llm/llm.service.js');
    const { DeepseekLLMAdapter } = require('../dist/llm/adapters/deepseek-llm.adapter.js');
    const { CustomLLMAdapter } = require('../dist/llm/adapters/custom-llm.adapter.js');

    const settings = {
      getLlmSettings: async () => ({
        provider: 'custom',
        deepseek: { modelId: 'deepseek-flash', apiKey: '' },
        custom: {
          name: 'Compaction Check',
          baseUrl: provider.baseUrl,
          modelId: 'mock-model',
          apiKey: 'test-key',
        },
      }),
      getWorkspacePath: async () => workspaceRoot,
      getSessionWorkspaceDirectory: () => sessionWorkspace,
      getManagedFilePaths: async () => [],
      getKnowledgeDirectory: () => path.join(workspaceRoot, 'knowledge'),
      getStylePreference: async () => '',
      getMemoryDirectory: () => path.join(root, 'memory'),
    };
    const snapshotStore = {
      getSnapshot: async () => null,
      saveSnapshot: async (id, entries) => {
        snapshots.push({ id, entries });
      },
    };

    const service = new LlmService(
      new DeepseekLLMAdapter(),
      new CustomLLMAdapter(),
      settings,
      snapshotStore,
    );

    const history = createHistory(40, '上下文压缩验证文本。'.repeat(120));
    const events = [];
    const requestId = 'compaction-check-request';
    for await (const event of service.stream('请回答 OK', {
      requestId,
      conversation: { id: conversationId, history },
    })) {
      events.push(event);
    }

    const startEvent = events.find((event) => event.type === 'compaction_start');
    const endEvent = events.find((event) => event.type === 'compaction_end');
    assert.ok(startEvent, 'Pi did not emit compaction_start');
    assert.equal(startEvent.reason, 'threshold');
    assert.ok(endEvent, 'Pi did not emit compaction_end');
    assert.equal(endEvent.reason, 'threshold');
    assert.ok(endEvent.result, `Compaction produced no result: ${JSON.stringify(endEvent)}`);
    assert.ok(
      endEvent.result.tokensBefore > 2000,
      'Compaction did not report the pre-compaction token count',
    );
    assert.ok(
      endEvent.result.estimatedTokensAfter < endEvent.result.tokensBefore,
      'Compaction did not reduce estimated context tokens',
    );

    const snapshot = snapshots.at(-1);
    assert.ok(snapshot, 'No compacted snapshot was saved');
    assert.ok(
      snapshot.entries.some((entry) => entry.type === 'compaction'),
      'The saved snapshot does not contain the compaction entry',
    );

    const logText = logs.text().replace(/\x1b\[[0-9;]*m/g, '');
    const logEvents = logText
      .split(/\r?\n/)
      .flatMap((line) => {
        const start = line.indexOf('{"');
        if (start < 0) return [];
        try {
          return [JSON.parse(line.slice(start))];
        } catch {
          return [];
        }
      });
    const createCompleted = logEvents.find(
      (line) => line.event === 'llm.session.create.completed',
    );
    assert.equal(createCompleted?.compactionEnabled, true);
    assert.equal(createCompleted?.compactionReserveTokens, 126000);
    assert.equal(createCompleted?.compactionThresholdTokens, 2000);
    assert.ok(
      logEvents.some((line) => line.event === 'llm.compaction.started'),
      'The compaction start log line is missing',
    );
    assert.ok(
      logEvents.some((line) => line.event === 'llm.compaction.completed'),
      'The compaction completion log line is missing',
    );

    assert.ok(
      provider.requests.length >= 2,
      `Expected a summary request plus the chat request, saw ${provider.requests.length}`,
    );

    // Compaction is enabled through an in-memory override; the app must not rewrite the user's
    // global Pi settings file (the previous setCompactionEnabled(true) call did).
    const persistedSettings = JSON.parse(
      await readFile(path.join(agentDir, 'settings.json'), 'utf8'),
    );
    assert.equal(persistedSettings.compaction.enabled, false);

    console.log(
      `Compaction verification passed: ${events.filter((event) => event.type.startsWith('compaction')).length} compaction events, ` +
        `${provider.requests.length} provider requests, tokens ${endEvent.result.tokensBefore} -> ${endEvent.result.estimatedTokensAfter}.`,
    );
  } finally {
    logs.restore();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
