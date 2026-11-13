const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSearchText,
  findSearchMatches,
  locateSearchMatch,
} = require('../dist-electron/src/features/agent/search-text-index.js');

/** Builds an index from text pieces; `null` marks a block boundary. */
function indexOf(...pieces) {
  return buildSearchText(
    pieces.map((piece) => (piece === null ? { separator: true } : { text: piece })),
  );
}

test('a hit may span two inline text nodes', () => {
  const index = indexOf('订单', '服务');
  assert.deepEqual(findSearchMatches(index, '订单服务'), [{ start: 0, end: 4 }]);
});

test('a hit never spans a block boundary', () => {
  const index = indexOf('abc', null, 'def');
  assert.deepEqual(findSearchMatches(index, 'abcdef'), []);
  assert.deepEqual(findSearchMatches(index, 'def'), [{ start: 4, end: 7 }]);
});

test('matching ignores case unless the caller asks for it', () => {
  const index = indexOf('RabbitMQ');
  assert.equal(findSearchMatches(index, 'rabbitmq').length, 1);
  assert.equal(findSearchMatches(index, 'rabbitmq', { caseSensitive: true }).length, 0);
});

test('the query is matched literally, not as a regular expression', () => {
  const index = indexOf('a.b (c)');
  assert.deepEqual(findSearchMatches(index, 'a.b'), [{ start: 0, end: 3 }]);
  assert.deepEqual(findSearchMatches(index, 'axb'), []);
  assert.deepEqual(findSearchMatches(index, '(c)'), [{ start: 4, end: 7 }]);
});

test('an empty or whitespace-only query matches nothing', () => {
  const index = indexOf('订单服务');
  assert.deepEqual(findSearchMatches(index, ''), []);
  assert.deepEqual(findSearchMatches(index, '   '), []);
});

test('a hit ending on a node boundary stays pinned to that node', () => {
  const index = indexOf('abc', 'def');
  const [match] = findSearchMatches(index, 'abc');
  assert.deepEqual(locateSearchMatch(index, match), {
    startPart: 0,
    startOffset: 0,
    endPart: 0,
    endOffset: 3,
  });
});

test('a hit crossing nodes reports both ends in original offsets', () => {
  const index = indexOf('订单', '服务');
  const [match] = findSearchMatches(index, '单服');
  assert.deepEqual(locateSearchMatch(index, match), {
    startPart: 0,
    startOffset: 1,
    endPart: 1,
    endOffset: 1,
  });
});

test('offsets count UTF-16 units, so CJK before an ASCII hit does not shift it', () => {
  const index = indexOf('订单 rabbit');
  const [match] = findSearchMatches(index, 'rabbit');
  assert.deepEqual(locateSearchMatch(index, match), {
    startPart: 0,
    startOffset: 3,
    endPart: 0,
    endOffset: 9,
  });
});
