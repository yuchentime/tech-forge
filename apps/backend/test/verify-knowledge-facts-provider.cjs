require('reflect-metadata');

const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

const buildDirectory = resolve(
  __dirname,
  '..',
  process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist',
);
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { RehearsalsModule } = load('rehearsals/rehearsals.module.js');
const { ConversationEntity } = load('conversations/conversation.entity.js');
const { RehearsalEntity } = load('rehearsals/rehearsal.entity.js');
const { ConversationKnowledgeFactsService } = load(
  'rehearsals/conversation-knowledge-facts.service.js',
);
const { SettingsService } = load('settings/settings.service.js');

const conversationId = '11111111-1111-4111-8111-111111111111';
const firstRehearsalId = '22222222-2222-4222-8222-222222222222';
const secondRehearsalId = '33333333-3333-4333-8333-333333333333';

/** Builds a report for the supplied per-point statuses. */
function report(summary, statuses) {
  return {
    summary,
    knowledgePointMastery: statuses.map(([pointId, status]) => ({
      pointId,
      status,
      evidence: `${pointId} 的脱敏样例依据`,
    })),
    strengths: [],
    gaps: [],
    suggestions: [],
    recommendedReview: [],
    disclaimer: '样例验收，不代表全面掌握。',
  };
}

/** Seeds a deterministic weak → strong email sequence with a range difference and a gap. */
async function seed(dataSource) {
  const conversations = dataSource.getRepository(ConversationEntity);
  const rehearsals = dataSource.getRepository(RehearsalEntity);
  await conversations.save({ id: conversationId, title: null, metadataJson: null });

  const plan = (label) => ({
    topic: '牛顿力学',
    learningSummary: '学习牛顿第二定律与受力分析。',
    knowledgePoints: [
      { id: 'kp1', label, why: '核心规律' },
      { id: 'kp2', label: '惯性参考系', why: '适用边界' },
      { id: 'kp3', label: '受力分析', why: '应用方法' },
    ],
    generatedAt: '2026-11-01T00:00:00.000Z',
  });

  await rehearsals.save([
    rehearsals.create({
      id: firstRehearsalId,
      conversationId,
      status: 'completed',
      startRequestId: '44444444-4444-4444-8444-444444444444',
      planJson: JSON.stringify(plan('牛顿第二定律（基础表述）')),
      overallEvaluationJson: JSON.stringify(
        report('只能复述公式，边界条件不清楚。', [
          ['kp1', 'weak'],
          ['kp2', 'partial'],
          ['kp3', 'unverified'],
        ]),
      ),
      endReason: 'manual',
      startedAt: new Date('2026-11-08T08:00:00.000Z'),
      endedAt: new Date('2026-11-08T08:10:00.000Z'),
    }),
    rehearsals.create({
      id: secondRehearsalId,
      conversationId,
      status: 'completed',
      startRequestId: '55555555-5555-4555-8555-555555555555',
      planJson: JSON.stringify(plan('牛顿第二定律（综合应用）')),
      overallEvaluationJson: JSON.stringify(
        report('能在综合情境中应用，惯性参考系的判断仍有分歧。', [
          ['kp1', 'mastered'],
          ['kp2', 'weak'],
          ['kp3', 'unverified'],
        ]),
      ),
      endReason: 'manual',
      startedAt: new Date('2026-11-10T08:00:00.000Z'),
      endedAt: new Date('2026-11-10T08:10:00.000Z'),
    }),
  ]);
}

/** Runs one real-provider generation and prints a redacted acceptance record. */
async function main() {
  if (process.env.TEACHFORGE_REAL_PROVIDER !== '1') {
    process.stdout.write(
      'SKIPPED: set TEACHFORGE_REAL_PROVIDER=1 to call the configured provider.\n',
    );
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'teachforge-facts-provider-'));
  process.env.TEACHFORGE_DATA_DIR = join(root, 'data');

  class ProviderModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      RehearsalsModule,
    ],
  })(ProviderModule);

  const app = await NestFactory.createApplicationContext(ProviderModule, {
    logger: false,
  });
  const dataSource = app.get(DataSource);
  const settings = app.get(SettingsService);
  const service = app.get(ConversationKnowledgeFactsService);

  try {
    const local = await settings.getSettings();
    if (!local.llm.deepseek.apiKeyConfigured) {
      process.stdout.write(
        'SKIPPED: DeepSeek has no configured API key.\n',
      );
      return;
    }

    await seed(dataSource);
    // The startup scan already found an empty database; the periodic scan coalesces with
    // `scanPending`, so the acceptance run does not need to stop the worker.
    await dataSource.transaction(async (manager) => {
      await service.markPending(manager, conversationId);
    });

    await service.scanPending();
    await service.waitForIdle();

    const row = await dataSource.query(
      'SELECT * FROM conversation_knowledge_facts WHERE "conversationId" = ?',
      [conversationId],
    );
    const fact = row[0];
    const record = {
      provider: 'deepseek',
      model: local.llm.deepseek.modelId,
      generationStatus: fact?.generationStatus ?? null,
      lastError: fact?.lastError ?? null,
      summary: fact?.summary ?? null,
      knowledgePointDetails: fact?.knowledgePointDetailsJson
        ? JSON.parse(fact.knowledgePointDetailsJson)
        : null,
      tags: fact?.tagsJson ? JSON.parse(fact.tagsJson) : null,
      masteryLevel: fact?.masteryLevel ?? null,
    };
    const recordPath = join(root, 'knowledge-facts-provider-record.json');
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    process.stdout.write(`RECORD:${JSON.stringify(record)}\n`);
    process.stdout.write(`TEMP_FILE:${recordPath}\n`);
    process.stdout.write(`STATUS:${record.generationStatus}\n`);
    process.stdout.write(
      `SEMANTIC_REVIEW_REQUIRED: 人工核对进步、未考察保留、范围差异和分歧是否符合 AC-05。\n`,
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
