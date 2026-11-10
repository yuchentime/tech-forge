require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { ConversationsModule } = load('conversations/conversations.module.js');
const { ConversationsService } = load('conversations/conversations.service.js');
const { ConversationEntity } = load('conversations/conversation.entity.js');
const { MessageEntity } = load('conversations/message.entity.js');
const { RehearsalsService } = load('rehearsals/rehearsals.service.js');
const { RehearsalRunRegistry } = load(
  'rehearsals/rehearsal-run-registry.js',
);

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-rehearsal-'));
test.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const PLAN = {
  topic: '金字塔原理',
  learningSummary: '老师已经学习结论先行、MECE 和纵向逻辑。',
  knowledgePoints: [
    { id: 'kp1', label: '结论先行', why: '表达结构的基础' },
    { id: 'kp2', label: 'MECE', why: '分组不重不漏' },
    { id: 'kp3', label: '纵向逻辑', why: '论证链条' },
  ],
  firstQuestion: '请用自己的话解释结论先行。',
};

const REPORT = {
  summary: '总体掌握一般，MECE 仍需练习。',
  knowledgePointMastery: [
    { pointId: 'kp1', status: 'mastered', evidence: '回答完整' },
    { pointId: 'kp2', status: 'partial', evidence: '分组不完整' },
  ],
  strengths: ['能说明结论先行'],
  gaps: ['MECE 的互斥性'],
  suggestions: ['用两个例子重讲 MECE'],
  recommendedReview: ['MECE'],
  disclaimer: '本次演练只反映已作答内容，不等于全面掌握。',
};

/** Fake model: returns a plan, decisions, skip questions and a report by prompt marker. */
function createFakeLlm() {
  const calls = [];
  const decisions = [];
  let questionNumber = 1;
  return {
    calls,
    enqueueDecision(decision) {
      decisions.push(decision);
    },
    async generate(prompt) {
      calls.push(prompt);
      if (prompt.includes('"knowledgePointMastery"')) {
        return JSON.stringify(REPORT);
      }
      if (prompt.includes('被跳过的题目')) {
        return JSON.stringify({
          planUpdates: [],
          nextQuestion: `跳过后的新题 ${(questionNumber += 1)}`,
          reason: '换知识点',
        });
      }
      if (prompt.includes('"firstQuestion"')) {
        return JSON.stringify(PLAN);
      }
      if (prompt.includes('"assessment"')) {
        return JSON.stringify(
          decisions.shift() ?? {
            assessment: {
              level: 'partial',
              issues: ['缺少一个关键步骤'],
              evidence: ['回答提到结论'],
              missingPoints: ['MECE'],
            },
            planUpdates: [],
            action: 'next_question',
            nextQuestion: `新问题 ${(questionNumber += 1)}`,
            reason: '进入下一个知识点',
          },
        );
      }
      throw new Error(`Unexpected model prompt: ${prompt.slice(0, 80)}`);
    },
  };
}

/** Boots the conversation domain and constructs the rehearsal service with a fake model. */
async function createContext() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  const configDirectory = mkdtempSync(join(scratchRoot, 'config-'));
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class RehearsalTestModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      ConversationsModule,
    ],
  })(RehearsalTestModule);

  const app = await NestFactory.createApplicationContext(RehearsalTestModule, {
    logger: false,
  });
  const dataSource = app.get(DataSource);
  const conversations = app.get(ConversationsService);
  const llm = createFakeLlm();
  const service = new RehearsalsService(
    dataSource,
    conversations,
    llm,
    {
      getConfigDirectory: () => configDirectory,
      getSessionDirectory: (conversationId) =>
        join(configDirectory, 'sessions', conversationId),
    },
    new RehearsalRunRegistry(),
  );

  return {
    configDirectory,
    conversations,
    dataSource,
    llm,
    service,
    async close() {
      await app.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** Seeds a conversation with one completed user turn and one completed assistant turn. */
async function seedConversation(ctx) {
  const conversationId = randomUUID();
  await ctx.dataSource.getRepository(ConversationEntity).save({
    id: conversationId,
    title: null,
    metadataJson: null,
  });
  const repository = ctx.dataSource.getRepository(MessageEntity);
  await repository.save([
    repository.create({
      id: randomUUID(),
      conversationId,
      sequenceNo: 1,
      role: 'user',
      contentJson: JSON.stringify([
        { type: 'text', text: '我想学习金字塔原理。' },
      ]),
      status: 'completed',
      requestId: null,
      contextRefsJson: null,
    }),
    repository.create({
      id: randomUUID(),
      conversationId,
      sequenceNo: 2,
      role: 'assistant',
      contentJson: JSON.stringify([
        {
          type: 'text',
          text: '金字塔原理包括结论先行、MECE 和纵向逻辑。',
        },
      ]),
      status: 'completed',
      requestId: null,
      contextRefsJson: null,
    }),
  ]);
  return conversationId;
}

/** Reads the first question turn from a start/detail response. */
function currentTurn(detail) {
  assert.ok(detail.currentQuestion, 'detail must expose a current question');
  return {
    turnId: detail.currentQuestion.turnId,
    question: detail.currentQuestion.text,
  };
}

test('start is idempotent, leaves messages/snapshot alone and exposes a history list', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  const startRequestId = randomUUID();
  try {
    await ctx.dataSource.query(
      'INSERT INTO pi_session_snapshots (conversation_id, entries_json) VALUES (?, ?)',
      [conversationId, JSON.stringify([{ type: 'message', id: 'snapshot-marker' }])],
    );
    const messageCountBefore = (
      await ctx.dataSource.query(
        'SELECT COUNT(*) AS total FROM messages WHERE "conversationId" = ?',
        [conversationId],
      )
    )[0].total;
    const snapshotBefore = (
      await ctx.dataSource.query(
        'SELECT entries_json FROM pi_session_snapshots WHERE conversation_id = ?',
        [conversationId],
      )
    )[0].entries_json;

    const detail = await ctx.service.start(
      conversationId,
      { startRequestId, persona: '初二学生，喜欢追问为什么' },
      { requestId: randomUUID(), conversationId },
    );
    assert.equal(detail.status, 'awaiting_answer');
    assert.equal(detail.topic, PLAN.topic);
    assert.equal(detail.turns.length, 1);
    assert.equal(detail.currentQuestion.text, PLAN.firstQuestion);
    assert.equal(detail.progress.asked, 1);
    assert.equal(detail.progress.remaining, 14);

    const replay = await ctx.service.start(
      conversationId,
      { startRequestId, persona: '初二学生，喜欢追问为什么' },
      { requestId: randomUUID(), conversationId },
    );
    assert.equal(replay.rehearsalId, detail.rehearsalId);
    assert.equal(replay.currentQuestion.turnId, detail.currentQuestion.turnId);

    const messageCountAfter = (
      await ctx.dataSource.query(
        'SELECT COUNT(*) AS total FROM messages WHERE "conversationId" = ?',
        [conversationId],
      )
    )[0].total;
    const snapshotAfter = (
      await ctx.dataSource.query(
        'SELECT entries_json FROM pi_session_snapshots WHERE conversation_id = ?',
        [conversationId],
      )
    )[0].entries_json;
    assert.equal(messageCountAfter, messageCountBefore);
    assert.equal(snapshotAfter, snapshotBefore);

    const list = await ctx.service.list(
      conversationId,
      { limit: 20 },
      { requestId: randomUUID(), conversationId },
    );
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].rehearsalId, detail.rehearsalId);
    assert.equal(list.counts.active, 1);
    assert.equal(list.counts.completed, 0);
    assert.equal(list.nextCursor, null);
  } finally {
    await ctx.close();
  }
});

test('follow-up depth is capped and skip creates a new base question', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    const first = currentTurn(started);
    ctx.llm.enqueueDecision({
      assessment: {
        level: 'partial',
        issues: ['缺少例子'],
        evidence: ['提到了结论'],
        missingPoints: ['具体例子'],
      },
      planUpdates: [],
      action: 'follow_up',
      nextQuestion: '能举一个工作中的例子吗？',
      reason: '回答需要具体化',
    });
    const followOne = await ctx.service.answer(
      started.rehearsalId,
      { turnId: first.turnId, answer: '结论先行就是把结论放前面。', answerRequestId: randomUUID() },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(followOne.question.kind, 'follow_up');
    assert.equal(followOne.question.followUpDepth, 1);
    assert.equal(followOne.progress.asked, 2);

    ctx.llm.enqueueDecision({
      assessment: {
        level: 'partial',
        issues: ['例子不够具体'],
        evidence: ['给了例子'],
        missingPoints: ['场景'],
      },
      planUpdates: [],
      action: 'follow_up',
      nextQuestion: '这个例子里的结论是哪一句？',
      reason: '继续追问',
    });
    const followTwo = await ctx.service.answer(
      started.rehearsalId,
      { turnId: followOne.question.turnId, answer: '比如先汇报结果。', answerRequestId: randomUUID() },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(followTwo.question.kind, 'follow_up');
    assert.equal(followTwo.question.followUpDepth, 2);

    ctx.llm.enqueueDecision({
      assessment: {
        level: 'incorrect',
        issues: ['还没有说清例子'],
        evidence: ['回答简短'],
        missingPoints: ['结论句'],
      },
      planUpdates: [],
      action: 'follow_up',
      nextQuestion: '还想继续追问，但应该换题',
      reason: '超过追问上限',
    });
    const coerced = await ctx.service.answer(
      started.rehearsalId,
      { turnId: followTwo.question.turnId, answer: '结论句就是先说要做什么。', answerRequestId: randomUUID() },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(coerced.question.kind, 'base');
    assert.equal(coerced.question.followUpDepth, 0);
    assert.equal(coerced.progress.asked, 4);

    const skipped = await ctx.service.skip(
      started.rehearsalId,
      { turnId: coerced.question.turnId },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(skipped.question.kind, 'base');
    assert.equal(skipped.assessment, null);
    assert.equal(skipped.progress.asked, 5);
    assert.equal(skipped.progress.skipped, 1);
  } finally {
    await ctx.close();
  }
});

test('the 15th question completes with a report and powers the normal-chat digest', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    let turn = currentTurn(started);
    let result = null;
    for (let index = 0; index < 15; index += 1) {
      result = await ctx.service.answer(
        started.rehearsalId,
        {
          turnId: turn.turnId,
          answer: `第 ${index + 1} 次回答，用具体例子解释。`,
          answerRequestId: randomUUID(),
        },
        { requestId: randomUUID(), rehearsalId: started.rehearsalId },
      );
      if (result.completed) break;
      turn = {
        turnId: result.question.turnId,
        question: result.question.text,
      };
    }

    assert.ok(result, 'answer result');
    assert.equal(result.completed, true);
    assert.ok(result.report);
    assert.equal(result.progress.asked, 15);
    assert.equal(result.progress.remaining, 0);

    const detail = await ctx.service.getById(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.equal(detail.status, 'completed');
    assert.equal(detail.endReason, 'limit');
    assert.equal(detail.turns.length, 15);

    const list = await ctx.service.list(
      conversationId,
      { status: 'completed', limit: 20 },
      { requestId: randomUUID(), conversationId },
    );
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].hasReport, true);
    assert.match(list.items[0].overallSummary, /总体掌握/);

    const digest = await ctx.service.buildConversationDigest(conversationId, {
      requestId: randomUUID(),
      conversationId,
    });
    assert.match(digest.text, /金字塔原理/);
    assert.match(digest.text, /完整记录：/);
    assert.ok(digest.refsJson);
    const refs = JSON.parse(digest.refsJson);
    assert.deepEqual(refs.rehearsals.rehearsalIds, [started.rehearsalId]);
    assert.deepEqual(digest.rehearsalIds, [started.rehearsalId]);

    // Delivery is one-shot: the digest already lives in the Pi history, so it is never rebuilt.
    await ctx.service.markDigestDelivered(digest.rehearsalIds, {
      requestId: randomUUID(),
      conversationId,
    });
    const reloaded = await ctx.dataSource.query(
      'SELECT "loadedContext" AS loaded FROM rehearsals WHERE id = ?',
      [started.rehearsalId],
    );
    assert.equal(Boolean(reloaded[0].loaded), true);
    const repeated = await ctx.service.buildConversationDigest(conversationId, {
      requestId: randomUUID(),
      conversationId,
    });
    assert.equal(repeated.text, '');
    assert.equal(repeated.refsJson, null);
    assert.deepEqual(repeated.rehearsalIds, []);

    const transcriptPath = join(
      ctx.configDirectory,
      'sessions',
      conversationId,
      'rehearsals',
      `${started.rehearsalId}.md`,
    );
    assert.equal(existsSync(transcriptPath), true);
    assert.match(readFileSync(transcriptPath, 'utf8'), /总体评估/);
  } finally {
    await ctx.close();
  }
});

test('manual end marks the open question unanswered and writes a report', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    const first = currentTurn(started);
    const answered = await ctx.service.answer(
      started.rehearsalId,
      {
        turnId: first.turnId,
        answer: '结论先行就是先给结论，再给理由。',
        answerRequestId: randomUUID(),
      },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(answered.completed, false);
    assert.ok(answered.question);

    const ended = await ctx.service.end(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.equal(ended.status, 'completed');
    assert.equal(ended.endReason, 'manual');
    assert.ok(ended.report);
    assert.equal(ended.turns.length, 2);
    assert.equal(ended.turns[1].status, 'unanswered');
    const transcriptPath = join(
      ctx.configDirectory,
      'sessions',
      conversationId,
      'rehearsals',
      `${started.rehearsalId}.md`,
    );
    assert.equal(existsSync(transcriptPath), true);
  } finally {
    await ctx.close();
  }
});

test('skipping the 15th question completes without a replacement', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    let turn = currentTurn(started);
    for (let index = 0; index < 14; index += 1) {
      const result = await ctx.service.answer(
        started.rehearsalId,
        {
          turnId: turn.turnId,
          answer: `回答 ${index + 1}`,
          answerRequestId: randomUUID(),
        },
        { requestId: randomUUID(), rehearsalId: started.rehearsalId },
      );
      assert.equal(result.completed, false);
      assert.ok(result.question);
      turn = { turnId: result.question.turnId, question: result.question.text };
    }

    const skipped = await ctx.service.skip(
      started.rehearsalId,
      { turnId: turn.turnId },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(skipped.completed, true);
    assert.equal(skipped.question, null);
    assert.ok(skipped.report);
    assert.equal(skipped.progress.asked, 15);
    assert.equal(skipped.progress.skipped, 1);

    const detail = await ctx.service.getById(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.equal(detail.turns.length, 15);
    assert.equal(detail.turns.at(-1).status, 'skipped');
    assert.equal(detail.endReason, 'limit');
  } finally {
    await ctx.close();
  }
});

test('replaying an answer request does not create a second turn', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    const first = currentTurn(started);
    const answerRequestId = randomUUID();
    const firstResult = await ctx.service.answer(
      started.rehearsalId,
      {
        turnId: first.turnId,
        answer: '第一次回答',
        answerRequestId,
      },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    const replay = await ctx.service.answer(
      started.rehearsalId,
      {
        turnId: first.turnId,
        answer: '第一次回答',
        answerRequestId,
      },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(replay.turnId, firstResult.turnId);
    assert.deepEqual(replay.assessment, firstResult.assessment);
    assert.equal(replay.question?.turnId, firstResult.question?.turnId);

    const detail = await ctx.service.getById(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.equal(detail.turns.length, 2);
  } finally {
    await ctx.close();
  }
});

test('ending a zero-answer rehearsal is rejected and discard removes it', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    await assert.rejects(
      () =>
        ctx.service.end(started.rehearsalId, {
          requestId: randomUUID(),
          rehearsalId: started.rehearsalId,
        }),
      /还没有回答任何问题/,
    );
    const discarded = await ctx.service.discard(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.deepEqual(discarded, {
      rehearsalId: started.rehearsalId,
      discarded: true,
    });
    await assert.rejects(
      () =>
        ctx.service.getById(started.rehearsalId, {
          requestId: randomUUID(),
          rehearsalId: started.rehearsalId,
        }),
      /演练记录不存在/,
    );
    const counts = await ctx.dataSource.query(
      'SELECT (SELECT COUNT(*) FROM rehearsals WHERE conversationId = ?) AS rehearsals, (SELECT COUNT(*) FROM rehearsal_turns WHERE rehearsalId = ?) AS turns',
      [conversationId, started.rehearsalId],
    );
    assert.equal(Number(counts[0].rehearsals), 0);
    assert.equal(Number(counts[0].turns), 0);
    const latest = await ctx.service.getLatest(conversationId, {
      requestId: randomUUID(),
      conversationId,
    });
    assert.equal(latest, null);
  } finally {
    await ctx.close();
  }
});

test('discard is rejected after a submitted answer', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    const first = currentTurn(started);
    await ctx.service.answer(
      started.rehearsalId,
      {
        turnId: first.turnId,
        answer: '这是已经提交的回答。',
        answerRequestId: randomUUID(),
      },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    await assert.rejects(
      () =>
        ctx.service.discard(started.rehearsalId, {
          requestId: randomUUID(),
          rehearsalId: started.rehearsalId,
        }),
      /已经有回答/,
    );
  } finally {
    await ctx.close();
  }
});

test('a saved answer is restored and can be re-evaluated with a fresh request id', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const started = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    const first = currentTurn(started);
    const oldRequestId = randomUUID();
    const savedAnswer = '重启前保存的回答。';
    await ctx.dataSource.query(
      'UPDATE rehearsal_turns SET answer = ?, answerRequestId = ?, status = ?, answeredAt = ? WHERE id = ?',
      [savedAnswer, oldRequestId, 'answer_saved', new Date().toISOString(), first.turnId],
    );
    await ctx.dataSource.query(
      'UPDATE rehearsals SET status = ?, updatedAt = ? WHERE id = ?',
      ['evaluating', new Date().toISOString(), started.rehearsalId],
    );

    // Simulates a restart: no in-process run exists, so the saved answer is restored immediately.
    const restored = await ctx.service.getById(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.equal(restored.status, 'awaiting_answer');
    assert.equal(restored.turns[0].answer, savedAnswer);
    assert.equal(restored.turns[0].status, 'answer_saved');

    const retried = await ctx.service.answer(
      started.rehearsalId,
      {
        turnId: first.turnId,
        answer: savedAnswer,
        answerRequestId: randomUUID(),
      },
      { requestId: randomUUID(), rehearsalId: started.rehearsalId },
    );
    assert.equal(retried.completed, false);
    const detail = await ctx.service.getById(started.rehearsalId, {
      requestId: randomUUID(),
      rehearsalId: started.rehearsalId,
    });
    assert.equal(detail.turns.length, 2);
    assert.equal(detail.turns[0].status, 'evaluated');
    assert.equal(detail.turns[1].status, 'awaiting_answer');
  } finally {
    await ctx.close();
  }
});

test('context refs merge keeps attachments, knowledge and rehearsals together', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  try {
    const turn = await ctx.conversations.beginTurn(
      conversationId,
      '继续学习',
      false,
      { requestId: randomUUID(), conversationId },
    );
    await ctx.conversations.mergeUserMessageContextRefs(
      turn.userMessageId,
      JSON.stringify({ attachments: [{ attachmentId: 'a', name: 'a.md' }] }),
      { requestId: randomUUID(), conversationId },
    );
    await ctx.conversations.mergeUserMessageContextRefs(
      turn.userMessageId,
      JSON.stringify({ knowledge: { query: 'q', chunks: [] } }),
      { requestId: randomUUID(), conversationId },
    );
    await ctx.conversations.mergeUserMessageContextRefs(
      turn.userMessageId,
      JSON.stringify({ rehearsals: { rehearsalIds: ['r1'] } }),
      { requestId: randomUUID(), conversationId },
    );
    const row = await ctx.dataSource
      .getRepository(MessageEntity)
      .findOneBy({ id: turn.userMessageId });
    assert.ok(row);
    const refs = JSON.parse(row.contextRefsJson);
    assert.ok(refs.attachments);
    assert.ok(refs.knowledge);
    assert.deepEqual(refs.rehearsals.rehearsalIds, ['r1']);
  } finally {
    await ctx.close();
  }
});

test('the student persona persists in one local file shared by every conversation', async () => {
  const ctx = await createContext();
  try {
    assert.deepEqual(await ctx.service.getPersona(), { persona: '' });

    const saved = await ctx.service.savePersona('  初二学生，喜欢追问为什么  ', {
      requestId: randomUUID(),
    });
    assert.equal(saved.persona, '初二学生，喜欢追问为什么');

    const personaPath = join(ctx.configDirectory, 'rehearsal-persona.txt');
    assert.equal(readFileSync(personaPath, 'utf8'), '初二学生，喜欢追问为什么');
    assert.deepEqual(await ctx.service.getPersona(), {
      persona: '初二学生，喜欢追问为什么',
    });

    // Empty text clears the file; the drill then falls back to the default student profile.
    await ctx.service.savePersona('   ', { requestId: randomUUID() });
    assert.equal(readFileSync(personaPath, 'utf8'), '');
    assert.deepEqual(await ctx.service.getPersona(), { persona: '' });

    await assert.rejects(
      () =>
        ctx.service.savePersona('字'.repeat(1001), {
          requestId: randomUUID(),
        }),
      /1000/,
    );
    assert.equal(readFileSync(personaPath, 'utf8'), '');
  } finally {
    await ctx.close();
  }
});

test('a malformed plan is retried with the parse error attached and never stacked', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  const prompts = [];
  try {
    ctx.llm.generate = async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) return '这里不是 JSON';
      if (prompts.length === 2) return JSON.stringify({ topic: '金字塔原理' });
      return JSON.stringify(PLAN);
    };
    const detail = await ctx.service.start(
      conversationId,
      { startRequestId: randomUUID() },
      { requestId: randomUUID(), conversationId },
    );
    assert.equal(detail.currentQuestion.text, PLAN.firstQuestion);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[2].startsWith(prompts[0]));
    assert.equal(prompts[2].split('上一次输出无法解析').length - 1, 1);
  } finally {
    await ctx.close();
  }
});

test('three malformed plan answers end as 422 instead of inventing a plan', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  let calls = 0;
  try {
    ctx.llm.generate = async () => {
      calls += 1;
      return 'not json';
    };
    await assert.rejects(
      () =>
        ctx.service.start(
          conversationId,
          { startRequestId: randomUUID() },
          { requestId: randomUUID(), conversationId },
        ),
      (error) => {
        assert.equal(error.getStatus(), 422);
        assert.match(error.message, /连续 3 次没有返回可解析的内容/);
        assert.match(error.message, /「开始演练」/);
        return true;
      },
    );
    assert.equal(calls, 3);
  } finally {
    await ctx.close();
  }
});

test('a timeout is not retried at the rehearsal level', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  let calls = 0;
  try {
    ctx.llm.generate = async () => {
      calls += 1;
      throw new Error('LLM generation timed out.');
    };
    await assert.rejects(
      () =>
        ctx.service.start(
          conversationId,
          { startRequestId: randomUUID() },
          { requestId: randomUUID(), conversationId },
        ),
      (error) => {
        assert.equal(error.getStatus(), 504);
        assert.match(error.message, /模型服务长时间没有响应/);
        assert.match(error.message, /设置/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await ctx.close();
  }
});

test('a provider failure ends as 502 with a next step and no raw provider text', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  let calls = 0;
  try {
    ctx.llm.generate = async () => {
      calls += 1;
      throw new Error('fetch failed: ECONNRESET upstream-abc');
    };
    await assert.rejects(
      () =>
        ctx.service.start(
          conversationId,
          { startRequestId: randomUUID() },
          { requestId: randomUUID(), conversationId },
        ),
      (error) => {
        assert.equal(error.getStatus(), 502);
        assert.match(error.message, /模型服务暂时不可用/);
        assert.match(error.message, /设置/);
        assert.doesNotMatch(error.message, /ECONNRESET/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await ctx.close();
  }
});

test('a cancelled model call is never retried', async () => {
  const ctx = await createContext();
  const conversationId = await seedConversation(ctx);
  let calls = 0;
  try {
    ctx.llm.generate = async () => {
      calls += 1;
      throw new Error('LLM generation cancelled.');
    };
    await assert.rejects(
      () =>
        ctx.service.start(
          conversationId,
          { startRequestId: randomUUID() },
          { requestId: randomUUID(), conversationId },
        ),
      (error) => {
        assert.equal(error.getStatus(), 409);
        assert.match(error.message, /已经结束或已被取消/);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await ctx.close();
  }
});
