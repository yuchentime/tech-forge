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
const { KnowledgeModule } = load('knowledge/knowledge.module.js');
const { KnowledgeService, KNOWLEDGE_CHUNK_LIMIT } = load('knowledge/knowledge.service.js');
const { ConversationsModule } = load('conversations/conversations.module.js');
const { ConversationsService } = load('conversations/conversations.service.js');
const { parseKnowledgeCommand } = load('knowledge/knowledge-command.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-knowledge-'));
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

/** Boots documents + retrieval + knowledge against a real SQLite file and the bundled model. */
async function createIntegrationApp() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  const configDirectory = mkdtempSync(join(scratchRoot, 'config-'));
  const workspacePath = join(configDirectory, 'workspace');
  // Isolate settings and the Agent workspace: a run must never read or move the developer's
  // real ~/.tech-forge files.
  writeFileSync(
    join(configDirectory, 'config.toml'),
    `[workspace]\npath = ${JSON.stringify(workspacePath)}\n`,
    'utf8',
  );
  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class KnowledgeTestModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      DocumentsModule,
      RetrievalModule,
      KnowledgeModule,
      ConversationsModule,
    ],
  })(KnowledgeTestModule);

  const app = await NestFactory.createApplicationContext(KnowledgeTestModule, { logger: false });
  createdApps.push(app);
  return {
    dataDirectory,
    dataSource: app.get(DataSource),
    conversations: app.get(ConversationsService),
    documents: app.get(DocumentsService),
    retrieval: app.get(RetrievalService),
    /** Knowledge service with the real dependencies; `reranker` replaces only the ranking step. */
    knowledgeWith(reranker) {
      if (!reranker) return app.get(KnowledgeService);
      return new KnowledgeService(
        app.get(DocumentsService),
        app.get(RetrievalService),
        reranker,
      );
    },
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

test('command parsing keeps non-command prompts untouched', () => {
  assert.deepEqual(parseKnowledgeCommand('普通问题'), { force: false, prompt: '普通问题' });
  // A longer word that merely starts with the command must not be swallowed.
  assert.deepEqual(parseKnowledgeCommand('/知识库化 是什么'), {
    force: false,
    prompt: '/知识库化 是什么',
  });
  // A bare command has nothing to search for and must stay literal text.
  assert.deepEqual(parseKnowledgeCommand('/知识库'), { force: false, prompt: '/知识库' });
  assert.deepEqual(parseKnowledgeCommand('/知识库   '), { force: false, prompt: '/知识库   ' });
  assert.deepEqual(parseKnowledgeCommand('/知识库 什么是光合作用'), {
    force: true,
    prompt: '什么是光合作用',
  });
  assert.deepEqual(parseKnowledgeCommand('  /知识库\n光合作用在哪里发生'), {
    force: true,
    prompt: '光合作用在哪里发生',
  });

  // The composer menu inserts this exact string (with a trailing space); aliases stay valid.
  assert.deepEqual(parseKnowledgeCommand('/查询知识库 帮我找下关于抄袭的定义'), {
    force: true,
    prompt: '帮我找下关于抄袭的定义',
  });
  assert.deepEqual(parseKnowledgeCommand('/查询资料库 '), { force: false, prompt: '/查询资料库 ' });
  assert.deepEqual(parseKnowledgeCommand('/查询资料库  如何界定抄袭'), {
    force: true,
    prompt: '如何界定抄袭',
  });
  assert.deepEqual(parseKnowledgeCommand('/查询资料库'), { force: false, prompt: '/查询资料库' });
  assert.deepEqual(parseKnowledgeCommand('/查询资料库化 是什么'), {
    force: false,
    prompt: '/查询资料库化 是什么',
  });

  // Earlier spellings keep working so old conversations and habits are not broken.
  assert.deepEqual(parseKnowledgeCommand('/查询知识库 什么是光合作用'), {
    force: true,
    prompt: '什么是光合作用',
  });
});

test('the context carries ranked chunks with citation anchors', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'photosynthesis.md',
    '# 光合作用\n\n光合作用是绿色植物在叶绿体中把光能转化为化学能的过程。\n\n' +
      '## 光反应\n\n光反应发生在类囊体薄膜上，产物是 ATP 与 NADPH。\n\n' +
      '## 暗反应\n\n暗反应在叶绿体基质中进行，固定二氧化碳并生成糖类。',
  );

  try {
    const ingested = await ctx.documents.ingestFile({ filePath: source, title: '生物讲义' });
    const context = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-1',
      query: '光合作用发生在哪里',
      loadedChunkIds: [],
    });

    assert.equal(context.outcome, 'injected');
    assert.ok(context.refs.length > 0);
    assert.ok(context.refs.length <= KNOWLEDGE_CHUNK_LIMIT);
    assert.equal(context.refs[0].documentId, ingested.documentId);
    assert.equal(typeof context.refs[0].chunkId, 'string');
    assert.equal(context.refs[0].title, '生物讲义');
    // Every chunk must be renderable with document, heading and page so the answer can cite it.
    assert.match(context.text, /### 片段 1（资料：生物讲义/);
    assert.match(context.text, /页码：1/);
    assert.match(context.text, /光合作用|光反应|暗反应/);
    assert.equal(context.stats.injectedChunks, context.refs.length);
    assert.ok(context.stats.injectedTokens > 0);
  } finally {
    await ctx.close();
  }
});

test('the chunk count is capped and every chunk id exists in the index', async () => {
  const ctx = await createIntegrationApp();
  // Long enough to produce more chunks than the cap (500 tokens per chunk).
  const source = writeFixture(
    'many.md',
    Array.from(
      { length: 60 },
      (_, index) =>
        `## 小节 ${index}\n\n光合作用相关段落 ${index}。叶绿体中的类囊体薄膜上分布着光合色素，` +
        `光反应在此处把光能转化为 ATP 与 NADPH 中的化学能；暗反应在叶绿体基质中进行，` +
        `通过固定二氧化碳生成糖类，并把 ATP 与 NADPH 中的能量转移到有机物中。`,
    ).join('\n\n'),
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const context = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-cap',
      query: '光合作用',
      loadedChunkIds: [],
    });

    assert.equal(context.outcome, 'injected');
    assert.equal(context.refs.length, KNOWLEDGE_CHUNK_LIMIT);
    const rows = await ctx.dataSource.query(
      'SELECT id FROM document_chunks WHERE id IN (' +
        context.refs.map(() => '?').join(', ') +
        ')',
      context.refs.map((ref) => ref.chunkId),
    );
    assert.equal(rows.length, context.refs.length);
  } finally {
    await ctx.close();
  }
});

test('a turn whose chunks are already in history injects nothing', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'reuse.md',
    '# 光合作用\n\n光合作用是植物把光能转化为化学能的过程，发生在叶绿体类囊体薄膜上。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const first = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-2',
      query: '光合作用',
      loadedChunkIds: [],
    });
    const refsJson = ctx.knowledgeWith().toContextRefsJson(first, '光合作用');
    assert.equal(typeof refsJson, 'string');

    const loadedChunkIds = JSON.parse(refsJson).knowledge.chunks.map((entry) => entry.chunkId);
    const second = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-2',
      query: '光合作用',
      loadedChunkIds,
    });

    assert.equal(second.outcome, 'already_loaded');
    assert.equal(second.refs.length, 0);
    assert.ok(second.stats.skippedAlreadyLoaded >= 1);
    assert.match(second.text, /已经在本次对话/);
  } finally {
    await ctx.close();
  }
});

test('an unrelated question reports no hits instead of guessing', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('unrelated.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const context = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-3',
      query: '量子纠缠的贝尔不等式',
      loadedChunkIds: [],
    });
    assert.equal(context.outcome, 'no_hits');
    assert.equal(context.refs.length, 0);
    assert.match(context.text, /没有找到/);
  } finally {
    await ctx.close();
  }
});

test('an empty library reports an empty scope', async () => {
  const ctx = await createIntegrationApp();
  try {
    const context = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-4',
      query: '光合作用',
      loadedChunkIds: [],
    });
    assert.equal(context.outcome, 'no_scope');
    assert.equal(context.refs.length, 0);
  } finally {
    await ctx.close();
  }
});

test('the reranker decides the order and is reported in stats', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'rerank.md',
    Array.from(
      { length: 30 },
      (_, index) =>
        `## 小节 ${index}\n\n光合作用相关段落 ${index}。叶绿体中的类囊体薄膜上分布着光合色素，` +
        `光反应在此处把光能转化为 ATP 与 NADPH 中的化学能；暗反应在叶绿体基质中进行。`,
    ).join('\n\n'),
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const baseline = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-rerank',
      query: '光合作用',
      loadedChunkIds: [],
    });
    assert.ok(baseline.refs.length > 1);

    // Reverse the fusion order: the injected order must follow the reranker, not RRF.
    const knowledge = ctx.knowledgeWith({
      async rank(_query, candidates) {
        return candidates.map((candidate) => candidate.chunkId).reverse();
      },
    });
    const reranked = await knowledge.buildContext({
      conversationId: 'conversation-rerank',
      query: '光合作用',
      loadedChunkIds: [],
    });

    assert.equal(reranked.stats.reranked, true);
    assert.notEqual(reranked.refs[0].chunkId, baseline.refs[0].chunkId);
    const expected = baseline.refs.map((ref) => ref.chunkId).reverse().slice(0, KNOWLEDGE_CHUNK_LIMIT);
    assert.deepEqual(
      reranked.refs.map((ref) => ref.chunkId),
      expected,
    );
  } finally {
    await ctx.close();
  }
});

test('a failing reranker falls back to the fusion order', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('rerank-fail.md', '# 光合作用\n\n光合作用发生在类囊体薄膜上。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const knowledge = ctx.knowledgeWith({
      async rank() {
        throw new Error('provider down');
      },
    });
    const context = await knowledge.buildContext({
      conversationId: 'conversation-rerank-fail',
      query: '光合作用',
      loadedChunkIds: [],
    });
    assert.equal(context.outcome, 'injected');
    assert.equal(context.stats.reranked, false);
    assert.ok(context.refs.length > 0);
  } finally {
    await ctx.close();
  }
});

test('an explicit conversation scope overrides the default range', async () => {
  const ctx = await createIntegrationApp();
  const shared = writeFixture('shared.md', '# 光合作用\n\n光合作用发生在叶绿体类囊体薄膜上。');
  const privateDoc = writeFixture('private.md', '# 电磁学\n\n麦克斯韦方程组描述电场与磁场的耦合。');

  try {
    const sharedIngest = await ctx.documents.ingestFile({ filePath: shared, isShared: true });
    const privateIngest = await ctx.documents.ingestFile({ filePath: privateDoc });

    // Default range: the shared document is reachable.
    const before = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-scope',
      query: '光合作用发生在哪里',
      loadedChunkIds: [],
    });
    assert.equal(before.outcome, 'injected');
    assert.equal(before.refs[0].documentId, sharedIngest.documentId);

    // Pinning one document must exclude the shared one, not merely add to it.
    const pinned = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-scope',
      query: '光合作用发生在哪里',
      loadedChunkIds: [],
      explicitDocumentIds: [privateIngest.documentId],
    });
    assert.equal(pinned.outcome, 'no_hits');
    assert.equal(pinned.refs.length, 0);
    assert.equal(pinned.stats.scopeDocuments, 1);

    // The pinned document itself must still be searchable.
    const inScope = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-scope',
      query: '麦克斯韦方程组的含义',
      loadedChunkIds: [],
      explicitDocumentIds: [privateIngest.documentId],
    });
    assert.equal(inScope.outcome, 'injected');
    assert.equal(inScope.refs[0].documentId, privateIngest.documentId);
  } finally {
    await ctx.close();
  }
});

test('the conversation scope survives a reload and clears back to the default', async () => {
  const ctx = await createIntegrationApp();
  const conversationId = 'conversation-metadata';
  const documentId = '00000000-0000-4000-8000-000000000001';

  try {
    await ctx.conversations.beginTurn(conversationId, '开始', true);
    assert.deepEqual(await ctx.conversations.getKnowledgeScope(conversationId), {
      documentIds: [],
    });

    await ctx.conversations.setKnowledgeScope(conversationId, [documentId, documentId]);
    // A fresh read must come from SQLite, not from memory.
    assert.deepEqual(await ctx.conversations.getKnowledgeScope(conversationId), {
      documentIds: [documentId],
    });

    const rows = await ctx.dataSource.query(
      'SELECT metadataJson FROM conversations WHERE id = ?',
      [conversationId],
    );
    const metadata = JSON.parse(rows[0].metadataJson);
    assert.deepEqual(metadata.knowledge.documentIds, [documentId]);
    assert.equal(typeof metadata.knowledge.updatedAt, 'string');

    // An empty list restores the default range instead of searching nothing.
    await ctx.conversations.setKnowledgeScope(conversationId, []);
    assert.deepEqual(await ctx.conversations.getKnowledgeScope(conversationId), {
      documentIds: [],
    });
    const cleared = await ctx.dataSource.query(
      'SELECT metadataJson FROM conversations WHERE id = ?',
      [conversationId],
    );
    assert.equal(cleared[0].metadataJson, null);
  } finally {
    await ctx.close();
  }
});

test('a document named by the question still reaches the context', async () => {
  const ctx = await createIntegrationApp();
  const handbook = writeFixture(
    'handbook-large.md',
    Array.from(
      { length: 400 },
      (_, index) => `## 条款 ${index}\n\n本条款说明主要要求与挑战，学生需要了解什么可以做。`,
    ).join('\n\n'),
  );
  const paper = writeFixture(
    'EDMA-paper.md',
    '# EDMA\n\n环境分割多址的可行性结论是：在给定天线增益下可达到目标容量。',
  );

  try {
    await ctx.documents.ingestFile({ filePath: handbook, isShared: true });
    await ctx.documents.ingestFile({ filePath: paper, isShared: true });

    const context = await ctx.knowledgeWith().buildContext({
      conversationId: 'conversation-routing',
      query: '环境分割多址 EDMA 的可行性结论是什么',
      loadedChunkIds: [],
    });

    assert.equal(context.outcome, 'injected');
    assert.ok(
      context.refs.some((ref) => ref.title === 'EDMA-paper'),
      'the paper named by the question must be injected',
    );
  } finally {
    await ctx.close();
  }
});
