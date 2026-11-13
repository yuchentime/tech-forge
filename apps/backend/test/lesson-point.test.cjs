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
  MAX_POINT_TURNS,
  countPointTurns,
  countPointTurnsByStudent,
  resolvePointTurn,
  selectNextQuestioner,
} = load('lessons/lesson-point.js');
const { parseDirectorDecision } = load(
  'llm/classroom-simulation.prompt.js',
);

/** One transcript line; speaker is `teacher` or a student id. */
function message(id, speaker, text = '内容') {
  return { id, speaker, text, createdAt: '2026-01-01T00:00:00.000Z' };
}

const emptyState = { startMessageId: null, label: null };

test('a lesson without state starts a point from the teacher message', () => {
  const teacher = message('t1', 'teacher', '老师讲解缓存雪崩');
  const result = resolvePointTurn({
    state: emptyState,
    messages: [teacher],
    teacherMessage: teacher,
    decision: { pointLabel: null, done: false },
  });
  assert.equal(result.started, true);
  assert.equal(result.forceClose, false);
  assert.equal(result.turns, 0);
  assert.equal(result.state.startMessageId, 't1');
  assert.equal(result.state.label, '老师讲解缓存雪崩');
});

test('the director label becomes the status bar', () => {
  const teacher = message('t1', 'teacher', '老师讲解');
  const result = resolvePointTurn({
    state: emptyState,
    messages: [teacher],
    teacherMessage: teacher,
    decision: { pointLabel: '缓存雪崩的触发条件', done: false },
  });
  assert.equal(result.state.label, '缓存雪崩的触发条件');
});

test('the same label continues and counts student turns', () => {
  const state = { startMessageId: 't1', label: '缓存雪崩' };
  const teacher1 = message('t1', 'teacher', '讲解');
  const student1 = message('s1', 'lin', '问题一');
  const teacher2 = message('t2', 'teacher', '回答一');
  const student2 = message('s2', 'su', '问题二');
  const teacher3 = message('t3', 'teacher', '回答二');
  const messages = [teacher1, student1, teacher2, student2, teacher3];

  assert.equal(countPointTurns(messages, 't1'), 2);
  const result = resolvePointTurn({
    state,
    messages,
    teacherMessage: teacher3,
    decision: { pointLabel: '缓存雪崩', done: false },
  });
  assert.equal(result.started, false);
  assert.equal(result.turns, 2);
  assert.equal(result.forceClose, false);
});

test('the director can close the point at any turn', () => {
  const state = { startMessageId: 't1', label: '缓存雪崩' };
  const teacher = message('t2', 'teacher', '回答');
  const result = resolvePointTurn({
    state,
    messages: [message('t1', 'teacher'), message('s1', 'lin'), teacher],
    teacherMessage: teacher,
    decision: { pointLabel: '缓存雪崩', done: true },
  });
  assert.equal(result.forceClose, true);
  assert.equal(result.started, false);
});

test('five student turns are the hard cap', () => {
  const state = { startMessageId: 't1', label: '缓存雪崩' };
  const messages = [message('t1', 'teacher')];
  for (let index = 1; index <= MAX_POINT_TURNS; index += 1) {
    messages.push(message(`s${index}`, index % 2 === 0 ? 'su' : 'lin'));
    if (index < MAX_POINT_TURNS) {
      messages.push(message(`t${index + 1}`, 'teacher'));
    }
  }
  const teacher = message('last-teacher', 'teacher', '继续');
  messages.push(teacher);

  const result = resolvePointTurn({
    state,
    messages,
    teacherMessage: teacher,
    decision: { pointLabel: '缓存雪崩', done: false },
  });
  assert.equal(result.turns, MAX_POINT_TURNS);
  assert.equal(result.forceClose, true);
});

test('a changed label starts a new point and ignores done', () => {
  const state = { startMessageId: 't1', label: '缓存雪崩' };
  const teacher = message('t2', 'teacher', '接下来讲缓存穿透');
  const result = resolvePointTurn({
    state,
    messages: [message('t1', 'teacher'), message('s1', 'lin'), teacher],
    teacherMessage: teacher,
    decision: { pointLabel: '缓存穿透', done: true },
  });
  assert.equal(result.started, true);
  assert.equal(result.forceClose, false);
  assert.equal(result.turns, 0);
  assert.equal(result.state.startMessageId, 't2');
  assert.equal(result.state.label, '缓存穿透');
});

test('a missing start message restarts the point instead of miscounting', () => {
  const teacher = message('t9', 'teacher', '新的讲解');
  const result = resolvePointTurn({
    state: { startMessageId: 'gone', label: '旧点' },
    messages: [teacher],
    teacherMessage: teacher,
    decision: { pointLabel: '旧点', done: false },
  });
  assert.equal(result.started, true);
  assert.equal(result.forceClose, false);
  assert.equal(result.state.startMessageId, 't9');
});

test('the director parser defaults done to false and validates the label', () => {
  assert.deepEqual(parseDirectorDecision('{"student":"lin"}'), {
    student: 'lin',
    pointLabel: null,
    done: false,
    nextStudent: undefined,
    nextFocus: null,
  });
  assert.deepEqual(
    parseDirectorDecision(
      '{"student":"su","pointLabel":" 新点 ","done":true,"nextStudent":"lin","nextFocus":" 重试 "}',
    ),
    {
      student: 'su',
      pointLabel: '新点',
      done: true,
      nextStudent: 'lin',
      nextFocus: '重试',
    },
  );
  assert.throws(
    () => parseDirectorDecision('not json'),
    /unusable answer/,
  );
});

test('per-student counts are derived from the transcript', () => {
  const messages = [
    message('t1', 'teacher'),
    message('s1', 'lin'),
    message('t2', 'teacher'),
    message('s2', 'su'),
    message('s3', 'lin'),
  ];
  assert.deepEqual(countPointTurnsByStudent(messages, 't1'), {
    su: 1,
    lin: 2,
    gu: 0,
  });
});

test('the director nomination picks the next questioner when valid', () => {
  const choice = selectNextQuestioner({
    directorChoice: 'su',
    closer: 'lin',
    counts: { su: 2, lin: 2, gu: 0 },
  });
  assert.equal(choice, 'su');
});

test('an invalid or same-student nomination falls back to the fewest turns', () => {
  const counts = { su: 1, lin: 2, gu: 1 };
  assert.equal(
    selectNextQuestioner({
      directorChoice: 'lin',
      closer: 'lin',
      counts,
      random: () => 0,
    }),
    'su',
  );
  assert.equal(
    selectNextQuestioner({
      directorChoice: 'unknown',
      closer: 'lin',
      counts,
      random: () => 0.99,
    }),
    'gu',
  );
});
