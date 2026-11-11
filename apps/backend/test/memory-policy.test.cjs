const assert = require('node:assert/strict');
const test = require('node:test');
const { join } = require('node:path');

/** Isolated build output, matching the other backend suites. */
const buildDirectory = join(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const {
  hasMemoryIntent,
  isExcludedMemory,
  memoryPolarity,
  normalizeMemoryText,
  selectMemoryCandidates,
  splitMemorySentences,
} = require(join(buildDirectory, 'memory/memory-policy.js'));

test('polarity recognizes Chinese negation and affirmation', () => {
  assert.equal(memoryPolarity('以后不要用英文标题'), 'negative');
  assert.equal(memoryPolarity('别再使用旧模板'), 'negative');
  assert.equal(memoryPolarity('以后都用简体中文'), 'positive');
  assert.equal(memoryPolarity('我喜欢先给结论'), 'positive');
  assert.equal(memoryPolarity('本周在准备公开课'), 'neutral');
});

test('exact duplicate normalization ignores spacing and trailing punctuation', () => {
  assert.equal(
    normalizeMemoryText('  用户偏好：先给结论。 '),
    normalizeMemoryText('用户偏好：先给结论'),
  );
});

test('intent and exclusion rules separate durable preferences from state', () => {
  assert.equal(hasMemoryIntent('记住，我以后都用简体中文'), true);
  assert.equal(hasMemoryIntent('帮我看看这道题'), false);
  assert.equal(isExcludedMemory('学生正确率只有 60%'), true);
  assert.equal(isExcludedMemory('API key 是 abc'), true);
  assert.equal(isExcludedMemory('以后都用简体中文'), false);
});

test('sentence splitting keeps Chinese punctuation boundaries', () => {
  assert.deepEqual(splitMemorySentences('第一句。第二句！第三句？'), [
    '第一句',
    '第二句',
    '第三句',
  ]);
});

test('candidate selection keeps at most two explicit, non-excluded sentences', () => {
  const candidates = selectMemoryCandidates(
    '记住，我以后都用简体中文。每次都先给结论。第三句也说要记住但应当被上限截断。帮我看看这道题。',
  );
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates, ['记住，我以后都用简体中文', '每次都先给结论']);
});

test('candidate selection drops excluded sentences', () => {
  assert.deepEqual(selectMemoryCandidates('记住学生正确率只有 60%'), []);
});
