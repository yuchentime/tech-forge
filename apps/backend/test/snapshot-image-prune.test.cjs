const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const buildDirectory = path.resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { pruneImageWritePayloads } = require(path.join(buildDirectory, 'llm/snapshot-image-prune.js'));

/** Builds one assistant message entry that carries a single tool call. */
function toolCallEntry({ id, parentId = null, name, args }) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `${id}-call`, name, arguments: args }],
    },
  };
}

/** Reads the single tool call back out of a pruned entry. */
function toolCallOf(entry) {
  return entry.message.content[0];
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(500) + '</svg>';

test('replaces an SVG write body with a placeholder that keeps the path', () => {
  const entry = toolCallEntry({
    id: 'entry-1',
    name: 'write',
    args: { path: 'diagrams/state.svg', content: SVG },
  });
  const result = pruneImageWritePayloads([entry], () => true);

  const call = toolCallOf(result.entries[0]);
  assert.equal(call.arguments.path, 'diagrams/state.svg');
  assert.match(call.arguments.content, /^\[content omitted: \d+ B; read diagrams\/state\.svg to view it\]$/);
  assert.equal(result.prunedWrites, 1);
  assert.equal(result.bytesRemoved, Buffer.byteLength(SVG, 'utf8'));
});

test('keeps entry identity so the restored tree is unchanged', () => {
  const entry = toolCallEntry({
    id: 'entry-9',
    parentId: 'entry-8',
    name: 'write',
    args: { path: 'shot.png', content: 'binary-ish' },
  });
  const pruned = pruneImageWritePayloads([entry], () => true).entries[0];

  assert.equal(pruned.id, 'entry-9');
  assert.equal(pruned.parentId, 'entry-8');
  assert.equal(pruned.timestamp, entry.timestamp);
  assert.equal(pruned.message.content.length, entry.message.content.length);
  assert.equal(toolCallOf(pruned).id, 'entry-9-call');
});

test('leaves the body alone when the file is no longer on disk', () => {
  const entry = toolCallEntry({
    id: 'entry-2',
    name: 'write',
    args: { path: 'gone.svg', content: SVG },
  });
  const result = pruneImageWritePayloads([entry], () => false);

  assert.equal(toolCallOf(result.entries[0]).arguments.content, SVG);
  assert.equal(result.prunedWrites, 0);
  assert.equal(result.bytesRemoved, 0);
});

test('leaves non-image writes untouched', () => {
  const entry = toolCallEntry({
    id: 'entry-3',
    name: 'write',
    args: { path: 'notes.md', content: '# 标题' },
  });
  const result = pruneImageWritePayloads([entry], () => true);

  assert.equal(toolCallOf(result.entries[0]).arguments.content, '# 标题');
  assert.equal(result.prunedWrites, 0);
});

test('is idempotent across repeated passes', () => {
  const entry = toolCallEntry({
    id: 'entry-4',
    name: 'write',
    args: { path: 'map.svg', content: SVG },
  });
  const first = pruneImageWritePayloads([entry], () => true);
  const second = pruneImageWritePayloads(first.entries, () => true);

  assert.equal(second.prunedWrites, 0);
  assert.deepEqual(second.entries, first.entries);
});

test('ignores edit calls and non-assistant entries', () => {
  const editEntry = toolCallEntry({
    id: 'entry-5',
    name: 'edit',
    args: { path: 'map.svg', edits: [{ oldText: 'a', newText: 'b' }] },
  });
  const userEntry = {
    type: 'message',
    id: 'entry-6',
    parentId: null,
    timestamp: 2,
    message: { role: 'user', content: 'look at map.svg' },
  };
  const result = pruneImageWritePayloads([editEntry, userEntry], () => true);

  assert.equal(result.prunedWrites, 0);
  assert.deepEqual(result.entries, [editEntry, userEntry]);
});

test('prunes each image write independently and leaves the rest of the snapshot intact', () => {
  const entries = [
    toolCallEntry({ id: 'e1', name: 'write', args: { path: 'a.svg', content: SVG } }),
    toolCallEntry({ id: 'e2', name: 'write', args: { path: 'b.md', content: 'text' } }),
    toolCallEntry({ id: 'e3', name: 'write', args: { path: 'c.png', content: 'png-bytes' } }),
    { type: 'model_change', id: 'e4', parentId: 'e3', timestamp: 3 },
  ];
  const result = pruneImageWritePayloads(entries, (writtenPath) => writtenPath !== 'c.png');

  assert.equal(result.prunedWrites, 1);
  assert.match(toolCallOf(result.entries[0]).arguments.content, /^\[content omitted:/);
  assert.equal(toolCallOf(result.entries[1]).arguments.content, 'text');
  assert.equal(toolCallOf(result.entries[2]).arguments.content, 'png-bytes');
  assert.deepEqual(result.entries[3], entries[3]);
});
