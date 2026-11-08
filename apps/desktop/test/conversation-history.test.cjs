const assert = require('node:assert/strict');
const test = require('node:test');
const { toThreadMessage } = require('../dist-electron/src/features/agent/conversation-history.js');
const { AgentEventBus } = require('../dist-electron/src/features/agent/agent-event-bus.js');

/** Creates a text-only API fixture without accessing a user's database or model. */
function historyMessage(role, status, id) {
  return { id, role, status, content: `${role} persisted text`, createdAt: '2026-11-07T00:00:00.000Z' };
}

test('mixed persisted history passes the same package conversion used by thread.reset', async () => {
  const { ExportedMessageRepository } = await import('@assistant-ui/react');
  const rows = [historyMessage('user', 'completed', 'user-1'), historyMessage('assistant', 'completed', 'assistant-1')];
  const restored = ExportedMessageRepository.fromArray(rows.map(toThreadMessage));
  assert.deepEqual(restored.messages.map(({ message }) => [message.id, message.role, message.content[0].text]),
    rows.map((row) => [row.id, row.role, row.content]));
  assert.equal(restored.messages[1].parentId, 'user-1');
  assert.equal(restored.messages[0].message.createdAt.toISOString(), rows[0].createdAt);
});

test('user history never receives assistant-only status for any persisted terminal state', async () => {
  const { ExportedMessageRepository } = await import('@assistant-ui/react');
  for (const status of ['completed', 'failed', 'cancelled']) {
    const message = toThreadMessage(historyMessage('user', status, `user-${status}`));
    assert.equal(Object.hasOwn(message, 'status'), false);
    assert.doesNotThrow(() => ExportedMessageRepository.fromArray([message]));
  }
});

test('assistant completed, failed and cancelled partial text keeps its terminal status', async () => {
  const { ExportedMessageRepository } = await import('@assistant-ui/react');
  for (const [status, expected] of [
    ['completed', { type: 'complete', reason: 'stop' }],
    ['failed', { type: 'incomplete', reason: 'error' }],
    ['cancelled', { type: 'incomplete', reason: 'cancelled' }],
  ]) {
    const row = historyMessage('assistant', status, `assistant-${status}`);
    const { messages } = ExportedMessageRepository.fromArray([toThreadMessage(row)]);
    assert.deepEqual(messages[0].message.status, expected);
    assert.equal(messages[0].message.content[0].text, row.content);
  }
});

test('an empty history remains a valid empty runtime repository', async () => {
  const { ExportedMessageRepository } = await import('@assistant-ui/react');
  assert.deepEqual(ExportedMessageRepository.fromArray([].map(toThreadMessage)).messages, []);
});

test('history tool activity restores an idle snapshot by persisted user message ID', () => {
  const bus = new AgentEventBus();
  bus.restoreHistoryActivity('persisted-user-message-id', [
    {
      toolCallId: 'call-1',
      toolName: 'write',
      path: 'C:/workspace/file.txt',
      status: 'completed',
      durationMs: 42,
    },
  ]);

  assert.deepEqual(bus.getTurnSnapshots()['persisted-user-message-id'], {
    turnId: 'persisted-user-message-id',
    requestId: null,
    phase: 'idle',
    tools: [
      {
        toolCallId: 'call-1',
        toolName: 'write',
        args: { path: 'C:/workspace/file.txt' },
        status: 'completed',
        durationMs: 42,
      },
    ],
    startedAt: 0,
    elapsedMs: null,
  });
});
