const assert = require('node:assert/strict');
const test = require('node:test');
const { join } = require('node:path');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = join(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { replaceInjectedUserText } = require(join(
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

