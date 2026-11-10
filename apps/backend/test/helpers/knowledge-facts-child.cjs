require('reflect-metadata');

const { join } = require('node:path');
const { DataSource } = require('typeorm');

const buildDirectory = process.env.BACKEND_TEST_BUILD_DIR_ABS;
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { ConversationKnowledgeFactsService } = load(
  'rehearsals/conversation-knowledge-facts.service.js',
);
const { ConversationKnowledgeFactEntity } = load(
  'rehearsals/conversation-knowledge-fact.entity.js',
);

const [mode, conversationId, rehearsalId, pointId, endedAt] = process.argv.slice(2);

/** Minimal controlled model: hangs forever or returns one valid fact anchored to real evidence. */
function createChildLlm() {
  return {
    async generate(_prompt, options) {
      options.buildPrompt?.({ contextWindow: 128_000 });
      if (mode === 'hang') {
        process.stdout.write('CALL_STARTED\n');
        return new Promise(() => undefined);
      }
      return JSON.stringify({
        summary: '重启后恢复生成的知识事实。',
        knowledgePointDetails: [
          {
            name: '牛顿第二定律',
            masteryLevel: 'basic',
            evidenceStatus: 'sufficient',
            details: '重启恢复场景的测试内容。',
            changeDescription: '本次为首次有效评估，尚无纵向比较。',
            lastAssessedAt: endedAt,
            evidenceRefs: [{ rehearsalId, pointId }],
          },
        ],
        tags: ['重启恢复'],
        masteryLevel: 'basic',
      });
    },
  };
}

/** Runs the real service against the shared temp database until the requested mode settles. */
async function main() {
  const dataSource = new DataSource({
    ...buildDatabaseOptions(),
    migrationsRun: true,
  });
  await dataSource.initialize();
  const service = new ConversationKnowledgeFactsService(
    dataSource,
    createChildLlm(),
  );
  await service.onModuleInit();

  if (mode === 'hang') {
    // Keep the process alive until the parent kills it; the durable row stays running.
    setInterval(() => undefined, 1_000);
    return;
  }

  await service.waitForIdle();
  const row = await dataSource
    .getRepository(ConversationKnowledgeFactEntity)
    .findOne({ where: { conversationId } });
  process.stdout.write(
    `RESULT:${JSON.stringify({
      status: row?.generationStatus ?? null,
      summary: row?.summary ?? null,
    })}\n`,
  );
  await service.onModuleDestroy();
  await dataSource.destroy();
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
