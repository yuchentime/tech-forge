require('reflect-metadata');

const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(
  __dirname,
  '..',
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { ConversationEntity } = load('conversations/conversation.entity.js');
const { MessageEntity } = load('conversations/message.entity.js');
const { ConversationKnowledgeFactEntity } = load(
  'rehearsals/conversation-knowledge-fact.entity.js',
);
const { ConversationKnowledgeFactsService } = load(
  'rehearsals/conversation-knowledge-facts.service.js',
);
const { RehearsalEntity } = load('rehearsals/rehearsal.entity.js');

/** Deterministic plan used by fact fixtures. */
const PLAN = {
  topic: '牛顿力学',
  learningSummary: '已经学习力、质量与加速度的关系。',
  knowledgePoints: [
    { id: 'kp1', label: '牛顿第二定律', why: '核心规律' },
    { id: 'kp2', label: '惯性参考系', why: '适用边界' },
    { id: 'kp3', label: '受力分析', why: '应用方法' },
  ],
  generatedAt: '2026-11-01T00:00:00.000Z',
};

/** One report whose point statuses are supplied by the caller. */
function makeReport({
  summary = '总体掌握一般。',
  statuses = { kp1: 'partial', kp2: 'weak', kp3: 'unverified' },
} = {}) {
  return {
    summary,
    knowledgePointMastery: Object.entries(statuses).map(([pointId, status]) => ({
      pointId,
      status,
      evidence: `${pointId} 的评估依据`,
    })),
    strengths: ['能说明基本关系'],
    gaps: ['边界条件'],
    suggestions: ['再练习一道综合题'],
    recommendedReview: ['牛顿第二定律'],
    disclaimer: '本次演练只反映已作答内容。',
  };
}

/** Blocks every model call until the test resolves or rejects it, then records its input. */
function createControlledLlm(options = {}) {
  const calls = [];
  const callWaiters = [];
  let contextWindow = options.contextWindow === undefined ? 128_000 : options.contextWindow;
  const notify = () => {
    for (const waiter of callWaiters.splice(0)) waiter();
  };

  return {
    calls,
    get contextWindow() {
      return contextWindow;
    },
    setContextWindow(value) {
      contextWindow = value;
    },
    async generate(prompt, generateOptions = {}) {
      const actualPrompt = generateOptions.buildPrompt
        ? generateOptions.buildPrompt({ contextWindow })
        : prompt;
      const deferred = Promise.withResolvers();
      calls.push({ prompt: actualPrompt, options: generateOptions, deferred });
      notify();
      return deferred.promise;
    },
    waitForCalls(count) {
      if (calls.length >= count) return Promise.resolve();
      const deferred = Promise.withResolvers();
      const check = () => {
        if (calls.length >= count) deferred.resolve();
        else callWaiters.push(check);
      };
      callWaiters.push(check);
      return deferred.promise;
    },
    resolveCall(index, text) {
      calls[index].deferred.resolve(text);
    },
    rejectCall(index, error) {
      calls[index].deferred.reject(error);
    },
  };
}

/** Boots a real SQLite database and the fact service with a controlled model. */
async function createFactsContext(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'teachforge-facts-'));
  const dataDirectory = join(root, 'data');
  const configDirectory = join(root, 'config');
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;

  const dataSource = new DataSource({
    ...buildDatabaseOptions(),
    migrationsRun: true,
  });
  await dataSource.initialize();
  const llm = options.llm ?? createControlledLlm();
  const service = new ConversationKnowledgeFactsService(dataSource, llm);

  return {
    root,
    configDirectory,
    dataDirectory,
    dataSource,
    llm,
    service,
    async close() {
      await service.onModuleDestroy();
      if (dataSource.isInitialized) await dataSource.destroy();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Seeds one conversation with no fact row. */
async function seedConversation(context) {
  const conversationId = randomUUID();
  await context.dataSource.getRepository(ConversationEntity).save({
    id: conversationId,
    title: null,
    metadataJson: null,
  });
  return conversationId;
}

/** Seeds one completed rehearsal with a plan and report. */
async function seedCompletedRehearsal(context, conversationId, options = {}) {
  const rehearsalId = options.rehearsalId ?? randomUUID();
  const endedAt = options.endedAt ?? new Date();
  const repository = context.dataSource.getRepository(RehearsalEntity);
  await repository.save(
    repository.create({
      id: rehearsalId,
      conversationId,
      status: 'completed',
      startRequestId: options.startRequestId ?? randomUUID(),
      personaText: null,
      contextUpToSequenceNo: null,
      planJson: JSON.stringify(options.plan ?? PLAN),
      askedQuestionCount: 3,
      baseQuestionCount: 3,
      skippedCount: 0,
      overallEvaluationJson: JSON.stringify(options.report ?? makeReport()),
      endReason: 'manual',
      loadedContext: false,
      startedAt: new Date(endedAt.getTime() - 60_000),
      endedAt,
    }),
  );
  return rehearsalId;
}

/** Seeds one message row so delete regression checks have non-rehearsal data. */
async function seedMessage(context, conversationId) {
  const repository = context.dataSource.getRepository(MessageEntity);
  await repository.save(
    repository.create({
      id: randomUUID(),
      conversationId,
      sequenceNo: 1,
      role: 'user',
      contentJson: JSON.stringify([{ type: 'text', text: '测试问题' }]),
      status: 'completed',
      requestId: null,
      contextRefsJson: null,
    }),
  );
}

/** Marks a conversation pending through the same transaction API used by report completion. */
async function markPending(context, conversationId) {
  const service = context.service ?? context.facts;
  await context.dataSource.transaction(async (manager) => {
    await service.markPending(manager, conversationId);
  });
}

/** Builds a structurally valid fact response anchored to real plan points. */
function makeFactResponse({
  rehearsalId,
  pointId = 'kp1',
  summary = '已经能够解释牛顿第二定律，复杂情境仍待验证。',
  masteryLevel = 'basic',
  evidenceStatus = 'sufficient',
  endedAt = '2026-11-10T08:00:00.000Z',
  tags = ['力学', '牛顿第二定律'],
} = {}) {
  return {
    summary,
    knowledgePointDetails: [
      {
        name: '牛顿第二定律',
        masteryLevel: evidenceStatus === 'insufficient' ? null : masteryLevel,
        evidenceStatus,
        details: '能够说明力、质量与加速度之间的关系；复杂情境尚未验证。',
        changeDescription: '本次为首次有效评估，尚无纵向比较。',
        lastAssessedAt:
          evidenceStatus === 'insufficient' ? null : endedAt,
        evidenceRefs:
          evidenceStatus === 'insufficient'
            ? []
            : [{ rehearsalId, pointId }],
      },
    ],
    tags,
    masteryLevel,
  };
}

/** Reads the stored fact row directly. */
async function readFactRow(context, conversationId) {
  return context.dataSource
    .getRepository(ConversationKnowledgeFactEntity)
    .findOne({ where: { conversationId } });
}

module.exports = {
  PLAN,
  buildDirectory,
  ConversationKnowledgeFactEntity,
  createControlledLlm,
  createFactsContext,
  makeFactResponse,
  makeReport,
  markPending,
  readFactRow,
  seedCompletedRehearsal,
  seedConversation,
  seedMessage,
};
