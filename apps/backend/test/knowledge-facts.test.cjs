require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { DataSource } = require('typeorm');

const {
  PLAN,
  buildDirectory,
  createControlledLlm,
  createFactsContext,
  makeFactResponse,
  makeReport,
  markPending,
  readFactRow,
  seedCompletedRehearsal,
  seedConversation,
  seedMessage,
} = require('./helpers/knowledge-facts-fixtures.cjs');

const load = (modulePath) => require(join(buildDirectory, modulePath));
const {
  buildBudgetedKnowledgeFactsPrompt,
  getAvailableFactPromptTokens,
} = load('rehearsals/conversation-knowledge-facts.budget.js');
const {
  KNOWLEDGE_FACTS_SYSTEM_PROMPT,
} = load('rehearsals/conversation-knowledge-facts.prompts.js');
const {
  KnowledgeFactValidationError,
  parseKnowledgeFactResponse,
} = load('rehearsals/conversation-knowledge-facts.validation.js');
const { buildDatabaseOptions } = load('database/database.options.js');
const { ConversationsService } = load('conversations/conversations.service.js');
const { ConversationKnowledgeFactEntity } = load(
  'rehearsals/conversation-knowledge-fact.entity.js',
);
const { RehearsalsService } = load('rehearsals/rehearsals.service.js');
const { RehearsalRunRegistry } = load('rehearsals/rehearsal-run-registry.js');
const { RehearsalPreparingRegistry } = load(
  'rehearsals/rehearsal-preparing-registry.js',
);
const { RehearsalEntity } = load('rehearsals/rehearsal.entity.js');
const { RehearsalTurnEntity } = load('rehearsals/rehearsal-turn.entity.js');

/** Builds one evaluation fixture with a controllable size. */
function evaluation({
  rehearsalId = randomUUID(),
  endedAt = '2026-11-10T08:00:00.000Z',
  pointId = 'kp1',
  padding = '评估依据',
} = {}) {
  return {
    rehearsalId,
    endedAt,
    topic: '牛顿力学',
    knowledgePoints: [
      {
        pointId,
        name: '牛顿第二定律',
        status: 'partial',
        evidence: `${padding}-${rehearsalId}`,
      },
    ],
    report: {
      summary: `报告 ${rehearsalId}`,
      strengths: [padding],
      gaps: [padding],
      suggestions: [padding],
      recommendedReview: [padding],
      disclaimer: '只反映已作答内容。',
    },
  };
}

/** A validation context with two stored evaluations. */
function validationContext() {
  const first = evaluation({ endedAt: '2026-11-08T08:00:00.000Z' });
  const second = evaluation({ endedAt: '2026-11-10T08:00:00.000Z' });
  return {
    allEvaluations: [first, second],
    promptEvaluations: [first, second],
    existingFact: null,
    first,
    second,
  };
}

test('strict fact validation accepts the contract and normalizes tags', () => {
  const context = validationContext();
  const parsed = parseKnowledgeFactResponse(
    makeFactResponse({
      rehearsalId: context.second.rehearsalId,
      endedAt: context.second.endedAt,
      tags: ['力学', '力学', '牛顿第二定律'],
    }),
    context,
  );
  assert.equal(parsed.summary.length > 0, true);
  assert.deepEqual(parsed.tags, ['力学', '牛顿第二定律']);
  assert.equal(parsed.knowledgePointDetails[0].lastAssessedAt, context.second.endedAt);
  assert.deepEqual(parsed.knowledgePointDetails[0].evidenceRefs, [
    { rehearsalId: context.second.rehearsalId, pointId: 'kp1' },
  ]);
});

test('strict fact validation rejects every invalid shape instead of filtering it', () => {
  const context = validationContext();
  const base = makeFactResponse({
    rehearsalId: context.second.rehearsalId,
    endedAt: context.second.endedAt,
  });
  const clone = () => JSON.parse(JSON.stringify(base));

  const cases = [
    ['summary 超过 200 code points', () => {
      const value = clone();
      value.summary = '😀'.repeat(201);
      return value;
    }],
    ['非法总体等级', () => {
      const value = clone();
      value.masteryLevel = 'expert';
      return value;
    }],
    ['非法证据状态', () => {
      const value = clone();
      value.knowledgePointDetails[0].evidenceStatus = 'strong';
      return value;
    }],
    ['证据不足却有等级', () => {
      const value = clone();
      value.knowledgePointDetails[0].evidenceStatus = 'insufficient';
      return value;
    }],
    ['证据充分却无考察时间', () => {
      const value = clone();
      value.knowledgePointDetails[0].lastAssessedAt = null;
      return value;
    }],
    ['空白字段', () => {
      const value = clone();
      value.knowledgePointDetails[0].details = '   ';
      return value;
    }],
    ['重复知识点', () => {
      const value = clone();
      value.knowledgePointDetails.push({ ...value.knowledgePointDetails[0] });
      return value;
    }],
    ['凭空引用', () => {
      const value = clone();
      value.knowledgePointDetails[0].evidenceRefs[0].rehearsalId = randomUUID();
      return value;
    }],
    ['不存在的 pointId', () => {
      const value = clone();
      value.knowledgePointDetails[0].evidenceRefs[0].pointId = 'missing';
      return value;
    }],
    ['伪造考察时间', () => {
      const value = clone();
      value.knowledgePointDetails[0].lastAssessedAt = '2020-01-01T00:00:00.000Z';
      return value;
    }],
    ['未知字段', () => {
      const value = clone();
      value.extra = true;
      return value;
    }],
    ['超过 8 个标签', () => {
      const value = clone();
      value.tags = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
      return value;
    }],
  ];

  for (const [name, build] of cases) {
    assert.throws(
      () => parseKnowledgeFactResponse(build(), context),
      KnowledgeFactValidationError,
      name,
    );
  }
});

test('old fact references may be carried forward but new truncated refs may not', () => {
  const first = evaluation({ endedAt: '2026-11-08T08:00:00.000Z' });
  const second = evaluation({ endedAt: '2026-11-10T08:00:00.000Z' });
  const existingFact = {
    summary: '旧摘要',
    knowledgePointDetails: [
      {
        name: '牛顿第二定律',
        masteryLevel: 'basic',
        evidenceStatus: 'sufficient',
        details: '旧判断',
        changeDescription: '旧变化',
        lastAssessedAt: first.endedAt,
        evidenceRefs: [{ rehearsalId: first.rehearsalId, pointId: 'kp1' }],
      },
    ],
    tags: ['力学'],
    masteryLevel: 'basic',
    generatedAt: '2026-11-08T09:00:00.000Z',
  };
  const response = makeFactResponse({
    rehearsalId: first.rehearsalId,
    endedAt: first.endedAt,
  });
  const parsed = parseKnowledgeFactResponse(response, {
    allEvaluations: [first, second],
    // Only the current evaluation was sent; the older reference must come from the old fact.
    promptEvaluations: [second],
    existingFact,
  });
  assert.deepEqual(parsed.knowledgePointDetails[0].evidenceRefs, [
    { rehearsalId: first.rehearsalId, pointId: 'kp1' },
  ]);

  const newReferenceToTruncatedEvaluation = JSON.parse(JSON.stringify(response));
  newReferenceToTruncatedEvaluation.knowledgePointDetails[0].evidenceRefs = [
    { rehearsalId: first.rehearsalId, pointId: 'kp1' },
  ];
  assert.throws(
    () =>
      parseKnowledgeFactResponse(newReferenceToTruncatedEvaluation, {
        allEvaluations: [first, second],
        promptEvaluations: [second],
        existingFact: null,
      }),
    KnowledgeFactValidationError,
  );
});

test('budget keeps all history first, then drops oldest whole evaluations', () => {
  const evaluations = Array.from({ length: 5 }, (_, index) =>
    evaluation({
      endedAt: `2026-11-0${index + 1}T08:00:00.000Z`,
      padding: '证据'.repeat(100),
    }),
  );
  const current = evaluations[evaluations.length - 1];
  const snapshot = { existingFact: null, evaluations };

  const full = buildBudgetedKnowledgeFactsPrompt({
    contextWindow: 128_000,
    snapshot,
    current,
  });
  assert.equal(full.retainedHistoryCount, 4);
  assert.equal(full.omittedHistoryCount, 0);
  assert.equal(full.prompt.includes(current.rehearsalId), true);
  assert.equal(
    full.prompt.split(`"rehearsalId": "${current.rehearsalId}"`).length - 1,
    1,
    'current evaluation must appear exactly once',
  );
  assert.equal(
    full.estimatedTokenUpperBound > full.prompt.length,
    true,
    'UTF-8 bytes must be used as the conservative upper bound',
  );

  const tight = buildBudgetedKnowledgeFactsPrompt({
    contextWindow: 30_000,
    snapshot,
    current,
  });
  assert.equal(tight.retainedHistoryCount > 0, true);
  assert.equal(tight.retainedHistoryCount < 4, true);
  assert.equal(tight.omittedHistoryCount, 4 - tight.retainedHistoryCount);
  assert.equal(
    tight.retainedHistoryFrom,
    evaluations[4 - tight.retainedHistoryCount].endedAt,
  );
  assert.equal(tight.retainedHistoryTo, evaluations[3].endedAt);

  assert.throws(
    () =>
      buildBudgetedKnowledgeFactsPrompt({
        contextWindow: 12_000,
        snapshot,
        current,
      }),
    /上下文窗口/,
  );
  assert.throws(
    () =>
      buildBudgetedKnowledgeFactsPrompt({
        contextWindow: null,
        snapshot,
        current,
      }),
    /上下文窗口/,
  );
  assert.throws(() => getAvailableFactPromptTokens(8_000), /上下文窗口/);
});

test('facts publish atomically with isolated model options', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await markPending(ctx, conversationId);

    ctx.service.wake(conversationId);
    await ctx.llm.waitForCalls(1);
    assert.deepEqual(ctx.llm.calls[0].options.tools, []);
    assert.equal(ctx.llm.calls[0].options.conversation, undefined);
    assert.equal(
      ctx.llm.calls[0].options.systemPromptAppend,
      KNOWLEDGE_FACTS_SYSTEM_PROMPT,
    );
    assert.equal(ctx.llm.calls[0].prompt.includes(rehearsalId), true);

    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({
          rehearsalId,
          endedAt: endedAt.toISOString(),
          summary: '已能解释牛顿第二定律。',
        }),
      ),
    );
    await ctx.service.waitForIdle();

    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'completed');
    assert.equal(row.summary, '已能解释牛顿第二定律。');
    assert.equal(row.lastError, null);
    assert.ok(row.generatedAt instanceof Date);
    assert.deepEqual(JSON.parse(row.tagsJson), ['力学', '牛顿第二定律']);
    const details = JSON.parse(row.knowledgePointDetailsJson);
    assert.deepEqual(details[0].evidenceRefs, [{ rehearsalId, pointId: 'kp1' }]);
  } finally {
    await ctx.close();
  }
});

test('deleting a report resets derived facts and clears the row when none remain', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);
    await ctx.llm.waitForCalls(1);
    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({
          rehearsalId,
          endedAt: endedAt.toISOString(),
          summary: '已能解释牛顿第二定律。',
        }),
      ),
    );
    await ctx.service.waitForIdle();
    assert.equal((await readFactRow(ctx, conversationId)).summary, '已能解释牛顿第二定律。');

    // Another completed report still exists, so the row is only queued for a recompute.
    await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: new Date('2026-11-11T08:00:00.000Z'),
    });
    const recompute = await ctx.dataSource.transaction((manager) =>
      ctx.service.resetAfterReportDeletion(manager, conversationId),
    );
    assert.equal(recompute, true);
    assert.equal((await readFactRow(ctx, conversationId)).generationStatus, 'pending');

    // The last report is gone: the row must disappear instead of keeping its content.
    await ctx.dataSource
      .getRepository(RehearsalEntity)
      .delete({ conversationId });
    const again = await ctx.dataSource.transaction((manager) =>
      ctx.service.resetAfterReportDeletion(manager, conversationId),
    );
    assert.equal(again, false);
    assert.equal(await readFactRow(ctx, conversationId), null);
  } finally {
    await ctx.close();
  }
});

test('a failed generation keeps all old content and records a sanitized error', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    const previousTime = new Date('2026-11-01T00:00:00.000Z');
    await markPending(ctx, conversationId);
    await ctx.dataSource.getRepository(ConversationKnowledgeFactEntity).update(
      { conversationId },
      {
        summary: '旧摘要',
        knowledgePointDetailsJson: '[]',
        tagsJson: '["旧"]',
        masteryLevel: 'basic',
        generatedAt: previousTime,
      },
    );

    ctx.service.wake(conversationId);
    await ctx.llm.waitForCalls(1);
    ctx.llm.rejectCall(0, new Error('LLM generation timed out. secret provider text'));
    await ctx.service.waitForIdle();

    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'failed');
    assert.equal(row.summary, '旧摘要');
    assert.equal(row.knowledgePointDetailsJson, '[]');
    assert.equal(row.tagsJson, '["旧"]');
    assert.equal(row.masteryLevel, 'basic');
    assert.equal(row.generatedAt.toISOString(), previousTime.toISOString());
    assert.equal(row.lastError, '生成超时，已保留上次结果。');
    assert.equal(row.lastError.includes('secret'), false);
    assert.equal(row.lastError.includes('provider'), false);
    assert.equal(rehearsalId.length > 0, true);
  } finally {
    await ctx.close();
  }
});

test('a report arriving during generation wins over the late result and reruns with it', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const firstEndedAt = new Date('2026-11-10T08:00:00.000Z');
    const firstRehearsal = await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: firstEndedAt,
      report: makeReport({ summary: '第一份报告', statuses: { kp1: 'weak' } }),
    });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);
    await ctx.llm.waitForCalls(1);

    // New report lands while the old call is still running.
    const secondEndedAt = new Date('2026-11-10T09:00:00.000Z');
    const secondRehearsal = await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: secondEndedAt,
      report: makeReport({ summary: '第二份报告', statuses: { kp1: 'mastered' } }),
    });
    await markPending(ctx, conversationId);

    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({
          rehearsalId: firstRehearsal,
          endedAt: firstEndedAt.toISOString(),
          summary: '旧结果不应发布',
        }),
      ),
    );

    await ctx.llm.waitForCalls(2);
    assert.equal(ctx.llm.calls[1].prompt.includes(secondRehearsal), true);
    ctx.llm.resolveCall(
      1,
      JSON.stringify(
        makeFactResponse({
          rehearsalId: secondRehearsal,
          endedAt: secondEndedAt.toISOString(),
          summary: '新结果已发布',
        }),
      ),
    );
    await ctx.service.waitForIdle();

    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'completed');
    assert.equal(row.summary, '新结果已发布');
  } finally {
    await ctx.close();
  }
});

test('an old failure cannot consume a pending rerun', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const firstEndedAt = new Date('2026-11-10T08:00:00.000Z');
    const firstRehearsal = await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: firstEndedAt,
    });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);
    await ctx.llm.waitForCalls(1);

    const secondEndedAt = new Date('2026-11-10T09:00:00.000Z');
    const secondRehearsal = await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: secondEndedAt,
    });
    await markPending(ctx, conversationId);

    ctx.llm.rejectCall(0, new Error('temporary provider failure'));
    await ctx.llm.waitForCalls(2);
    assert.equal(ctx.llm.calls[1].prompt.includes(secondRehearsal), true);
    ctx.llm.resolveCall(
      1,
      JSON.stringify(
        makeFactResponse({
          rehearsalId: secondRehearsal,
          endedAt: secondEndedAt.toISOString(),
          summary: '重跑成功',
        }),
      ),
    );
    await ctx.service.waitForIdle();

    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'completed');
    assert.equal(row.summary, '重跑成功');
    assert.equal(row.lastError, null);
    assert.equal(firstRehearsal.length > 0, true);
  } finally {
    await ctx.close();
  }
});

test('one worker serializes conversations and sends reruns to the queue tail', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationA = await seedConversation(ctx);
    const aEndedAt = new Date('2026-11-10T08:00:00.000Z');
    const aRehearsal = await seedCompletedRehearsal(ctx, conversationA, {
      endedAt: aEndedAt,
    });
    await markPending(ctx, conversationA);

    const conversationB = await seedConversation(ctx);
    const bEndedAt = new Date('2026-11-10T08:00:00.000Z');
    const bRehearsal = await seedCompletedRehearsal(ctx, conversationB, {
      endedAt: bEndedAt,
    });
    await markPending(ctx, conversationB);

    ctx.service.wake(conversationA);
    await ctx.llm.waitForCalls(1);
    ctx.service.wake(conversationB);
    await markPending(ctx, conversationA); // A now has a newer event while running.

    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({
          rehearsalId: aRehearsal,
          endedAt: aEndedAt.toISOString(),
          summary: 'A 旧结果',
        }),
      ),
    );

    // B is ahead of A's rerun, proving the rerun went to the tail.
    await ctx.llm.waitForCalls(2);
    assert.equal(ctx.llm.calls[1].prompt.includes(bRehearsal), true);
    ctx.llm.resolveCall(
      1,
      JSON.stringify(
        makeFactResponse({
          rehearsalId: bRehearsal,
          endedAt: bEndedAt.toISOString(),
          summary: 'B 结果',
        }),
      ),
    );

    await ctx.llm.waitForCalls(3);
    ctx.llm.resolveCall(
      2,
      JSON.stringify(
        makeFactResponse({
          rehearsalId: aRehearsal,
          endedAt: aEndedAt.toISOString(),
          summary: 'A 新结果',
        }),
      ),
    );
    await ctx.service.waitForIdle();

    assert.equal((await readFactRow(ctx, conversationA)).summary, 'A 新结果');
    assert.equal((await readFactRow(ctx, conversationB)).summary, 'B 结果');
  } finally {
    await ctx.close();
  }
});

test('the periodic scan picks up a pending row that was never woken', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await markPending(ctx, conversationId);

    const scan = ctx.service.scanPending();
    await ctx.llm.waitForCalls(1);
    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({ rehearsalId, endedAt: endedAt.toISOString() }),
      ),
    );
    await scan;
    await ctx.service.waitForIdle();

    assert.equal((await readFactRow(ctx, conversationId)).generationStatus, 'completed');
  } finally {
    await ctx.close();
  }
});

test('startup recovers a running row to pending before claiming it', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await ctx.dataSource.getRepository(ConversationKnowledgeFactEntity).save({
      conversationId,
      summary: null,
      knowledgePointDetailsJson: null,
      tagsJson: null,
      masteryLevel: null,
      generationStatus: 'running',
      lastError: null,
      generatedAt: null,
    });

    await ctx.service.onModuleInit();
    await ctx.llm.waitForCalls(1);
    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({ rehearsalId, endedAt: endedAt.toISOString() }),
      ),
    );
    await ctx.service.waitForIdle();

    assert.equal((await readFactRow(ctx, conversationId)).generationStatus, 'completed');
  } finally {
    await ctx.close();
  }
});

test('a real child process recovers an interrupted running row on restart', async () => {
  const ctx = await createFactsContext();
  const conversationId = await seedConversation(ctx);
  const endedAt = new Date('2026-11-10T08:00:00.000Z');
  const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
  const childPath = resolve(__dirname, 'helpers/knowledge-facts-child.cjs');
  const env = {
    ...process.env,
    TEACHFORGE_DATA_DIR: ctx.dataDirectory,
    TEACHFORGE_CONFIG_DIR: ctx.configDirectory,
    BACKEND_TEST_BUILD_DIR_ABS: buildDirectory,
  };
  await markPending(ctx, conversationId);
  const args = [conversationId, rehearsalId, 'kp1', endedAt.toISOString()];

  const runChild = (mode) =>
    new Promise((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [childPath, mode, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (mode === 'hang' && stdout.includes('CALL_STARTED')) {
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('exit', (code, signal) => {
        if (mode === 'hang') {
          resolveChild({ code, signal, stdout, stderr });
          return;
        }
        if (code !== 0) {
          rejectChild(new Error(`child failed: ${stderr || stdout}`));
          return;
        }
        resolveChild({ code, signal, stdout, stderr });
      });
    });

  try {
    await runChild('hang');
    const interrupted = await readFactRow(ctx, conversationId);
    assert.equal(interrupted.generationStatus, 'running');

    const restarted = await runChild('run');
    assert.match(restarted.stdout, /RESULT:/);
    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'completed');
  } finally {
    await ctx.close();
  }
});

test('migration up/down/up does not backfill or touch original data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'teachforge-facts-migration-'));
  const previousDataDirectory = process.env.TEACHFORGE_DATA_DIR;
  process.env.TEACHFORGE_DATA_DIR = join(root, 'data');
  const dataSource = new DataSource({
    ...buildDatabaseOptions(),
    migrationsRun: false,
  });
  try {
    await dataSource.initialize();
    await dataSource.runMigrations();
    const conversationId = '11111111-1111-4111-8111-111111111111';
    await dataSource.query('INSERT INTO conversations (id) VALUES (?)', [conversationId]);
    await dataSource.query(
      'INSERT INTO messages (id, "conversationId", "sequenceNo", role, "contentJson", status) VALUES (?, ?, ?, ?, ?, ?)',
      ['22222222-2222-4222-8222-222222222222', conversationId, 1, 'user', '[]', 'completed'],
    );
    await dataSource.query(
      'INSERT INTO rehearsals (id, "conversationId", status, "startRequestId") VALUES (?, ?, ?, ?)',
      ['33333333-3333-4333-8333-333333333333', conversationId, 'completed', randomUUID()],
    );
    assert.equal(
      Number(
        (
          await dataSource.query(
            'SELECT COUNT(*) AS total FROM conversation_knowledge_facts',
          )
        )[0].total,
      ),
      0,
      'migration must not backfill history',
    );

    await dataSource.query(
      'INSERT INTO conversation_knowledge_facts ("conversationId") VALUES (?)',
      [conversationId],
    );
    await assert.rejects(
      () =>
        dataSource.query(
          'INSERT INTO conversation_knowledge_facts ("conversationId") VALUES (?)',
          [conversationId],
        ),
      /UNIQUE|constraint/i,
    );

    await dataSource.undoLastMigration();
    const remainingTables = await dataSource.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_knowledge_facts'",
    );
    assert.equal(remainingTables.length, 0);
    assert.equal(
      Number((await dataSource.query('SELECT COUNT(*) AS total FROM conversations'))[0].total),
      1,
    );
    assert.equal(
      Number((await dataSource.query('SELECT COUNT(*) AS total FROM messages'))[0].total),
      1,
    );
    assert.equal(
      Number((await dataSource.query('SELECT COUNT(*) AS total FROM rehearsals'))[0].total),
      1,
    );

    await dataSource.runMigrations();
    assert.equal(
      Number(
        (
          await dataSource.query(
            'SELECT COUNT(*) AS total FROM conversation_knowledge_facts',
          )
        )[0].total,
      ),
      0,
      're-upgrade starts empty until the next report',
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    process.env.TEACHFORGE_DATA_DIR = previousDataDirectory;
    rmSync(root, { recursive: true, force: true });
  }
});

test('deleting a conversation during generation prevents a late result from reviving it', async () => {
  const ctx = await createFactsContext();
  try {
    const conversations = new ConversationsService(
      ctx.dataSource,
      {
        getSessionDirectory: (conversationId) =>
          join(ctx.configDirectory, 'sessions', conversationId),
      },
      {},
    );
    const conversationId = await seedConversation(ctx);
    await seedMessage(ctx, conversationId);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);
    await ctx.llm.waitForCalls(1);
    assert.equal((await readFactRow(ctx, conversationId)).generationStatus, 'running');

    await conversations.deleteConversation(conversationId);
    ctx.llm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({ rehearsalId, endedAt: endedAt.toISOString() }),
      ),
    );
    await ctx.service.waitForIdle();

    assert.equal(await readFactRow(ctx, conversationId), null);
    assert.equal(
      Number(
        (
          await ctx.dataSource.query(
            'SELECT COUNT(*) AS total FROM conversations WHERE id = ?',
            [conversationId],
          )
        )[0].total,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await ctx.dataSource.query(
            'SELECT COUNT(*) AS total FROM rehearsals WHERE "conversationId" = ?',
            [conversationId],
          )
        )[0].total,
      ),
      0,
    );
  } finally {
    await ctx.close();
  }
});

test('a failed conversation delete rolls back the fact row with the conversation', async () => {
  const ctx = await createFactsContext();
  try {
    const conversations = new ConversationsService(
      ctx.dataSource,
      {
        getSessionDirectory: (conversationId) =>
          join(ctx.configDirectory, 'sessions', conversationId),
      },
      {},
    );
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await markPending(ctx, conversationId);
    await ctx.dataSource.query(
      `CREATE TRIGGER fail_rehearsal_delete BEFORE DELETE ON rehearsals
       BEGIN SELECT RAISE(ABORT, 'blocked by test'); END`,
    );

    await assert.rejects(
      () => conversations.deleteConversation(conversationId),
      /blocked by test/,
    );
    assert.ok(await readFactRow(ctx, conversationId), 'fact deletion must roll back');
    assert.equal(
      Number(
        (
          await ctx.dataSource.query(
            'SELECT COUNT(*) AS total FROM conversations WHERE id = ?',
            [conversationId],
          )
        )[0].total,
      ),
      1,
    );

    await ctx.dataSource.query('DROP TRIGGER fail_rehearsal_delete');
    await conversations.deleteConversation(conversationId);
    assert.equal(await readFactRow(ctx, conversationId), null);
  } finally {
    await ctx.close();
  }
});

/** Seeds one awaiting-answer rehearsal with a single evaluated turn so `end` can run. */
async function seedAwaitingRehearsal(ctx, conversationId) {
  const rehearsalId = randomUUID();
  const startedAt = new Date('2026-11-10T08:00:00.000Z');
  const rehearsals = ctx.dataSource.getRepository(RehearsalEntity);
  const turns = ctx.dataSource.getRepository(RehearsalTurnEntity);
  await rehearsals.save(
    rehearsals.create({
      id: rehearsalId,
      conversationId,
      status: 'awaiting_answer',
      startRequestId: randomUUID(),
      personaText: null,
      contextUpToSequenceNo: null,
      planJson: JSON.stringify(PLAN),
      askedQuestionCount: 1,
      baseQuestionCount: 1,
      skippedCount: 0,
      overallEvaluationJson: null,
      endReason: null,
      loadedContext: false,
      startedAt,
      endedAt: null,
    }),
  );
  await turns.save(
    turns.create({
      id: randomUUID(),
      rehearsalId,
      sequenceNo: 1,
      kind: 'base',
      baseSequenceNo: 1,
      followUpDepth: 0,
      pointId: 'kp1',
      question: '请解释牛顿第二定律。',
      answer: 'F = ma',
      evaluationJson: JSON.stringify({
        level: 'partial',
        issues: [],
        evidence: ['提到了公式'],
        missingPoints: [],
      }),
      status: 'evaluated',
      answerRequestId: null,
      askedAt: startedAt,
      answeredAt: startedAt,
      evaluatedAt: startedAt,
    }),
  );
  return rehearsalId;
}

/** Builds a rehearsal service sharing the fact context's real database and worker. */
function createRehearsalService(ctx, reportLlm, facts) {
  return new RehearsalsService(
    ctx.dataSource,
    {},
    reportLlm,
    {
      getSessionDirectory: (conversationId) =>
        join(ctx.configDirectory, 'sessions', conversationId),
    },
    new RehearsalRunRegistry(),
    new RehearsalPreparingRegistry(),
    facts,
  );
}

test('report completion registers the fact signal in the same transaction and returns first', async () => {
  const factLlm = createControlledLlm();
  const ctx = await createFactsContext({ llm: factLlm });
  try {
    const reportLlm = {
      async generate(_prompt, options) {
        if (options.systemPromptAppend === KNOWLEDGE_FACTS_SYSTEM_PROMPT) {
          return factLlm.generate(_prompt, options);
        }
        return JSON.stringify(makeReport());
      },
    };
    const service = createRehearsalService(ctx, reportLlm, ctx.service);
    const conversationId = await seedConversation(ctx);
    const rehearsalId = await seedAwaitingRehearsal(ctx, conversationId);

    const detail = await service.end(rehearsalId, { requestId: randomUUID() });
    assert.equal(detail.status, 'completed');
    assert.ok(detail.report);

    const factRow = await readFactRow(ctx, conversationId);
    assert.ok(factRow, 'report completion must register a fact row');
    assert.equal(['pending', 'running'].includes(factRow.generationStatus), true);
    assert.equal(factRow.summary, null);

    await factLlm.waitForCalls(1);
    const repeated = await service.end(rehearsalId, { requestId: randomUUID() });
    assert.equal(repeated.status, 'completed');
    assert.equal(factLlm.calls.length, 1, 'repeat end must not register again');
    const completed = await ctx.dataSource
      .getRepository(RehearsalEntity)
      .findOneBy({ id: rehearsalId });
    factLlm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({
          rehearsalId,
          endedAt: completed.endedAt.toISOString(),
        }),
      ),
    );
    await ctx.service.waitForIdle();
    assert.equal((await readFactRow(ctx, conversationId)).generationStatus, 'completed');
  } finally {
    await ctx.close();
  }
});

test('a fact-signal write failure rolls the report completion back together', async () => {
  const ctx = await createFactsContext();
  try {
    const failingFacts = {
      async markPending() {
        throw new Error('fact write failed');
      },
      wake() {
        throw new Error('must not wake after rollback');
      },
    };
    const reportLlm = {
      async generate() {
        return JSON.stringify(makeReport());
      },
    };
    const service = createRehearsalService(ctx, reportLlm, failingFacts);
    const conversationId = await seedConversation(ctx);
    const rehearsalId = await seedAwaitingRehearsal(ctx, conversationId);

    await assert.rejects(() => service.end(rehearsalId, { requestId: randomUUID() }));
    const rehearsal = await ctx.dataSource
      .getRepository(RehearsalEntity)
      .findOneBy({ id: rehearsalId });
    assert.equal(rehearsal.status, 'reporting');
    assert.equal(rehearsal.overallEvaluationJson, null);
    assert.equal(await readFactRow(ctx, conversationId), null);
  } finally {
    await ctx.close();
  }
});

test('a corrupt completed report fails the fact task instead of silently dropping evidence', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: new Date('2026-11-10T08:00:00.000Z'),
    });
    await ctx.dataSource
      .getRepository(RehearsalEntity)
      .update({ id: rehearsalId }, { overallEvaluationJson: '{broken' });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);
    await ctx.service.waitForIdle();

    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'failed');
    assert.equal(row.lastError, '历史评估数据不完整，已保留上次结果。');
    assert.equal(ctx.llm.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('invalid structure is repaired at most twice before publishing', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, { endedAt });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);

    await ctx.llm.waitForCalls(1);
    ctx.llm.resolveCall(0, '{"summary":"","knowledgePointDetails":[],"tags":[],"masteryLevel":null}');
    await ctx.llm.waitForCalls(2);
    ctx.llm.resolveCall(1, 'not json at all');
    await ctx.llm.waitForCalls(3);
    ctx.llm.resolveCall(
      2,
      JSON.stringify(
        makeFactResponse({
          rehearsalId,
          endedAt: endedAt.toISOString(),
          summary: '第三次输出通过校验。',
        }),
      ),
    );
    await ctx.service.waitForIdle();

    assert.equal(ctx.llm.calls.length, 3);
    assert.equal(ctx.llm.calls[1].prompt.includes('上一次输出不符合要求'), true);
    assert.equal(ctx.llm.calls[2].prompt.includes('上一次输出不符合要求'), true);
    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'completed');
    assert.equal(row.summary, '第三次输出通过校验。');
  } finally {
    await ctx.close();
  }
});

test('exhausting structural repairs fails without publishing partial output', async () => {
  const ctx = await createFactsContext();
  try {
    const conversationId = await seedConversation(ctx);
    await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: new Date('2026-11-10T08:00:00.000Z'),
    });
    await markPending(ctx, conversationId);
    ctx.service.wake(conversationId);

    for (let index = 0; index < 3; index += 1) {
      await ctx.llm.waitForCalls(index + 1);
      ctx.llm.resolveCall(index, '{"summary":"","knowledgePointDetails":[],"tags":[],"masteryLevel":null}');
    }
    await ctx.service.waitForIdle();

    assert.equal(ctx.llm.calls.length, 3);
    const row = await readFactRow(ctx, conversationId);
    assert.equal(row.generationStatus, 'failed');
    assert.equal(row.summary, null);
    assert.equal(row.generatedAt, null);
    assert.equal(row.lastError, '模型输出未通过校验，已保留上次结果。');
  } finally {
    await ctx.close();
  }
});

/** Seeds one 15-question rehearsal whose only remaining action is a skip-limit completion. */
async function seedAtLimitForSkip(ctx, conversationId) {
  const rehearsalId = randomUUID();
  const startedAt = new Date('2026-11-10T08:00:00.000Z');
  const rehearsals = ctx.dataSource.getRepository(RehearsalEntity);
  const turns = ctx.dataSource.getRepository(RehearsalTurnEntity);
  await rehearsals.save(
    rehearsals.create({
      id: rehearsalId,
      conversationId,
      status: 'awaiting_answer',
      startRequestId: randomUUID(),
      personaText: null,
      contextUpToSequenceNo: null,
      planJson: JSON.stringify(PLAN),
      askedQuestionCount: 15,
      baseQuestionCount: 15,
      skippedCount: 0,
      overallEvaluationJson: null,
      endReason: null,
      loadedContext: false,
      startedAt,
      endedAt: null,
    }),
  );
  const evaluatedTurnId = randomUUID();
  const currentTurnId = randomUUID();
  await turns.save([
    turns.create({
      id: evaluatedTurnId,
      rehearsalId,
      sequenceNo: 1,
      kind: 'base',
      baseSequenceNo: 1,
      followUpDepth: 0,
      pointId: 'kp1',
      question: '请解释牛顿第二定律。',
      answer: 'F = ma',
      evaluationJson: JSON.stringify({
        level: 'partial',
        issues: [],
        evidence: ['提到了公式'],
        missingPoints: [],
      }),
      status: 'evaluated',
      answerRequestId: null,
      askedAt: startedAt,
      answeredAt: startedAt,
      evaluatedAt: startedAt,
    }),
    turns.create({
      id: currentTurnId,
      rehearsalId,
      sequenceNo: 15,
      kind: 'base',
      baseSequenceNo: 15,
      followUpDepth: 0,
      pointId: 'kp2',
      question: '第 15 问。',
      answer: null,
      evaluationJson: null,
      status: 'awaiting_answer',
      answerRequestId: null,
      askedAt: startedAt,
      answeredAt: null,
      evaluatedAt: null,
    }),
  ]);
  return { rehearsalId, currentTurnId };
}

test('skip reaching the question limit registers the fact signal through the shared path', async () => {
  const factLlm = createControlledLlm();
  const ctx = await createFactsContext({ llm: factLlm });
  try {
    const reportLlm = {
      async generate(_prompt, options) {
        if (options.systemPromptAppend === KNOWLEDGE_FACTS_SYSTEM_PROMPT) {
          return factLlm.generate(_prompt, options);
        }
        return JSON.stringify(makeReport());
      },
    };
    const service = createRehearsalService(ctx, reportLlm, ctx.service);
    const conversationId = await seedConversation(ctx);
    const { rehearsalId, currentTurnId } = await seedAtLimitForSkip(
      ctx,
      conversationId,
    );

    const result = await service.skip(
      rehearsalId,
      { turnId: currentTurnId },
      { requestId: randomUUID() },
    );
    assert.equal(result.completed, true);
    assert.ok(result.report);

    const factRow = await readFactRow(ctx, conversationId);
    assert.ok(factRow);
    assert.equal(['pending', 'running'].includes(factRow.generationStatus), true);

    await factLlm.waitForCalls(1);
    const repeated = await service.end(rehearsalId, { requestId: randomUUID() });
    assert.equal(repeated.status, 'completed');
    assert.equal(factLlm.calls.length, 1, 'repeat end must not register again');
    const completed = await ctx.dataSource
      .getRepository(RehearsalEntity)
      .findOneBy({ id: rehearsalId });
    factLlm.resolveCall(
      0,
      JSON.stringify(
        makeFactResponse({
          rehearsalId,
          endedAt: completed.endedAt.toISOString(),
        }),
      ),
    );
    await ctx.service.waitForIdle();
    assert.equal((await readFactRow(ctx, conversationId)).generationStatus, 'completed');
  } finally {
    await ctx.close();
  }
});

test('listAll returns every fact without knowledge-point details', async () => {
  const ctx = await createFactsContext();
  try {
    const firstConversation = await seedConversation(ctx);
    const secondConversation = await seedConversation(ctx);
    const repository = ctx.dataSource.getRepository(ConversationKnowledgeFactEntity);
    await repository.save([
      repository.create({
        conversationId: firstConversation,
        summary: '第一条事实',
        knowledgePointDetailsJson: JSON.stringify([
          { name: '详情不应出现在列表', details: '超大详情不应出现在列表' },
        ]),
        tagsJson: JSON.stringify(['力学']),
        masteryLevel: 'basic',
        generationStatus: 'completed',
        lastError: null,
        generatedAt: new Date('2026-11-10T08:00:00.000Z'),
      }),
      repository.create({
        conversationId: secondConversation,
        summary: null,
        knowledgePointDetailsJson: null,
        tagsJson: null,
        masteryLevel: null,
        generationStatus: 'pending',
        lastError: null,
        generatedAt: null,
      }),
    ]);

    const result = await ctx.service.listAll();
    assert.equal(result.items.length, 2);
    for (const item of result.items) {
      assert.equal('knowledgePointDetails' in item, false);
      assert.equal('details' in item, false);
    }
    const completed = result.items.find(
      (item) => item.conversationId === firstConversation,
    );
    assert.equal(completed.summary, '第一条事实');
    assert.deepEqual(completed.tags, ['力学']);
    assert.equal(completed.generationStatus, 'completed');
    assert.equal(completed.generatedAt, '2026-11-10T08:00:00.000Z');
    assert.equal(JSON.stringify(result).includes('超大详情不应出现在列表'), false);

    const pending = result.items.find(
      (item) => item.conversationId === secondConversation,
    );
    assert.equal(pending.summary, null);
    assert.equal(pending.tags, null);
    assert.equal(pending.generatedAt, null);

    const expectedOrder = [...result.items].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.conversationId.localeCompare(right.conversationId),
    );
    assert.deepEqual(
      result.items.map((item) => item.conversationId),
      expectedOrder.map((item) => item.conversationId),
    );
  } finally {
    await ctx.close();
  }
});
