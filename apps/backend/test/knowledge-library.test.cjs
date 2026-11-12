require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { DataSource } = require('typeorm');

const { buildPdf } = require('./helpers/document-fixtures.cjs');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { DocumentsModule } = load('documents/documents.module.js');

/** Token the local backend requires on every request; mirrors `main.ts`. */
const LOCAL_TOKEN = 'knowledge-library-test-token';

const scratchRoot = mkdtempSync(join(tmpdir(), 'teachforge-library-'));
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
 * Boots the real Nest module graph with Fastify, real SQLite migrations and a temp filesystem.
 *
 * `TEACHFORGE_CONFIG_DIR` points at a scratch config directory whose `config.toml` names the
 * workspace, so the assertions prove the config directory (not the workspace) owns the retained
 * knowledge copies.
 */
async function createServer(options = {}) {
  const root = mkdtempSync(join(scratchRoot, 'app-'));
  const configDirectory = join(root, 'config');
  const workspacePath = join(root, 'workspace');
  const dataDirectory = join(root, 'data');
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(
    join(configDirectory, 'config.toml'),
    `[workspace]\npath = ${JSON.stringify(workspacePath)}\n`,
    'utf8',
  );

  // A pre-2026-11-09 install kept the retained copies inside the Agent workspace.
  if (options.legacyKnowledgeCopy) {
    const legacyDirectory = join(workspacePath, 'knowledge', 'legacy-document-id');
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, 'legacy.md'), '# 旧位置资料\n', 'utf8');
  }

  process.env.TEACHFORGE_CONFIG_DIR = configDirectory;
  process.env.TEACHFORGE_DATA_DIR = dataDirectory;

  class IntegrationModule {}
  Module({
    imports: [
      TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
      DocumentsModule,
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
    if (request.headers['x-teachforge-token'] !== LOCAL_TOKEN) {
      reply.code(401).send({ statusCode: 401, message: 'Unauthorized.' });
    }
  });

  await app.listen(0, '127.0.0.1');
  createdApps.push(app);
  const address = app.getHttpServer().address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    configDirectory,
    workspacePath,
    dataDirectory,
    dataSource: app.get(DataSource),
    async close() {
      await app.close();
      const index = createdApps.indexOf(app);
      if (index >= 0) createdApps.splice(index, 1);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Calls one authenticated JSON endpoint and decodes whatever body came back. */
async function api(ctx, method, path, body) {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      'x-teachforge-token': LOCAL_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Runs raw SQL so assertions do not depend on the ORM mapping under test. */
async function rows(ctx, sql, parameters = []) {
  return ctx.dataSource.query(sql, parameters);
}

/** Collects every row count that the knowledge library promises to clear on deletion. */
async function countDerivedRows(ctx, documentId) {
  const [documents, versions, chunks, terms, embeddings, links] = await Promise.all([
    rows(ctx, 'SELECT COUNT(*) AS total FROM documents WHERE id = ?', [documentId]),
    rows(ctx, 'SELECT COUNT(*) AS total FROM document_versions WHERE documentId = ?', [documentId]),
    rows(
      ctx,
      `SELECT COUNT(*) AS total FROM document_chunks WHERE documentVersionId IN
         (SELECT id FROM document_versions WHERE documentId = ?)`,
      [documentId],
    ),
    rows(
      ctx,
      `SELECT COUNT(*) AS total FROM chunk_search_terms WHERE chunkId IN
         (SELECT id FROM document_chunks WHERE documentVersionId IN
           (SELECT id FROM document_versions WHERE documentId = ?))`,
      [documentId],
    ),
    rows(ctx, 'SELECT COUNT(*) AS total FROM chunk_embeddings WHERE documentId = ?', [documentId]),
    rows(ctx, 'SELECT COUNT(*) AS total FROM conversation_documents WHERE documentId = ?', [
      documentId,
    ]),
  ]);
  return {
    documents: Number(documents[0].total),
    versions: Number(versions[0].total),
    chunks: Number(chunks[0].total),
    terms: Number(terms[0].total),
    embeddings: Number(embeddings[0].total),
    links: Number(links[0].total),
  };
}

/** Writes one source file outside the workspace, as the native picker would return it. */
function writeSource(name, content) {
  const directory = mkdtempSync(join(scratchRoot, 'source-'));
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

test('boots with an empty catalog so a session can always read knowledge/index.md', async () => {
  const ctx = await createServer();

  try {
    const catalogPath = join(ctx.configDirectory, 'knowledge', 'index.md');
    assert.equal(existsSync(catalogPath), true);
    const catalog = readFileSync(catalogPath, 'utf8');
    assert.match(catalog, /^## 资料目录/);
    assert.match(catalog, /资料库当前为空/);
  } finally {
    await ctx.close();
  }
});

test('importing a picked file copies it into the app knowledge directory and indexes it', async () => {
  const ctx = await createServer();
  const source = writeSource(
    'photosynthesis.md',
    '# Photosynthesis\n\nphotosynthesis converts light energy into chemical energy in chloroplasts.',
  );

  try {
    const response = await api(ctx, 'POST', '/api/documents/import', { filePath: source });
    assert.equal(response.status, 200);
    assert.equal(response.data.duplicate, false);
    assert.equal(response.data.status, 'ready');
    assert.ok(response.data.chunkCount > 0);

    const expectedCopy = join(
      ctx.configDirectory,
      'knowledge',
      response.data.documentId,
      'photosynthesis.md',
    );
    assert.equal(response.data.storedPath, expectedCopy);
    assert.equal(existsSync(expectedCopy), true);
    assert.equal(readFileSync(expectedCopy, 'utf8'), readFileSync(source, 'utf8'));

    const storedCopy = join(
      ctx.dataDirectory,
      'documents',
      response.data.documentId,
      'v1',
      'photosynthesis.md',
    );
    assert.equal(existsSync(storedCopy), true);
    assert.deepEqual(readdirSync(join(ctx.configDirectory, 'knowledge', '.importing')), []);
    assert.match(
      readFileSync(join(ctx.configDirectory, 'knowledge', 'index.md'), 'utf8'),
      /title: photosynthesis/,
    );

    const documents = await rows(ctx, 'SELECT * FROM documents');
    assert.equal(documents.length, 1);
    assert.equal(documents[0].isShared, 1);
    assert.equal(documents[0].title, 'photosynthesis');

    const versions = await rows(ctx, 'SELECT * FROM document_versions');
    assert.equal(versions[0].processingStatus, 'ready');

    const list = await api(ctx, 'GET', '/api/documents');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, response.data.documentId);
    assert.equal(list.data[0].latest.originalName, 'photosynthesis.md');
    assert.equal(list.data[0].latest.chunkCount, response.data.chunkCount);
    assert.equal(list.data[0].latest.byteSize, readFileSync(source).length);
    assert.equal(typeof list.data[0].latest.createdAt, 'string');

    const fts = await rows(
      ctx,
      `SELECT COUNT(*) AS total FROM chunk_fts WHERE chunk_fts MATCH 'photosynthesis'`,
    );
    assert.ok(Number(fts[0].total) > 0);
  } finally {
    await ctx.close();
  }
});

test('importing the same bytes again reports a duplicate without copying anything', async () => {
  const ctx = await createServer();
  const source = writeSource('duplicate.md', '# 重复导入\n\n同一份内容只应入库一次。');

  try {
    const first = await api(ctx, 'POST', '/api/documents/import', { filePath: source });
    assert.equal(first.status, 200);
    assert.equal(first.data.duplicate, false);

    const second = await api(ctx, 'POST', '/api/documents/import', { filePath: source });
    assert.equal(second.status, 200);
    assert.equal(second.data.duplicate, true);
    assert.equal(second.data.documentId, first.data.documentId);
    assert.equal(second.data.storedPath, null);

    assert.equal((await rows(ctx, 'SELECT id FROM documents')).length, 1);
    assert.deepEqual(readdirSync(join(ctx.configDirectory, 'knowledge', '.importing')), []);
  } finally {
    await ctx.close();
  }
});

test('importing rejects unsupported types and malformed paths before writing anything', async () => {
  const ctx = await createServer();
  const sheet = writeSource('grades.xlsx', 'binary');

  try {
    const unsupported = await api(ctx, 'POST', '/api/documents/import', { filePath: sheet });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.data.code, 'UNSUPPORTED_FILE_TYPE');
    assert.match(unsupported.data.message, /暂时不能导入/);
    assert.match(unsupported.data.message, /PDF、Word/);

    const relative = await api(ctx, 'POST', '/api/documents/import', { filePath: 'grades.md' });
    assert.equal(relative.status, 400);
    assert.match(relative.data.message, /文件地址不完整/);

    const missing = await api(ctx, 'POST', '/api/documents/import', {
      filePath: join(scratchRoot, 'does-not-exist.md'),
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, 'SOURCE_UNREADABLE');
    assert.match(missing.data.message, /无法读取所选文件/);
    // The user-facing copy must not leak raw filesystem errors.
    assert.doesNotMatch(missing.data.message, /ENOENT|no such file/i);
    assert.match(missing.data.detail, /ENOENT/);

    const extraField = await api(ctx, 'POST', '/api/documents/import', { filePath: sheet, x: 1 });
    assert.equal(extraField.status, 400);

    assert.equal((await rows(ctx, 'SELECT id FROM documents')).length, 0);
    assert.equal((await rows(ctx, 'SELECT id FROM document_versions')).length, 0);
    assert.equal(existsSync(join(ctx.configDirectory, 'knowledge')), false);
  } finally {
    await ctx.close();
  }
});

test('a PDF without a text layer fails the import and leaves a failed version', async () => {
  const ctx = await createServer();
  const scanned = writeSource('scan.pdf', buildPdf([[]]));

  try {
    const response = await api(ctx, 'POST', '/api/documents/import', { filePath: scanned });
    assert.equal(response.status, 422);
    assert.equal(response.data.code, 'NO_TEXT_LAYER');
    assert.match(response.data.message, /没有可以读取的文字/);
    assert.match(response.data.message, /Word|Markdown/);
    // The technical code stays in the detail field, not in the primary message.
    assert.doesNotMatch(response.data.message, /NO_TEXT_LAYER/);
    assert.match(response.data.detail, /NO_TEXT_LAYER/);

    const versions = await rows(ctx, 'SELECT * FROM document_versions');
    assert.equal(versions.length, 1);
    assert.equal(versions[0].processingStatus, 'failed');
    assert.match(versions[0].processingError, /NO_TEXT_LAYER|PARSER_FAILED/);
    assert.equal((await rows(ctx, 'SELECT id FROM document_chunks')).length, 0);
    assert.deepEqual(readdirSync(join(ctx.configDirectory, 'knowledge', '.importing')), []);

    const list = await api(ctx, 'GET', '/api/documents');
    assert.equal(list.data[0].latest.status, 'failed');

    // Retrying the same bytes hits the content-hash shortcut; the caller must still see the failure.
    const retried = await api(ctx, 'POST', '/api/documents/import', { filePath: scanned });
    assert.equal(retried.status, 200);
    assert.equal(retried.data.duplicate, true);
    assert.equal(retried.data.status, 'failed');
    assert.equal(retried.data.storedPath, null);
  } finally {
    await ctx.close();
  }
});

test('deleting a document clears every derived row, the FTS index and both file copies', async () => {
  const ctx = await createServer();
  const source = writeSource(
    'deletable.md',
    '# 删除验证\n\nphotosynthesis material that must disappear from the lexical index.',
  );

  try {
    const imported = await api(ctx, 'POST', '/api/documents/import', { filePath: source });
    const documentId = imported.data.documentId;
    assert.equal(imported.status, 200);

    const before = await countDerivedRows(ctx, documentId);
    assert.ok(before.chunks > 0 && before.terms > 0 && before.embeddings > 0);

    const deleted = await api(ctx, 'DELETE', `/api/documents/${documentId}`);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { documentId, fileCleanup: 'complete' });

    assert.deepEqual(await countDerivedRows(ctx, documentId), {
      documents: 0,
      versions: 0,
      chunks: 0,
      terms: 0,
      embeddings: 0,
      links: 0,
    });
    const fts = await rows(
      ctx,
      `SELECT COUNT(*) AS total FROM chunk_fts WHERE chunk_fts MATCH 'photosynthesis'`,
    );
    assert.equal(Number(fts[0].total), 0);

    assert.equal(existsSync(join(ctx.configDirectory, 'knowledge', documentId)), false);
    assert.equal(existsSync(join(ctx.dataDirectory, 'documents', documentId)), false);

    const list = await api(ctx, 'GET', '/api/documents');
    assert.deepEqual(list.data, []);

    const again = await api(ctx, 'DELETE', `/api/documents/${documentId}`);
    assert.equal(again.status, 404);

    const malformed = await api(ctx, 'DELETE', '/api/documents/not-a-uuid');
    assert.equal(malformed.status, 404);
    assert.match(malformed.data.message, /没有找到这份资料/);
  } finally {
    await ctx.close();
  }
});

test('deleting a document that is still processing is refused', async () => {
  const ctx = await createServer();
  const source = writeSource('processing.md', '# 处理中\n\n仍在解析的资料不能被删除。');

  try {
    const imported = await api(ctx, 'POST', '/api/documents/import', { filePath: source });
    const documentId = imported.data.documentId;
    await rows(ctx, `UPDATE document_versions SET processingStatus = 'chunking' WHERE documentId = ?`, [
      documentId,
    ]);

    const refused = await api(ctx, 'DELETE', `/api/documents/${documentId}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, 'DOCUMENT_PROCESSING');
    assert.match(refused.data.message, /还在处理中/);
    assert.equal((await rows(ctx, 'SELECT id FROM documents')).length, 1);
    assert.equal(existsSync(join(ctx.configDirectory, 'knowledge', documentId)), true);
  } finally {
    await ctx.close();
  }
});

test('moves a legacy workspace knowledge copy out of the Agent workspace on boot', async () => {
  const ctx = await createServer({ legacyKnowledgeCopy: true });
  try {
    const migrated = join(ctx.configDirectory, 'knowledge', 'legacy-document-id', 'legacy.md');
    assert.equal(existsSync(migrated), true);
    assert.equal(existsSync(join(ctx.workspacePath, 'knowledge')), false);
  } finally {
    await ctx.close();
  }
});
