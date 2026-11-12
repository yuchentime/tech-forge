const assert = require('node:assert/strict');
const test = require('node:test');
const { RehearsalStore } = require('../dist-electron/src/features/rehearsal/rehearsal-store.js');
const {
  hasCompletedConversationRound,
} = require('../dist-electron/src/features/rehearsal/rehearsal-availability.js');
const {
  estimatePreparingPercent,
  PREPARING_TIME_CAP,
} = require('../dist-electron/src/features/rehearsal/rehearsal-preparing-progress.js');
const PLAN = {
  topic: '金字塔原理',
  learningSummary: '老师学习了结论先行和 MECE。',
  knowledgePoints: [
    { id: 'kp1', label: '结论先行', why: '表达结构' },
    { id: 'kp2', label: 'MECE', why: '分组' },
    { id: 'kp3', label: '纵向逻辑', why: '论证' },
  ],
  generatedAt: '2026-11-09T12:00:00.000Z',
};

const REPORT = {
  summary: '掌握一般。',
  knowledgePointMastery: [
    { pointId: 'kp1', status: 'mastered', evidence: '回答完整' },
  ],
  strengths: ['能说清结论先行'],
  gaps: ['MECE 不完整'],
  suggestions: ['再练一次 MECE'],
  recommendedReview: ['MECE'],
  disclaimer: '只反映已作答内容。',
};

/** Builds one question view. */
function question(turnId, text, depth = 0, kind = 'base') {
  return {
    turnId,
    sequenceNo: depth + 1,
    baseSequenceNo: 1,
    followUpDepth: depth,
    kind,
    text,
  };
}

/** Builds one turn view. */
function turn(turnId, text, status, answer = null, assessment = null) {
  return {
    turnId,
    sequenceNo: 1,
    baseSequenceNo: 1,
    followUpDepth: 0,
    kind: 'base',
    pointId: null,
    question: text,
    answer,
    assessment,
    status,
    askedAt: '2026-11-09T12:00:00.000Z',
    answeredAt: null,
    evaluatedAt: null,
  };
}

/** Builds one detail fixture. */
function detail(patch = {}) {
  return {
    rehearsalId: 'r1',
    conversationId: 'c1',
    status: 'awaiting_answer',
    topic: PLAN.topic,
    persona: '学生画像',
    plan: PLAN,
    progress: {
      asked: 1,
      limit: 15,
      remaining: 14,
      baseQuestions: 1,
      skipped: 0,
      currentFollowUpDepth: 0,
    },
    currentQuestion: question('t1', '请解释结论先行。'),
    turns: [turn('t1', '请解释结论先行。', 'awaiting_answer')],
    report: null,
    endReason: null,
    startedAt: '2026-11-09T12:00:00.000Z',
    endedAt: null,
    createdAt: '2026-11-09T12:00:00.000Z',
    ...patch,
  };
}

const updatedDetail = detail({
  progress: {
    asked: 2,
    limit: 15,
    remaining: 13,
    baseQuestions: 1,
    skipped: 0,
    currentFollowUpDepth: 1,
  },
  currentQuestion: question('t2', '能举个具体例子吗？', 1, 'follow_up'),
  turns: [
    turn('t1', '请解释结论先行。', 'evaluated', '先给结论再给理由。', {
      level: 'partial',
      issues: ['缺少例子'],
      evidence: ['提到了结论'],
      missingPoints: ['例子'],
    }),
    turn('t2', '能举个具体例子吗？', 'awaiting_answer'),
  ],
});

const completedDetail = detail({
  status: 'completed',
  currentQuestion: null,
  progress: {
    asked: 2,
    limit: 15,
    remaining: 13,
    baseQuestions: 1,
    skipped: 0,
    currentFollowUpDepth: 0,
  },
  turns: [
    turn('t1', '请解释结论先行。', 'evaluated', '先给结论再给理由。', {
      level: 'partial',
      issues: ['缺少例子'],
      evidence: ['提到了结论'],
      missingPoints: ['例子'],
    }),
    turn('t2', '能举个具体例子吗？', 'unanswered'),
  ],
  report: REPORT,
  endReason: 'manual',
  endedAt: '2026-11-09T12:03:00.000Z',
});

const restoredDetail = detail({
  currentQuestion: question('t1', '请解释结论先行。'),
  turns: [
    turn('t1', '请解释结论先行。', 'answer_saved', '重启前保存的回答。'),
  ],
});

const historySummary = {
  rehearsalId: 'r2',
  status: 'completed',
  topic: '金字塔原理',
  persona: '学生画像',
  createdAt: '2026-11-08T12:00:00.000Z',
  startedAt: '2026-11-08T12:00:00.000Z',
  endedAt: '2026-11-08T12:03:00.000Z',
  endReason: 'manual',
  progress: {
    asked: 2,
    limit: 15,
    remaining: 13,
    baseQuestions: 1,
    skipped: 0,
    currentFollowUpDepth: 0,
  },
  overallSummary: '历史报告摘要。',
  hasReport: true,
};

/** Installs a fake desktop bridge that serves the fixture API. */
function installBridge() {
  const requests = [];
  global.window = {
    teachforge: {
      getBackendState: async () => ({ ready: true, port: 1 }),
      request: async (input) => {
        requests.push(input);
        const { method, path } = input;
        if (method === 'GET' && path === '/api/rehearsal-persona') {
          return {
            status: 200,
            data: { persona: '初二学生，喜欢追问为什么' },
          };
        }
        if (method === 'PUT' && path === '/api/rehearsal-persona') {
          return {
            status: 200,
            data: { persona: String(input.body?.persona ?? '').trim() },
          };
        }
        if (method === 'GET' && path === '/api/conversations/c1/rehearsals/latest') {
          return { status: 200, data: detail() };
        }
        if (method === 'GET' && path === '/api/conversations/c1/rehearsals/preparing') {
          return { status: 200, data: null };
        }
        if (method === 'GET' && path === '/api/conversations/c2/rehearsals/latest') {
          return { status: 200, data: null };
        }
        if (method === 'POST' && path === '/api/conversations/c1/rehearsals') {
          return { status: 201, data: detail({ rehearsalId: 'r3' }) };
        }
        if (method === 'POST' && path === '/api/rehearsals/r1/answers') {
          return {
            status: 200,
            data: {
              turnId: 't1',
              assessment: {
                level: 'partial',
                issues: ['缺少例子'],
                evidence: ['提到了结论'],
                missingPoints: ['例子'],
              },
              action: 'follow_up',
              question: question('t2', '能举个具体例子吗？', 1, 'follow_up'),
              completed: false,
              report: null,
              progress: updatedDetail.progress,
            },
          };
        }
        if (method === 'GET' && path === '/api/rehearsals/r1') {
          return { status: 200, data: updatedDetail };
        }
        if (method === 'POST' && path === '/api/rehearsals/r1/end') {
          return { status: 200, data: completedDetail };
        }
        if (method === 'GET' && path.startsWith('/api/conversations/c1/rehearsals?')) {
          return {
            status: 200,
            data: {
              items: [historySummary],
              counts: { completed: 1, active: 0, failed: 0 },
              nextCursor: null,
            },
          };
        }
        if (method === 'DELETE' && path === '/api/rehearsals/r1') {
          return {
            status: 200,
            data: { rehearsalId: 'r1', discarded: true },
          };
        }
        if (method === 'GET' && path === '/api/rehearsals/r2') {
          return {
            status: 200,
            data: {
              ...completedDetail,
              rehearsalId: 'r2',
              createdAt: '2026-11-08T12:00:00.000Z',
              endedAt: '2026-11-08T12:03:00.000Z',
            },
          };
        }
        return { status: 404, data: { message: 'not found' } };
      },
      pickImportFiles: async () => [],
      // The bridge guard in `hasDesktopBridge()` requires these; a fixture missing one makes every
      // store request fail as if it ran in a browser preview.
      pickChatAttachments: async () => [],
      ensureContentWidth: async (width) => ({
        contentWidth: width,
        maxContentWidth: width,
      }),
      releaseContentWidth: async () => undefined,
      streamChat: () => '',
      cancelChatStream: () => undefined,
      revealInFolder: async () => true,
    },
  };
  return requests;
}

test('a drill requires a user message followed by a completed assistant answer', () => {
  assert.equal(hasCompletedConversationRound([]), false);
  assert.equal(
    hasCompletedConversationRound([{ role: 'user' }]),
    false,
  );
  assert.equal(
    hasCompletedConversationRound([
      { role: 'user' },
      { role: 'assistant', status: { type: 'running' } },
    ]),
    false,
  );
  assert.equal(
    hasCompletedConversationRound([
      { role: 'user' },
      { role: 'assistant', status: { type: 'incomplete' } },
    ]),
    false,
  );
  assert.equal(
    hasCompletedConversationRound([
      { role: 'assistant', status: { type: 'complete' } },
      { role: 'user' },
      { role: 'assistant', status: { type: 'complete' } },
    ]),
    true,
  );
});

test('the store restores an active drill and keeps it while browsing history', async () => {
  const requests = installBridge();
  const store = new RehearsalStore();

  await store.loadForConversation('c1');
  let state = store.getSnapshot();
  assert.equal(state.status, 'ready');
  assert.equal(state.view, 'session');
  assert.equal(state.detail.currentQuestion.turnId, 't1');
  assert.equal(state.persona, '初二学生，喜欢追问为什么');
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.path).sort(),
    ['/api/conversations/c1/rehearsals/latest', '/api/rehearsal-persona'],
  );

  await store.openHistory();
  state = store.getSnapshot();
  assert.equal(state.view, 'history');
  assert.equal(state.history.items.length, 1);
  assert.equal(state.history.counts.completed, 1);
  assert.equal(state.detail.currentQuestion.turnId, 't1');

  await store.openHistoryDetail('r2');
  state = store.getSnapshot();
  assert.equal(state.view, 'historyDetail');
  assert.equal(state.historyDetail.rehearsalId, 'r2');
  assert.equal(state.detail.currentQuestion.turnId, 't1');

  store.backToHistory();
  assert.equal(store.getSnapshot().view, 'history');
  store.backToSession();
  assert.equal(store.getSnapshot().view, 'session');
});

test('the store advances answers, ends to a report and starts a new batch', async () => {
  installBridge();
  const store = new RehearsalStore();
  await store.loadForConversation('c1');

  await store.answer('先给结论，再给理由。');
  let state = store.getSnapshot();
  assert.equal(state.view, 'session');
  assert.equal(state.isSubmitting, false);
  assert.equal(state.detail.currentQuestion.turnId, 't2');
  assert.equal(state.detail.turns.length, 2);

  await store.end();
  state = store.getSnapshot();
  assert.equal(state.view, 'report');
  assert.equal(state.isEnding, false);
  assert.equal(state.detail.status, 'completed');
  assert.equal(state.completionVersion, 1);
  assert.ok(state.detail.report);

  await store.start('新画像');
  state = store.getSnapshot();
  assert.equal(state.view, 'session');
  assert.equal(state.isStarting, false);
  assert.equal(state.detail.rehearsalId, 'r3');
});

test('an answer failure keeps the same request id for a retry', async () => {
  installBridge();
  const baseRequest = global.window.teachforge.request;
  let attempts = 0;
  global.window.teachforge.request = async (input) => {
    if (input.method === 'POST' && input.path === '/api/rehearsals/r1/answers') {
      attempts += 1;
      if (attempts === 1) {
        return { status: 504, data: { message: '演练生成超时，请重试。' } };
      }
      return baseRequest(input);
    }
    return baseRequest(input);
  };
  const store = new RehearsalStore();
  await store.loadForConversation('c1');

  await store.answer('第一次回答');
  let state = store.getSnapshot();
  assert.equal(state.isSubmitting, false);
  assert.match(state.answerError, /超时/);
  assert.ok(state.pendingAnswer);
  const requestId = state.pendingAnswer.requestId;

  await store.retryAnswer();
  state = store.getSnapshot();
  assert.equal(state.answerError, null);
  assert.equal(state.pendingAnswer, null);
  assert.equal(state.detail.currentQuestion.turnId, 't2');
  assert.equal(attempts, 2);
  assert.equal(requestId.length > 0, true);
});

test('a saved answer is restored as a pending evaluation and retried', async () => {
  installBridge();
  const baseRequest = global.window.teachforge.request;
  let latestCalls = 0;
  global.window.teachforge.request = async (input) => {
    if (
      input.method === 'GET' &&
      input.path === '/api/conversations/c1/rehearsals/latest'
    ) {
      latestCalls += 1;
      return { status: 200, data: restoredDetail };
    }
    return baseRequest(input);
  };
  const store = new RehearsalStore();
  await store.loadForConversation('c1');
  let state = store.getSnapshot();
  assert.equal(state.view, 'session');
  assert.equal(state.pendingAnswer.answer, '重启前保存的回答。');
  assert.equal(state.pendingAnswer.turnId, 't1');

  await store.retryAnswer();
  state = store.getSnapshot();
  assert.equal(state.pendingAnswer, null);
  assert.equal(state.detail.currentQuestion.turnId, 't2');
  assert.equal(latestCalls, 1);
});

test('discarding a zero-answer rehearsal returns to the start view', async () => {
  installBridge();
  const store = new RehearsalStore();
  await store.loadForConversation('c1');
  await store.discard();
  const state = store.getSnapshot();
  assert.equal(state.detail, null);
  assert.equal(state.view, 'start');
  assert.equal(state.isEnding, false);
});

test('the student persona is read on entry and saved when the editor blurs', async () => {
  const requests = installBridge();
  const store = new RehearsalStore();

  await store.loadForConversation('c1');
  assert.equal(store.getSnapshot().persona, '初二学生，喜欢追问为什么');
  assert.equal(store.getSnapshot().personaError, null);

  await store.savePersona('  高一学生，爱较真，要求举例  ');
  const saved = requests.at(-1);
  assert.equal(saved.method, 'PUT');
  assert.equal(saved.path, '/api/rehearsal-persona');
  assert.deepEqual(saved.body, { persona: '  高一学生，爱较真，要求举例  ' });
  assert.equal(store.getSnapshot().persona, '高一学生，爱较真，要求举例');
  assert.equal(store.getSnapshot().personaError, null);
});

test('a failed persona save keeps the typed text and reports the error', async () => {
  installBridge();
  const store = new RehearsalStore();
  await store.loadForConversation('c1');

  global.window.teachforge.request = async () => ({
    status: 500,
    data: { message: '无法保存本机学生画像文件' },
  });

  await store.savePersona('新画像');
  assert.equal(store.getSnapshot().persona, '新画像');
  assert.match(store.getSnapshot().personaError, /无法保存本机学生画像文件/);
});

test('a failed report lands on the report view so the retry action stays visible', async () => {
  installBridge();
  const baseRequest = global.window.teachforge.request;
  global.window.teachforge.request = async (input) => {
    if (input.method === 'POST' && input.path === '/api/rehearsals/r1/end') {
      return {
        status: 504,
        data: {
          message:
            '模型服务连续 3 次超时，总体报告没有生成。逐题记录已保留，点「重试结束」可以重新生成报告。如果一直失败，请到设置里确认模型服务和网络是否可用。',
        },
      };
    }
    if (input.method === 'GET' && input.path === '/api/rehearsals/r1') {
      return {
        status: 200,
        data: { ...updatedDetail, status: 'failed', endReason: 'failed' },
      };
    }
    return baseRequest(input);
  };

  const store = new RehearsalStore();
  await store.loadForConversation('c1');
  await store.end();

  const state = store.getSnapshot();
  assert.equal(state.view, 'report');
  assert.equal(state.isEnding, false);
  assert.equal(state.detail.status, 'failed');
  assert.match(state.error, /重试结束/);
  assert.match(state.error, /设置/);
});

/** Waits until a store condition holds, so tests never depend on a fixed sleep. */
async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not observed');
}

test('the preparing estimate rises smoothly and caps before completion', () => {
  assert.equal(estimatePreparingPercent(0), 0);
  assert.equal(estimatePreparingPercent(Number.NaN), 0);
  let previous = 0;
  for (let seconds = 0; seconds <= 180; seconds += 1) {
    const value = estimatePreparingPercent(seconds * 1000);
    assert.ok(value >= previous, `progress regressed at ${seconds}s`);
    assert.ok(value <= PREPARING_TIME_CAP + 1e-9);
    previous = value;
  }
  assert.ok(estimatePreparingPercent(5_000) < 45);
  assert.ok(estimatePreparingPercent(20_000) > 80);
  assert.ok(estimatePreparingPercent(60_000) > 88);
});

test('the preparing screen state follows the polled backend phase', async () => {
  installBridge();
  const baseRequest = global.window.teachforge.request;
  const startGate = Promise.withResolvers();
  global.window.teachforge.request = async (input) => {
    if (
      input.method === 'GET' &&
      input.path === '/api/conversations/c1/rehearsals/preparing'
    ) {
      return {
        status: 200,
        data: { rehearsalId: 'r3', phase: 'plan' },
      };
    }
    if (
      input.method === 'POST' &&
      input.path === '/api/conversations/c1/rehearsals'
    ) {
      await startGate.promise;
      return { status: 201, data: detail({ rehearsalId: 'r3' }) };
    }
    return baseRequest(input);
  };

  const store = new RehearsalStore();
  await store.loadForConversation('c1');
  const startPromise = store.start('');

  await waitUntil(() => store.getSnapshot().preparing?.phase === 'plan');
  assert.equal(store.getSnapshot().isStarting, true);

  startGate.resolve();
  await waitUntil(() => store.getSnapshot().preparingComplete);
  assert.equal(store.getSnapshot().isStarting, true);
  await startPromise;
  const state = store.getSnapshot();
  assert.equal(state.preparing, null);
  assert.equal(state.preparingComplete, false);
  assert.equal(state.view, 'session');
  assert.equal(state.detail.rehearsalId, 'r3');
});

test('a start that settles after a switch does not write the new conversation', async () => {
  installBridge();
  const baseRequest = global.window.teachforge.request;
  const startGate = Promise.withResolvers();
  global.window.teachforge.request = async (input) => {
    if (
      input.method === 'POST' &&
      input.path === '/api/conversations/c1/rehearsals'
    ) {
      await startGate.promise;
      return { status: 201, data: detail({ rehearsalId: 'r3' }) };
    }
    return baseRequest(input);
  };

  const store = new RehearsalStore();
  await store.loadForConversation('c1');
  const startPromise = store.start('');
  await waitUntil(() => store.getSnapshot().isStarting);
  await store.loadForConversation('c2');

  startGate.resolve();
  await startPromise;

  const state = store.getSnapshot();
  assert.equal(state.conversationId, 'c2');
  assert.equal(state.detail, null);
  assert.equal(state.isStarting, false);
  assert.equal(state.error, null);
});
