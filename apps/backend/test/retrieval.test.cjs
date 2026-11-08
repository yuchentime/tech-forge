require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { DocumentsModule } = load('documents/documents.module.js');
const { DocumentsService } = load('documents/documents.service.js');
const { RetrievalModule } = load('retrieval/retrieval.module.js');
const { RetrievalService } = load('retrieval/retrieval.service.js');
const { QUERY_EXPANDER } = load('retrieval/query-expander.js');
const { EmbeddingModule } = load('embedding/embedding.module.js');
const { EmbeddingService } = load('embedding/embedding.service.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-retrieval-'));
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

/**
 * Boots the real module graph (documents + retrieval + embedding) against a real SQLite file with
 * production migrations and the bundled ONNX model. Nothing is stubbed.
 */
async function createIntegrationApp() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class IntegrationModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      DocumentsModule,
      RetrievalModule,
    ],
  })(IntegrationModule);

  const app = await NestFactory.createApplicationContext(IntegrationModule, { logger: false });
  createdApps.push(app);
  const dataSource = app.get(DataSource);
  return {
    dataDirectory,
    dataSource,
    documents: app.get(DocumentsService),
    retrieval: app.get(RetrievalService),
    embeddings: app.get(EmbeddingService),
    async close() {
      await app.close();
      const index = createdApps.indexOf(app);
      if (index >= 0) createdApps.splice(index, 1);
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** Writes a real Markdown file into the scratch directory. */
function writeFixture(name, content) {
  const path = join(scratchRoot, name);
  writeFileSync(path, content);
  return path;
}

test('ingest stores one dense vector per chunk and marks the version ready', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'vectors.md',
    '# 光合作用\n\n光合作用是绿色植物把光能转化为化学能的过程。\n\n## 光反应\n\n光反应发生在类囊体薄膜上。',
  );

  try {
    const ingested = await ctx.documents.ingestFile({ filePath: source });
    assert.equal(ingested.status, 'ready');

    const vectors = await ctx.dataSource.query(
      'SELECT chunkId, documentId, documentVersionId, embeddingModel, embeddingDim, vector FROM chunk_embeddings',
    );
    assert.equal(vectors.length, ingested.chunkCount);
    for (const row of vectors) {
      assert.equal(row.embeddingModel, ctx.embeddings.modelId);
      assert.equal(row.embeddingDim, ctx.embeddings.dimension);
      assert.equal(row.vector.length, ctx.embeddings.dimension * 4);
      const floats = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      const norm = Math.sqrt(floats.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(norm - 1) < 0.01, `vector not normalised: ${norm}`);
    }

    const version = await ctx.dataSource.query(
      'SELECT processingStatus FROM document_versions WHERE id = ?',
      [ingested.documentVersionId],
    );
    assert.equal(version[0].processingStatus, 'ready');
  } finally {
    await ctx.close();
  }
});

test('semantic channel finds a paraphrase that shares no query terms', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'semantic.md',
    '# 光合作用\n\n光合作用是绿色植物把太阳能转化为化学能的过程，发生在叶绿体中。\n\n# 呼吸作用\n\n呼吸作用在线粒体中分解有机物释放能量。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const hits = await ctx.retrieval.search({ query: '植物如何把太阳光变成能量', limit: 3 });

    assert.ok(hits.length > 0);
    assert.match(hits[0].content, /光合作用|叶绿体/);
    assert.ok(
      hits[0].score.vectorRank !== undefined,
      'dense channel must contribute to the top hit',
    );
    assert.ok(hits.every((hit) => hit.content.length > 0 && hit.locatorJson.length > 0));
  } finally {
    await ctx.close();
  }
});

test('lexical channel covers exact Chinese terms and two-character prefixes', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'lexical.md',
    '# 编排模式\n\n编排模式决定上下文如何在模型调用之间流动。\n\n# 工具调用\n\n工具调用由模型决定参数。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });

    const exact = await ctx.retrieval.search({ query: '编排模式', limit: 3 });
    assert.ok(exact.length > 0);
    assert.ok(exact.some((hit) => hit.score.lexicalRank !== undefined));

    const prefix = await ctx.retrieval.search({ query: '编排', limit: 3 });
    assert.ok(prefix.length > 0, 'two-character query must hit through bigrams');
    assert.match(prefix[0].content, /编排模式/);
  } finally {
    await ctx.close();
  }
});

test('fusion ranks a chunk found by both channels first', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'fusion.md',
    '# 分片预算\n\n分片预算以 embedding token 计算，目标五百个 token。\n\n# 无关章节\n\n这一节记录文档入库的状态机与失败处理。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const hits = await ctx.retrieval.search({ query: '分片预算以 embedding token 计算', limit: 5 });

    assert.ok(hits.length >= 1);
    const top = hits[0];
    assert.match(top.content, /分片预算/);
    assert.ok(top.score.lexicalRank !== undefined, 'top hit should match lexically');
    assert.ok(top.score.vectorRank !== undefined, 'top hit should also match densely');
    assert.ok(
      (top.score.lexicalRank ?? 99) < 5 && (top.score.vectorRank ?? 99) < 5,
      'both channels should rank the top hit highly',
    );
  } finally {
    await ctx.close();
  }
});

test('document scope limits recall to the requested documents', async () => {
  const ctx = await createIntegrationApp();
  const first = await ctx.documents.ingestFile({
    filePath: writeFixture('scope-a.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。'),
  });
  const second = await ctx.documents.ingestFile({
    filePath: writeFixture('scope-b.md', '# 光合作用补充\n\n光合作用的暗反应在叶绿体基质进行。'),
  });
  assert.notEqual(first.documentId, second.documentId);

  try {
    const all = await ctx.retrieval.search({ query: '光合作用', limit: 10 });
    assert.ok(new Set(all.map((hit) => hit.documentId)).size >= 2, 'unscoped search spans documents');

    const scoped = await ctx.retrieval.search({
      query: '光合作用',
      limit: 10,
      documentIds: [first.documentId],
    });
    assert.ok(scoped.length > 0);
    assert.ok(scoped.every((hit) => hit.documentId === first.documentId));
  } finally {
    await ctx.close();
  }
});

test('retrieval degrades to the lexical channel when vectors are missing', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('degraded.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    await ctx.dataSource.query('DELETE FROM chunk_embeddings');

    const hits = await ctx.retrieval.search({ query: '光合作用', limit: 3 });
    assert.ok(hits.length > 0, 'lexical recall must survive a missing vector index');
    assert.ok(hits.every((hit) => hit.score.vectorRank === undefined));
  } finally {
    await ctx.close();
  }
});

test('a query with no indexable term returns no lexical contribution', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('empty.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const hits = await ctx.retrieval.search({ query: '???', limit: 3 });
    assert.ok(hits.every((hit) => hit.score.lexicalRank === undefined));
  } finally {
    await ctx.close();
  }
});

/** Boots the same graph but with a scripted query expander standing in for the chat model. */
async function createAppWithExpander(expander) {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class ExpansionModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      DocumentsModule,
      EmbeddingModule,
    ],
    providers: [RetrievalService, { provide: QUERY_EXPANDER, useValue: expander }],
  })(ExpansionModule);

  const app = await NestFactory.createApplicationContext(ExpansionModule, { logger: false });
  createdApps.push(app);
  return {
    dataSource: app.get(DataSource),
    documents: app.get(DocumentsService),
    retrieval: app.get(RetrievalService),
    async close() {
      await app.close();
      const index = createdApps.indexOf(app);
      if (index >= 0) createdApps.splice(index, 1);
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

test('expanded terms recover a typo the literal query cannot find', async () => {
  const calls = [];
  const ctx = await createAppWithExpander({
    async expand(query) {
      calls.push(query);
      return { correctedQuery: '光合作用', keywords: ['叶绿体'] };
    },
  });
  const source = writeFixture(
    'typo.md',
    '# 光合作用\n\n光合作用是绿色植物在叶绿体中把光能转化为化学能的过程。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });

    // The literal query contains a typo and therefore no indexable bigram sequence.
    const before = await ctx.retrieval.search({ query: '光合做用', limit: 3, expand: false });
    assert.ok(
      before.every((hit) => hit.score.lexicalRank === undefined),
      'a typo query must not produce literal lexical hits',
    );

    // With expansion enabled the same query reaches the document through the corrected terms.
    const after = await ctx.retrieval.search({ query: '光合做用', limit: 3 });
    assert.ok(after.length > 0, 'expansion must recover the typo query');
    assert.ok(
      after.some((hit) => /光合作用/.test(hit.content)),
      'corrected terms must reach the right chunk',
    );
    assert.ok(
      after.some((hit) => hit.score.expandedRank !== undefined),
      'hits must be attributed to the expansion channel',
    );
    assert.deepEqual(calls, ['光合做用'], 'expansion runs exactly once for the weak query');
  } finally {
    await ctx.close();
  }
});

test('expansion is skipped when literal terms already deliver hits', async () => {
  let calls = 0;
  const ctx = await createAppWithExpander({
    async expand() {
      calls += 1;
      return { keywords: ['叶绿体'] };
    },
  });
  const source = writeFixture(
    'no-expansion.md',
    '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。\n\n## 光反应\n\n光反应发生在类囊体薄膜上。\n\n## 暗反应\n\n暗反应在基质中固定二氧化碳。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const hits = await ctx.retrieval.search({ query: '光合作用', limit: 3 });
    assert.ok(hits.length > 0);
    assert.equal(calls, 0, 'expansion must not run when lexical recall is already sufficient');
  } finally {
    await ctx.close();
  }
});

test('a failing expander never breaks retrieval', async () => {
  const ctx = await createAppWithExpander({
    async expand() {
      throw new Error('provider down');
    },
  });
  const source = writeFixture('degraded-expansion.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const hits = await ctx.retrieval.search({ query: '植物如何利用光能', limit: 3 });
    assert.ok(hits.length > 0, 'dense channel must still answer when expansion throws');
  } finally {
    await ctx.close();
  }
});
