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
const {
  MAX_POINT_STUDENT_TURNS,
  countPointTurns,
  resolvePointTurn,
} = load('lessons/lesson-point.js');
const { parseDirectorDecision } = load(
  'llm/classroom-simulation.prompt.js',
);

/** One transcript line; speaker is `teacher` or a student id. */
function message(id, speaker, text = '内容') {
  return { id, speaker, text, createdAt: '2026-01-01T00:00:00.000Z' };
}

const emptyState = { startMessageId: null, label: null, closed: false };

test('a lesson without state starts a point from the teacher message', () => {
  const teacher = message('t1', 'teacher', '老师讲解缓存雪崩');
  const result = resolvePointTurn({
    state: emptyState,
    messages: [teacher],
    teacherMessage: teacher,
    decision: { mode: 'continue', pointLabel: null },
  });
  assert.equal(result.started, true);
  assert.equal(result.forceClose, false);
  assert.equal(result.turns, 0);
  assert.equal(result.state.startMessageId, 't1');
  assert.equal(result.state.label, '老师讲解缓存雪崩');
});

test('the director can name a new point', () => {
  const teacher = message('t1', 'teacher', '老师讲解');
  const result = resolvePointTurn({
    state: emptyState,
    messages: [teacher],
    teacherMessage: teacher,
    decision: { mode: 'new', pointLabel: '缓存雪崩的触发条件' },
  });
  assert.equal(result.state.label, '缓存雪崩的触发条件');
  assert.equal(result.state.closed, false);
});

test('student turns are derived from the transcript and close at the cap', () => {
  const state = { startMessageId: 't1', label: '缓存雪崩', closed: false };
  const teacher1 = message('t1', 'teacher', '讲解');
  const student1 = message('s1', 'lin', '问题一');
  const teacher2 = message('t2', 'teacher', '回答一');
  const student2 = message('s2', 'su', '问题二');
  const teacher3 = message('t3', 'teacher', '回答二');

  assert.equal(countPointTurns([teacher1, student1], 't1'), 1);
  assert.equal(
    countPointTurns([teacher1, student1, teacher2, student2], 't1'),
    2,
  );

  const atCap = resolvePointTurn({
    state,
    messages: [teacher1, student1, teacher2, student2, teacher3],
    teacherMessage: teacher3,
    decision: { mode: 'continue', pointLabel: null },
  });
  assert.equal(atCap.turns, MAX_POINT_STUDENT_TURNS);
  assert.equal(atCap.forceClose, true);
  assert.equal(atCap.started, false);
});

test('a closed point stays closed until a new point starts', () => {
  const closedState = {
    startMessageId: 't1',
    label: '缓存雪崩',
    closed: true,
  };
  const teacher = message('t2', 'teacher', '继续讲同一个点');
  const continued = resolvePointTurn({
    state: closedState,
    messages: [message('t1', 'teacher'), message('s1', 'lin'), teacher],
    teacherMessage: teacher,
    decision: { mode: 'continue', pointLabel: null },
  });
  assert.equal(continued.forceClose, true);

  const restarted = resolvePointTurn({
    state: closedState,
    messages: [message('t1', 'teacher'), message('s1', 'lin'), teacher],
    teacherMessage: teacher,
    decision: { mode: 'new', pointLabel: '新的知识点' },
  });
  assert.equal(restarted.started, true);
  assert.equal(restarted.forceClose, false);
  assert.equal(restarted.state.startMessageId, 't2');
  assert.equal(restarted.state.label, '新的知识点');
});

test('a missing start message restarts the point instead of miscounting', () => {
  const teacher = message('t9', 'teacher', '新的讲解');
  const result = resolvePointTurn({
    state: { startMessageId: 'gone', label: '旧点', closed: true },
    messages: [teacher],
    teacherMessage: teacher,
    decision: { mode: 'continue', pointLabel: null },
  });
  assert.equal(result.started, true);
  assert.equal(result.forceClose, false);
  assert.equal(result.state.startMessageId, 't9');
});

test('labels are clipped to 40 code points', () => {
  const teacher = message('t1', 'teacher', '讲'.repeat(80));
  const result = resolvePointTurn({
    state: emptyState,
    messages: [teacher],
    teacherMessage: teacher,
    decision: { mode: 'new', pointLabel: '新'.repeat(80) },
  });
  assert.equal(Array.from(result.state.label).length, 41); // 40 + ellipsis
});

test('the director parser tolerates a missing mode and validates new labels', () => {
  assert.deepEqual(parseDirectorDecision('{"student":"lin"}'), {
    student: 'lin',
    mode: 'continue',
    pointLabel: null,
  });
  assert.deepEqual(
    parseDirectorDecision('{"student":"su","mode":"new","pointLabel":" 新点 "}'),
    { student: 'su', mode: 'new', pointLabel: '新点' },
  );
  assert.equal(
    parseDirectorDecision('{"student":"gu","mode":"other"}').mode,
    'continue',
  );
  assert.throws(
    () => parseDirectorDecision('not json'),
    /unusable answer/,
  );
});
