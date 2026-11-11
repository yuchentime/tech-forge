const assert = require('node:assert/strict');
const test = require('node:test');
const { join } = require('node:path');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = join(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { replaceInjectedUserText, checkSessionEntries } = require(join(
  buildDirectory,
  'llm/session-entries.js',
));

/** Builds one message entry in the shape the session manager returns. */
function messageEntry(id, role, content) {
  return { type: 'message', id, parentId: null, timestamp: 1, message: { role, content, timestamp: 1 } };
}

test('the snapshot keeps only the user text, never the injected context', () => {
  const entries = [
    messageEntry('u1', 'user', '上一轮的问题'),
    messageEntry('a1', 'assistant', [{ type: 'text', text: '上一轮的回答' }]),
    messageEntry('u2', 'user', '## 本轮用户附加的文件\n\n正文……\n\n## 用户输入\n这一次的问题'),
  ];

  const cleaned = replaceInjectedUserText(entries, '这一次的问题');

  assert.equal(cleaned[2].message.content, '这一次的问题');
  // Ids and links must survive so the restored entry tree is unchanged.
  assert.deepEqual(
    cleaned.map((entry) => [entry.id, entry.parentId]),
    entries.map((entry) => [entry.id, entry.parentId]),
  );
  assert.equal(cleaned[0].message.content, '上一轮的问题');
});

test('text-block content and historical user rows are cleaned too', () => {
  const entries = [
    messageEntry('u1', 'user', [
      { type: 'text', text: '## 此前的演练记录\n\n## 用户输入\n旧问题' },
    ]),
    messageEntry('a1', 'assistant', [{ type: 'text', text: '回答' }]),
    messageEntry('u2', 'user', [
      { type: 'text', text: '## 此前的演练记录\n\n## 用户输入\n新问题' },
    ]),
  ];

  const cleaned = replaceInjectedUserText(
    entries,
    '新问题',
    new Map([['u1', '旧问题']]),
  );

  assert.deepEqual(cleaned[0].message.content, [{ type: 'text', text: '旧问题' }]);
  assert.deepEqual(cleaned[2].message.content, [{ type: 'text', text: '新问题' }]);
  assert.deepEqual(
    cleaned.map((entry) => [entry.id, entry.parentId]),
    entries.map((entry) => [entry.id, entry.parentId]),
  );
});

test('historical injected blocks are stripped even when Pi reused ids', () => {
  const entries = [
    messageEntry('pi-1', 'user', [
      {
        type: 'text',
        text: '## 此前的演练记录\n背景\n\n## 用户输入\n旧问题',
      },
    ]),
    messageEntry('a1', 'assistant', [{ type: 'text', text: '回答' }]),
    messageEntry('pi-2', 'user', [
      {
        type: 'text',
        text: '## 此前的演练记录\n背景\n\n## 用户输入\n新问题',
      },
    ]),
  ];

  const cleaned = replaceInjectedUserText(entries, '新问题');

  assert.deepEqual(cleaned[0].message.content, [{ type: 'text', text: '旧问题' }]);
  assert.deepEqual(cleaned[2].message.content, [{ type: 'text', text: '新问题' }]);
});

test('entries that were never composed are left untouched', () => {
  const entries = [messageEntry('u1', 'user', '干净的问题')];

  assert.equal(replaceInjectedUserText(entries, '干净的问题')[0], entries[0]);
  assert.equal(replaceInjectedUserText([], '干净的问题').length, 0);
  assert.equal(
    replaceInjectedUserText([messageEntry('a1', 'assistant', '回答')], '问题')[0].message.role,
    'assistant',
  );
});

test('durable custom message entries survive the snapshot cleanup', () => {
  const custom = {
    type: 'custom_message',
    id: 'c1',
    parentId: null,
    timestamp: 1,
    customType: 'rehearsal_digest',
    content: '## 此前的演练记录\n\n## 用户输入\n这不是分隔符',
    display: false,
  };
  const entries = [
    custom,
    messageEntry('u1', 'user', '## 本轮用户附加的文件\n\n正文\n\n## 用户输入\n问题'),
  ];

  const cleaned = replaceInjectedUserText(entries, '问题');

  // The digest is delivered once through a custom entry; stripping it would lose it forever.
  assert.equal(cleaned[0], custom);
  assert.equal(cleaned[1].message.content, '问题');
});



test('memory blocks are stripped from historical user entries', () => {
  const entries = [
    messageEntry('u1', 'user', '## 长期记忆\n- [2026-11-11] 用户喜欢先给结论。\n\n## 用户输入\n旧问题'),
    messageEntry('a1', 'assistant', [{ type: 'text', text: '回答' }]),
    messageEntry('u2', 'user', '当前问题'),
  ];

  const cleaned = replaceInjectedUserText(entries, '当前问题');
  assert.equal(cleaned[0].message.content, '旧问题');
  assert.equal(cleaned[1].message.content[0].text, '回答');
  assert.equal(cleaned[2].message.content, '当前问题');
});

test('the current turn keeps only the clean user prompt even with a memory block', () => {
  const entries = [messageEntry('u1', 'user', '## 长期记忆\n- 用户喜欢类比。\n\n## 用户输入\n当前问题')];
  const cleaned = replaceInjectedUserText(entries, '当前问题');
  assert.equal(cleaned[0].message.content, '当前问题');
});

test('inline images are dropped from the snapshot while the user text survives', () => {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const entries = [
    messageEntry('u1', 'user', [
      { type: 'text', text: '## 本轮用户附加的文件\n\n正文\n\n## 用户输入\n当前问题' },
      image,
    ]),
  ];

  const cleaned = replaceInjectedUserText(entries, '当前问题');

  // The image is this turn's vision input; replaying it every turn would bill it again.
  assert.deepEqual(cleaned[0].message.content, [{ type: 'text', text: '当前问题' }]);
});

test('historical image input is dropped while the stored user text stays', () => {
  const image = { type: 'image', data: 'BBBB', mimeType: 'image/png' };
  const entries = [
    messageEntry('u1', 'user', [{ type: 'text', text: '旧问题' }, image]),
    messageEntry('a1', 'assistant', [{ type: 'text', text: '回答' }]),
    messageEntry('u2', 'user', '新问题'),
  ];

  const cleaned = replaceInjectedUserText(entries, '新问题');

  assert.deepEqual(cleaned[0].message.content, [{ type: 'text', text: '旧问题' }]);
});

/** Links entries the way the session manager stores them: one parent chain, oldest first. */
function chained(entries) {
  let parentId = null;
  return entries.map((entry) => {
    const linked = { ...entry, parentId };
    parentId = entry.id;
    return linked;
  });
}

/** Builds one assistant message entry carrying the given tool calls. */
function assistantEntry(id, blocks) {
  return messageEntry(id, 'assistant', blocks);
}

test('an orphan tool result is dropped and the chain stays connected', () => {
  // Reproduces a snapshot whose assistant message lost the tool call its result answers.
  const entries = chained([
    messageEntry('u1', 'user', '旧问题'),
    assistantEntry('a1', [{ type: 'text', text: '先写文件' }]),
    {
      ...messageEntry('t1', 'toolResult', [{ type: 'text', text: '未执行' }]),
      message: {
        role: 'toolResult',
        toolCallId: 'call_missing',
        toolName: 'write',
        content: [{ type: 'text', text: 'Tool call was not executed.' }],
        isError: true,
        timestamp: 1,
      },
    },
    messageEntry('u2', 'user', '继续'),
  ]);

  const check = checkSessionEntries(entries);

  assert.equal(check.removedToolResults, 1);
  assert.equal(check.strippedToolCalls, 0);
  assert.equal(check.relinkedEntries, 1);
  assert.deepEqual(check.entries.map((entry) => entry.id), ['u1', 'a1', 'u2']);
  // u2 pointed at the dropped tool result; the restored chain must not fork there.
  assert.equal(check.entries[2].parentId, 'a1');
});

test('a tool call without a result is stripped from the assistant message', () => {
  const entries = chained([
    messageEntry('u1', 'user', '整理知识地图'),
    assistantEntry('a1', [
      { type: 'text', text: '写入文件' },
      { type: 'toolCall', id: 'call_1', name: 'write', arguments: {} },
    ]),
  ]);

  const check = checkSessionEntries(entries);

  assert.equal(check.strippedToolCalls, 1);
  // The generated text survives; only the call a provider cannot accept is removed.
  assert.deepEqual(check.entries[1].message.content, [
    { type: 'text', text: '写入文件' },
  ]);
  // Nothing was removed, so the stored chain is unchanged.
  assert.equal(check.relinkedEntries, 0);
  assert.deepEqual(
    check.entries.map((entry) => [entry.id, entry.parentId]),
    entries.map((entry) => [entry.id, entry.parentId]),
  );
});

test('an answered call keeps its result while an unanswered one is stripped', () => {
  const entries = chained([
    messageEntry('u1', 'user', '整理知识地图'),
    assistantEntry('a1', [
      { type: 'toolCall', id: 'call_1', name: 'write', arguments: {} },
      { type: 'toolCall', id: 'call_2', name: 'read', arguments: {} },
    ]),
    {
      ...messageEntry('t1', 'toolResult', [{ type: 'text', text: 'ok' }]),
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'write',
        content: [{ type: 'text', text: 'Successfully wrote to 知识地图.svg' }],
        isError: false,
        timestamp: 1,
      },
    },
  ]);

  const check = checkSessionEntries(entries);

  assert.equal(check.removedToolResults, 0);
  assert.equal(check.strippedToolCalls, 1);
  assert.deepEqual(check.entries[1].message.content, [
    { type: 'toolCall', id: 'call_1', name: 'write', arguments: {} },
  ]);
  assert.equal(check.entries[2].message.toolCallId, 'call_1');
});

test('a matched tool call and result are left untouched', () => {
  const entries = chained([
    messageEntry('u1', 'user', '整理知识地图'),
    assistantEntry('a1', [{ type: 'toolCall', id: 'call_1', name: 'write', arguments: {} }]),
    {
      ...messageEntry('t1', 'toolResult', [{ type: 'text', text: 'ok' }]),
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'write',
        content: [{ type: 'text', text: 'Successfully wrote to 知识地图.svg' }],
        isError: false,
        timestamp: 1,
      },
    },
    messageEntry('a2', [{ type: 'text', text: '写好了' }]),
  ]);

  const check = checkSessionEntries(entries);

  assert.equal(check.removedToolResults, 0);
  assert.equal(check.strippedToolCalls, 0);
  assert.equal(check.relinkedEntries, 0);
  assert.deepEqual(check.entries, entries);
});
