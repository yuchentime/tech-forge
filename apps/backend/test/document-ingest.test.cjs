require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

const { buildPdf, buildDocx } = require('./helpers/document-fixtures.cjs');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { DocumentsModule } = load('documents/documents.module.js');
const { DocumentsService } = load('documents/documents.service.js');
const { DocumentParserService } = load('platform/document-parser/document-parser.service.js');
const { chunkDocument, CHUNK_MAX_TOKENS } = load('documents/chunking/document-chunker.js');
const { getChunkTokenCounter } = load('documents/chunking/token-counter.js');
const { buildMatchQuery } = load('retrieval/text-normalizer.js');

/** Exact token counter used by ingest; also used by chunker assertions. */
const countTokens = getChunkTokenCounter().count;

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-ingest-src-'));
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
 * Boots the real module graph against a real SQLite file with the production migrations.
 *
 * Nothing is stubbed: the parser adapters, the TypeORM connection, migrations and the filesystem are
 * the same ones the application uses; only the data directory is a temp path.
 */
async function createIntegrationApp() {
  const dataDirectory = mkdtempSync(join(scratchRoot, 'data-'));
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class IntegrationModule {}
  Module({
    imports: [TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }), DocumentsModule],
  })(IntegrationModule);

  const app = await NestFactory.createApplicationContext(IntegrationModule, { logger: false });
  createdApps.push(app);
  const dataSource = app.get(DataSource);
  return {
    dataDirectory,
    dataSource,
    service: app.get(DocumentsService),
    parser: app.get(DocumentParserService),
    databaseFile: join(dataDirectory, 'teachforge.db'),
    async close() {
      await app.close();
      const index = createdApps.indexOf(app);
      if (index >= 0) createdApps.splice(index, 1);
      rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}

/** Creates a real file of the given name inside the scratch directory. */
function writeFixture(name, content) {
  const path = join(scratchRoot, name);
  writeFileSync(path, content);
  return path;
}

/** Runs a raw SQL query so assertions do not depend on the ORM mapping under test. */
async function rows(dataSource, sql, parameters = []) {
  return dataSource.query(sql, parameters);
}

test('ingest persists document, version and chunks and copies the source file', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'lesson.md',
    '# 光合作用\n\n光合作用是绿色植物利用光能的过程。\n\n## 光反应\n\n光反应发生在类囊体薄膜上，产物包括 ATP 与 NADPH。',
  );

  try {
    const result = await ctx.service.ingestFile({ filePath: source, isShared: true });
    assert.equal(result.status, 'ready');
    assert.equal(result.duplicate, false);
    assert.equal(result.versionNo, 1);
    assert.ok(result.chunkCount > 0);

    const documents = await rows(ctx.dataSource, 'SELECT * FROM documents');
    assert.equal(documents.length, 1);
    assert.equal(documents[0].title, 'lesson');
    assert.equal(documents[0].isShared, 1);

    const versions = await rows(ctx.dataSource, 'SELECT * FROM document_versions');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].processingStatus, 'ready');
    assert.equal(versions[0].processingError, null);
    assert.equal(versions[0].contentHash, createHash('sha256').update(readFileSync(source)).digest('hex'));

    const chunkRows = await rows(
      ctx.dataSource,
      'SELECT sequenceNo, content, locatorJson FROM document_chunks ORDER BY sequenceNo ASC',
    );
    assert.equal(chunkRows.length, result.chunkCount);
    chunkRows.forEach((row, index) => assert.equal(row.sequenceNo, index));

    // The stored file must be a byte-identical copy under the managed storage root.
    const copiedPath = join(ctx.dataDirectory, versions[0].workspaceRelativePath);
    assert.ok(statSync(copiedPath).isFile(), `missing copied file at ${copiedPath}`);
    assert.equal(readFileSync(copiedPath, 'utf8'), readFileSync(source, 'utf8'));

    // Offsets must slice back to the parser output, which is what a citation will rely on.
    const parsed = await ctx.parser.parse({ inputPath: source, originalName: 'lesson.md' });
    for (const row of chunkRows) {
      const locator = JSON.parse(row.locatorJson);
      assert.equal(row.content, parsed.text.slice(locator.charStart, locator.charEnd));
      assert.equal(locator.pageStart, 1);
      assert.ok(locator.tokenCount <= CHUNK_MAX_TOKENS);
      assert.equal(locator.tokenCount, countTokens(row.content));
    }
    assert.deepEqual(JSON.parse(chunkRows[0].locatorJson).headingPath, ['光合作用']);
  } finally {
    await ctx.close();
  }
});

test('ingest is idempotent for the same file content', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('repeat.md', '# 标题\n\n重复入库的内容。');

  try {
    const first = await ctx.service.ingestFile({ filePath: source });
    const second = await ctx.service.ingestFile({ filePath: source });

    assert.equal(second.duplicate, true);
    assert.equal(second.documentVersionId, first.documentVersionId);
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM documents')).length, 1);
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM document_versions')).length, 1);
    assert.equal(
      (await rows(ctx.dataSource, 'SELECT id FROM document_chunks')).length,
      first.chunkCount,
    );
  } finally {
    await ctx.close();
  }
});

test('ingest appends a new version to an existing document and keeps older chunks', async () => {
  const ctx = await createIntegrationApp();
  const firstSource = writeFixture('unit-v1.md', '# 第一版\n\n初始内容。');
  const secondSource = writeFixture('unit-v2.md', '# 第二版\n\n更新后的内容，长度更长一些以便产生分片。');

  try {
    const first = await ctx.service.ingestFile({ filePath: firstSource });
    const second = await ctx.service.ingestFile({
      filePath: secondSource,
      documentId: first.documentId,
    });

    assert.equal(second.documentId, first.documentId);
    assert.equal(second.versionNo, 2);
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM documents')).length, 1);

    const versions = await rows(
      ctx.dataSource,
      'SELECT versionNo, processingStatus FROM document_versions ORDER BY versionNo ASC',
    );
    assert.deepEqual(
      versions.map((version) => [version.versionNo, version.processingStatus]),
      [
        [1, 'ready'],
        [2, 'ready'],
      ],
    );

    const chunkCounts = await rows(
      ctx.dataSource,
      'SELECT documentVersionId, COUNT(*) AS total FROM document_chunks GROUP BY documentVersionId',
    );
    assert.equal(chunkCounts.length, 2, 'both versions must keep their own chunks');
    const detail = await ctx.service.getDocumentDetail(first.documentId);
    assert.equal(detail.versionCount, 2);
    assert.equal(detail.latest.versionNo, 2);
    assert.equal(detail.latest.chunkCount, second.chunkCount);
  } finally {
    await ctx.close();
  }
});

test('ingest records a failed parse without leaving chunks behind', async () => {
  const ctx = await createIntegrationApp();
  const broken = writeFixture('broken.pdf', '%PDF-1.4\nnot a real pdf body');

  try {
    await assert.rejects(() => ctx.service.ingestFile({ filePath: broken }));

    const versions = await rows(
      ctx.dataSource,
      'SELECT processingStatus, processingError FROM document_versions',
    );
    assert.equal(versions.length, 1);
    assert.equal(versions[0].processingStatus, 'failed');
    assert.match(versions[0].processingError, /PARSER_FAILED|NO_TEXT_LAYER|解析/);
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM document_chunks')).length, 0);
  } finally {
    await ctx.close();
  }
});

test('ingest rejects unsupported files before creating any rows', async () => {
  const ctx = await createIntegrationApp();
  const legacy = writeFixture('legacy.doc', 'binary');

  try {
    await assert.rejects(() => ctx.service.ingestFile({ filePath: legacy }));
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM documents')).length, 0);
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM document_versions')).length, 0);
    assert.equal((await rows(ctx.dataSource, 'SELECT id FROM document_chunks')).length, 0);
  } finally {
    await ctx.close();
  }
});

test('ingest handles a real DOCX file and keeps heading locators', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('lesson.docx', buildDocx());

  try {
    const result = await ctx.service.ingestFile({ filePath: source });
    assert.equal(result.status, 'ready');
    assert.ok(result.warnings.some((warning) => warning.code === 'UNSTRUCTURED_TABLE'));

    const chunkRows = await rows(
      ctx.dataSource,
      'SELECT content, locatorJson FROM document_chunks ORDER BY sequenceNo ASC',
    );
    const locators = chunkRows.map((row) => JSON.parse(row.locatorJson));
    assert.ok(locators.every((locator) => locator.headingPath.length > 0));
    assert.ok(locators.some((locator) => locator.headingPath.includes('第一章 光合作用')));
    assert.ok(chunkRows.some((row) => row.content.includes('## 重点提示')));
    // DOCX has no paging semantics, so no page numbers may be invented.
    assert.ok(locators.every((locator) => locator.pageStart === 1));
  } finally {
    await ctx.close();
  }
});

test('read models report document, version and chunk state', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture('read-model.md', '# 标题\n\n用于读取模型校验的内容。');

  try {
    const ingested = await ctx.service.ingestFile({ filePath: source, title: '自定义标题' });
    const list = await ctx.service.listDocuments();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '自定义标题');
    assert.equal(list[0].versionCount, 1);
    assert.equal(list[0].latest.versionNo, 1);
    assert.equal(list[0].latest.status, 'ready');
    assert.equal(list[0].latest.chunkCount, ingested.chunkCount);

    const detail = await ctx.service.getDocumentDetail(list[0].id);
    assert.equal(detail.id, list[0].id);
    assert.equal(detail.versions.length, 1);
    assert.equal(detail.versions[0].id, ingested.documentVersionId);

    const chunks = await ctx.service.listVersionChunks(ingested.documentVersionId);
    assert.equal(chunks.length, ingested.chunkCount);
    assert.deepEqual(
      chunks.map((chunk) => chunk.sequenceNo),
      chunks.map((_, index) => index),
    );

    assert.equal(await ctx.service.getDocumentDetail('missing-id'), null);
    await assert.rejects(
      () => ctx.service.ingestFile({ filePath: source, documentId: 'missing-id' }),
      /已经存在|不存在/,
    );
    assert.equal(existsSync(ctx.databaseFile), true);
  } finally {
    await ctx.close();
  }
});

test('lexical index makes Chinese and English words findable in the real database', async () => {
  const ctx = await createIntegrationApp();
  const source = writeFixture(
    'index.md',
    '# 光合作用\n\n光合作用是绿色植物利用光能的过程。\n\n## 英文术语\n\nStrategies for teaching photosynthesis in class.',
  );

  try {
    const ingested = await ctx.service.ingestFile({ filePath: source });

    const termRows = await rows(ctx.dataSource, 'SELECT chunkId, heading, body FROM chunk_search_terms');
    assert.equal(termRows.length, ingested.chunkCount, 'every chunk needs one term row');

    const search = async (query) => {
      const match = buildMatchQuery(query);
      assert.ok(match, `query must normalise to a MATCH expression: ${query}`);
      return rows(
        ctx.dataSource,
        `SELECT t.chunkId AS chunkId, bm25(chunk_fts, 5.0, 1.0) AS score
           FROM chunk_fts JOIN chunk_search_terms t ON t.rowid = chunk_fts.rowid
          WHERE chunk_fts MATCH ? ORDER BY score`,
        [match],
      );
    };

    // Four-character Chinese word, a two-character prefix, and an English stem.
    for (const query of ['光合作用', '光合', 'strategy']) {
      const hits = await search(query);
      assert.ok(hits.length > 0, `no lexical hit for ${query}`);
      assert.ok(
        hits.every((hit) => typeof hit.chunkId === 'string'),
        'hits must join back to chunk ids',
      );
    }

    // A term that exists in no chunk must return nothing rather than everything.
    assert.equal((await search('量子纠缠')).length, 0);

    // The FTS mirror is maintained by triggers: deleting the source row removes the hit.
    const firstChunk = termRows[0].chunkId;
    await rows(ctx.dataSource, 'DELETE FROM chunk_search_terms WHERE chunkId = ?', [firstChunk]);
    const afterDelete = await rows(
      ctx.dataSource,
      'SELECT t.chunkId AS chunkId FROM chunk_fts JOIN chunk_search_terms t ON t.rowid = chunk_fts.rowid WHERE chunk_fts MATCH ?',
      [buildMatchQuery('光合作用')],
    );
    assert.ok(afterDelete.every((hit) => hit.chunkId !== firstChunk));
  } finally {
    await ctx.close();
  }
});

test('chunker keeps heading trails and offsets that slice back to the source text', () => {
  const filler = '这是一段用于填充长度的正文，描述光合作用与光反应。'.repeat(20);
  const pages = [
    {
      pageNo: 1,
      text: `# 第一章 光合作用\n\n${filler}\n\n## 第一节 光反应\n\n${filler}`,
    },
  ];
  const chunks = chunkDocument({ pages, countTokens });
  const text = pages.map((page) => page.text).join('\n\n');

  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.equal(chunk.content, text.slice(chunk.locator.charStart, chunk.locator.charEnd));
    // Budget is measured in tokens, not characters.
    assert.ok(
      chunk.locator.tokenCount <= CHUNK_MAX_TOKENS,
      `chunk ${chunk.sequenceNo} has ${chunk.locator.tokenCount} tokens`,
    );
    assert.equal(chunk.locator.tokenCount, countTokens(chunk.content));
  }
  assert.deepEqual(chunks[0].locator.headingPath, ['第一章 光合作用']);
});

test('chunker splits an oversized paragraph and skips table-of-contents pages', () => {
  const longParagraph = '光合作用把光能转化为化学能。'.repeat(200);
  const pages = [
    { pageNo: 1, text: '1.1 引言 . . . . . . . . 3\n\n1.2 方法 . . . . . . . . 7' },
    { pageNo: 2, text: longParagraph },
  ];
  const chunks = chunkDocument({
    countTokens,
    pages,
    warnings: [{ code: 'TOC_LIKE', message: '目录页', pageNo: 1 }],
  });
  const text = pages.map((page) => page.text).join('\n\n');

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.locator.pageStart === 2));
  for (const chunk of chunks) {
    assert.ok(chunk.locator.tokenCount <= CHUNK_MAX_TOKENS);
    assert.equal(chunk.locator.tokenCount, countTokens(chunk.content));
    assert.equal(chunk.content, text.slice(chunk.locator.charStart, chunk.locator.charEnd));
  }
});

test('binary formats reject a mismatched extension inside the real pipeline', async () => {
  const ctx = await createIntegrationApp();
  const disguised = writeFixture('disguised.docx', buildPdf([[{ x: 50, y: 780, text: 'x' }]]));

  try {
    await assert.rejects(() => ctx.service.ingestFile({ filePath: disguised }));
    const versions = await rows(
      ctx.dataSource,
      'SELECT processingStatus, processingError FROM document_versions',
    );
    assert.equal(versions.length, 1);
    assert.equal(versions[0].processingStatus, 'failed');
    assert.match(versions[0].processingError, /UNSUPPORTED_FORMAT|不匹配/);
  } finally {
    await ctx.close();
  }
});
