require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

const {
  buildDirectory,
  makeFactResponse,
  makeReport,
  markPending,
  seedCompletedRehearsal,
  seedConversation,
} = require('./helpers/knowledge-facts-fixtures.cjs');

const load = (modulePath) => require(join(buildDirectory, modulePath));
const { buildDatabaseOptions } = load('database/database.options.js');
const { RehearsalsModule } = load('rehearsals/rehearsals.module.js');
const { ConversationKnowledgeFactsService } = load(
  'rehearsals/conversation-knowledge-facts.service.js',
);
const { ConversationKnowledgeFactEntity } = load(
  'rehearsals/conversation-knowledge-fact.entity.js',
);

const LOCAL_TOKEN = 'knowledge-facts-test-token';
const schemaPath = resolve(
  __dirname,
  '../../../docs/changes/2026-11-10-conversation-knowledge-facts/api-schema.json',
);
const schema = require(schemaPath);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-facts-http-'));
const createdApps = [];

test.after(() => {
  for (const app of createdApps) {
    try {
      app.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** Boots the real rehearsals module through Fastify and stops its background worker. */
async function createServer() {
  const root = mkdtempSync(join(scratchRoot, 'app-'));
  const configDirectory = join(root, 'config');
  mkdirSync(configDirectory, { recursive: true });
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = join(root, 'data');

  class IntegrationModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      RehearsalsModule,
    ],
  })(IntegrationModule);

  const app = await NestFactory.create(
    IntegrationModule,
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin) {
      reply.code(403).send({ statusCode: 403, message: 'Origin is not allowed.' });
      return;
    }
    if (request.headers['x-teachforge-token'] !== LOCAL_TOKEN) {
      reply.code(401).send({ statusCode: 401, message: 'Unauthorized.' });
    }
  });
  await app.listen(0, '127.0.0.1');
  createdApps.push(app);
  const address = app.getHttpServer().address();

  // Prove the read endpoint cannot trigger generation: the worker is stopped before seeding.
  const facts = app.get(ConversationKnowledgeFactsService);
  await facts.onModuleDestroy();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    dataSource: app.get(DataSource),
    facts,
    async close() {
      await app.close();
      const index = createdApps.indexOf(app);
      if (index >= 0) createdApps.splice(index, 1);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Sends one request with optional auth/origin overrides. */
async function request(ctx, path, options = {}) {
  const headers = {};
  if (options.token !== false) {
    headers['x-teachforge-token'] = options.token ?? LOCAL_TOKEN;
  }
  if (options.origin) headers.origin = options.origin;
  const response = await fetch(`${ctx.baseUrl}${path}`, { headers });
  const text = await response.text();
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Persists one complete fact row for HTTP status coverage. */
async function seedPublishedFact(ctx, conversationId, rehearsalId, endedAt) {
  const response = makeFactResponse({
    rehearsalId,
    endedAt,
    summary: '已能解释牛顿第二定律，复杂情境尚待验证。',
  });
  await ctx.dataSource.getRepository(ConversationKnowledgeFactEntity).save({
    conversationId,
    summary: response.summary,
    knowledgePointDetailsJson: JSON.stringify(response.knowledgePointDetails),
    tagsJson: JSON.stringify(response.tags),
    masteryLevel: response.masteryLevel,
    generationStatus: 'completed',
    lastError: null,
    generatedAt: new Date('2026-11-10T09:00:00.000Z'),
  });
}

test('GET returns null for an existing conversation without a fact row', async () => {
  const ctx = await createServer();
  try {
    const conversationId = await seedConversation(ctx);
    const result = await request(ctx, `/api/conversations/${conversationId}/knowledge-facts`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { conversationId, fact: null });
    assert.equal(validate(result.data), true, JSON.stringify(validate.errors));
  } finally {
    await ctx.close();
  }
});

test('GET /api/knowledge-facts lists every fact without knowledge-point details', async () => {
  const ctx = await createServer();
  try {
    const empty = await request(ctx, '/api/knowledge-facts');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { items: [] });

    const firstConversation = await seedConversation(ctx);
    const secondConversation = await seedConversation(ctx);
    await seedPublishedFact(
      ctx,
      firstConversation,
      '22222222-2222-4222-8222-222222222222',
      '2026-11-10T08:00:00.000Z',
    );
    await ctx.dataSource.getRepository(ConversationKnowledgeFactEntity).save({
      conversationId: secondConversation,
      summary: '整体证据不足，但摘要和标签已发布。',
      knowledgePointDetailsJson: '[]',
      tagsJson: JSON.stringify(['系统思考']),
      masteryLevel: null,
      generationStatus: 'completed',
      lastError: null,
      generatedAt: new Date('2026-11-10T09:00:00.000Z'),
    });

    const result = await request(ctx, '/api/knowledge-facts');
    assert.equal(result.status, 200);
    assert.equal(result.data.items.length, 2);
    for (const item of result.data.items) {
      assert.equal(typeof item.conversationId, 'string');
      assert.equal('knowledgePointDetails' in item, false);
      assert.equal('details' in item, false);
      assert.equal(Array.isArray(item.tags), true);
    }
    assert.equal(
      result.data.items.some(
        (item) =>
          item.conversationId === secondConversation &&
          item.masteryLevel === null &&
          item.summary === '整体证据不足，但摘要和标签已发布。',
      ),
      true,
      'null overall mastery must remain a published list row',
    );
  } finally {
    await ctx.close();
  }
});

test('GET exposes every state and validates against the response schema', async () => {
  const ctx = await createServer();
  try {
    const conversationId = await seedConversation(ctx);
    const endedAt = new Date('2026-11-10T08:00:00.000Z');
    const rehearsalId = await seedCompletedRehearsal(ctx, conversationId, {
      endedAt,
      report: makeReport(),
    });

    await markPending(ctx, conversationId);
    let result = await request(ctx, `/api/conversations/${conversationId}/knowledge-facts`);
    assert.equal(result.status, 200);
    assert.equal(result.data.fact.generationStatus, 'pending');
    assert.equal(result.data.fact.summary, null);
    assert.equal(result.data.fact.generatedAt, null);
    assert.equal(validate(result.data), true, JSON.stringify(validate.errors));

    await seedPublishedFact(ctx, conversationId, rehearsalId, endedAt.toISOString());
    result = await request(ctx, `/api/conversations/${conversationId}/knowledge-facts`);
    assert.equal(result.status, 200);
    assert.equal(result.data.fact.generationStatus, 'completed');
    assert.equal(result.data.fact.lastError, null);
    assert.equal(validate(result.data), true, JSON.stringify(validate.errors));

    await ctx.dataSource.getRepository(ConversationKnowledgeFactEntity).update(
      { conversationId },
      {
        generationStatus: 'failed',
        lastError: '生成超时，已保留上次结果。',
      },
    );
    result = await request(ctx, `/api/conversations/${conversationId}/knowledge-facts`);
    assert.equal(result.status, 200);
    assert.equal(result.data.fact.generationStatus, 'failed');
    assert.equal(result.data.fact.summary, '已能解释牛顿第二定律，复杂情境尚待验证。');
    assert.equal(validate(result.data), true, JSON.stringify(validate.errors));
  } finally {
    await ctx.close();
  }
});

test('GET never triggers generation or changes a pending row', async () => {
  const ctx = await createServer();
  try {
    const conversationId = await seedConversation(ctx);
    await seedCompletedRehearsal(ctx, conversationId, {
      endedAt: new Date('2026-11-10T08:00:00.000Z'),
    });
    await markPending(ctx, conversationId);
    const before = await ctx.dataSource
      .getRepository(ConversationKnowledgeFactEntity)
      .findOne({ where: { conversationId } });

    const result = await request(ctx, `/api/conversations/${conversationId}/knowledge-facts`);
    assert.equal(result.status, 200);
    assert.equal(result.data.fact.generationStatus, 'pending');

    const after = await ctx.dataSource
      .getRepository(ConversationKnowledgeFactEntity)
      .findOne({ where: { conversationId } });
    assert.equal(after.generationStatus, 'pending');
    assert.equal(after.updatedAt.toISOString(), before.updatedAt.toISOString());
    assert.equal(before.summary, null);
  } finally {
    await ctx.close();
  }
});

test('GET enforces auth, Origin priority, UUID, existence and corruption boundaries', async () => {
  const ctx = await createServer();
  try {
    const conversationId = await seedConversation(ctx);
    const path = `/api/conversations/${conversationId}/knowledge-facts`;

    const noToken = await request(ctx, path, { token: false });
    assert.equal(noToken.status, 401);
    assert.deepEqual(noToken.data, { statusCode: 401, message: 'Unauthorized.' });

    const listNoToken = await request(ctx, '/api/knowledge-facts', { token: false });
    assert.equal(listNoToken.status, 401);

    const listOrigin = await request(ctx, '/api/knowledge-facts', {
      token: LOCAL_TOKEN,
      origin: 'http://evil.test',
    });
    assert.equal(listOrigin.status, 403);

    const wrongToken = await request(ctx, path, { token: 'nope' });
    assert.equal(wrongToken.status, 401);

    const originWins = await request(ctx, path, {
      token: 'nope',
      origin: 'http://evil.test',
    });
    assert.equal(originWins.status, 403);
    assert.deepEqual(originWins.data, {
      statusCode: 403,
      message: 'Origin is not allowed.',
    });

    const invalidId = await request(ctx, '/api/conversations/not-a-uuid/knowledge-facts');
    assert.equal(invalidId.status, 400);
    assert.equal(invalidId.data.statusCode, 400);

    const missing = await request(
      ctx,
      '/api/conversations/99999999-9999-4999-8999-999999999999/knowledge-facts',
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.data.statusCode, 404);
    assert.equal('fact' in missing.data, false);

    await ctx.dataSource.getRepository(ConversationKnowledgeFactEntity).save({
      conversationId,
      summary: '损坏前摘要',
      knowledgePointDetailsJson: '[]',
      tagsJson: '{not-json',
      masteryLevel: 'basic',
      generationStatus: 'completed',
      lastError: null,
      generatedAt: new Date('2026-11-10T09:00:00.000Z'),
    });
    const corrupt = await request(ctx, path);
    assert.equal(corrupt.status, 500);
    assert.equal(corrupt.data.statusCode, 500);
    assert.equal(JSON.stringify(corrupt.data).includes('not-json'), false);
  } finally {
    await ctx.close();
  }
});
