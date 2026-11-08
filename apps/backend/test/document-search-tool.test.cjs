require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs');
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
const { createDocumentSearchTool, DOCUMENT_SEARCH_TOOL_NAME } = load('llm/tools/document-search-tool.js');

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-tool-'));
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

/** Boots documents + retrieval against a real SQLite file, migrations and the bundled model. */
async function createIntegrationApp() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class ToolModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      DocumentsModule,
      RetrievalModule,
    ],
  })(ToolModule);

  const app = await NestFactory.createApplicationContext(ToolModule, { logger: false });
  createdApps.push(app);
  const dataSource = app.get(DataSource);
  return {
    dataDirectory,
    dataSource,
    documents: app.get(DocumentsService),
    retrieval: app.get(RetrievalService),
    tool: createDocumentSearchTool(app.get(RetrievalService)),
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

/** Parses the tool's model-facing text payload into the returned array. */
function parseToolPayload(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('tool returns an array of chunk content with document metadata', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'teaching-note.md',
    '# 光合作用\n\n光合作用是绿色植物在叶绿体中把光能转化为化学能的过程。\n\n## 光反应\n\n光反应发生在类囊体薄膜上，产物是 ATP 与 NADPH。',
  );

  try {
    const ingested = await ctx.documents.ingestFile({ filePath: source, title: '生物讲义' });
    const items = parseToolPayload(await ctx.tool.execute('call-1', { query: '光合作用发生在哪里' }));

    assert.ok(Array.isArray(items), 'tool payload must be an array');
    assert.ok(items.length > 0 && items.length <= 5);
    const first = items[0];
    assert.equal(typeof first.content, 'string');
    assert.ok(first.content.length > 0);
    assert.equal(typeof first.document.name, 'string');
    assert.equal(first.document.name, 'teaching-note.md');
    assert.equal(first.document.title, '生物讲义');
    assert.equal(first.document.id, ingested.documentId);
    assert.equal(typeof first.document.path, 'string');
    // The path is relative to the data directory and must resolve to the stored copy.
    assert.ok(
      statSync(join(ctx.dataDirectory, first.document.path)).isFile(),
      `document path must resolve under the data directory: ${first.document.path}`,
    );
    assert.ok(Array.isArray(first.locator.headingPath));
    assert.equal(first.locator.pageStart, 1);
  } finally {
    await ctx.close();
  }
});

test('tool honours the limit parameter and reports the count in details', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'many.md',
    Array.from({ length: 6 }, (_, index) => `# 小节 ${index}\n\n光合作用相关段落 ${index}，说明叶绿体的作用。`).join('\n\n'),
  );

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const limited = await ctx.tool.execute('call-2', { query: '光合作用', limit: 2 });
    const items = parseToolPayload(limited);
    assert.ok(items.length <= 2);
    assert.equal(limited.details.count, items.length);

    const clamped = parseToolPayload(await ctx.tool.execute('call-3', { query: '光合作用', limit: 99 }));
    assert.ok(clamped.length <= 10);
  } finally {
    await ctx.close();
  }
});

test('tool returns an empty array when the knowledge base has no match', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('unrelated.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    const items = parseToolPayload(await ctx.tool.execute('call-4', { query: '量子纠缠' }));
    assert.deepEqual(items, []);
  } finally {
    await ctx.close();
  }
});

test('tool reports a failure instead of throwing when retrieval breaks', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('broken-index.md', '# 光合作用\n\n光合作用是植物把光能转为化学能的过程。');

  try {
    await ctx.documents.ingestFile({ filePath: source });
    // Removing the lexical index makes the SQL behind retrieval fail.
    await ctx.dataSource.query('DROP TABLE chunk_fts');

    const result = await ctx.tool.execute('call-5', { query: '光合作用' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /检索失败/);
    assert.equal(result.details.count, 0);
  } finally {
    await ctx.close();
  }
});

test('tool definition exposes the contract the model needs', () => {
  const tool = createDocumentSearchTool({ search: async () => [] });
  assert.equal(tool.name, DOCUMENT_SEARCH_TOOL_NAME);
  assert.equal(tool.name, 'search_documents');
  assert.ok(tool.description.includes('资料'));
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['limit', 'query']);
  assert.deepEqual(tool.parameters.required, ['query']);
});
