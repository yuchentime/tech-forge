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

test('entries that were never composed are left untouched', () => {
  const entries = [messageEntry('u1', 'user', '干净的问题')];

  assert.equal(replaceInjectedUserText(entries, '干净的问题')[0], entries[0]);
  assert.equal(replaceInjectedUserText([], '干净的问题').length, 0);
  assert.equal(
    replaceInjectedUserText([messageEntry('a1', 'assistant', '回答')], '问题')[0].message.role,
    'assistant',
  );
});
