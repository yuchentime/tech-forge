const assert = require('node:assert/strict');
const test = require('node:test');
const { join, resolve } = require('node:path');

const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { renderCatalogIndex } = require(join(buildDirectory, 'documents/document-catalog.service.js'));
const { KnowledgeDirectoryService } = require(join(buildDirectory, 'documents/knowledge-directory.service.js'));

test('renders an explicit body for an empty library', () => {
  const text = renderCatalogIndex([]);
  assert.match(text, /^## 资料目录/);
  assert.match(text, /资料库当前为空/);
});

test('renders catalog entries as records instead of splitting a string into characters', () => {
  const text = renderCatalogIndex([{
    document: { id: 'document-id', title: '示例资料' },
    version: {
      versionNo: 1,
      workspaceRelativePath: 'documents/document-id/v1/notes.txt',
      catalogDocumentType: '课程资料',
      catalogKeywordsJson: '["示例", "目录", "文本"]',
      catalogSummary: '用于验证目录格式。',
      catalogedAt: new Date('2026-11-10T00:00:00.000Z'),
      updatedAt: new Date('2026-11-10T00:00:00.000Z'),
    },
  }]);
  assert.match(text, /- id: document-id\n  version: 1/);
  assert.doesNotMatch(text, /-\n\s*i\n\s*d\n\s*:/);
});

test('renders a non-empty catalog instead of reporting an empty one', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'teachforge-catalog-'));
  const catalogPath = join(directory, 'index.md');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = new KnowledgeDirectoryService({
    getKnowledgeCatalogPath: () => catalogPath,
    getKnowledgeDirectory: () => directory,
  });

  writeFileSync(catalogPath, renderCatalogIndex([]), 'utf8');
  const empty = service.renderLoadedContext(await service.loadForAgent());
  assert.match(empty, /资料目录/);
  assert.ok(empty.includes(`<root_path>${directory}</root_path>`));
  assert.doesNotMatch(empty, /目录为空/);

  writeFileSync(catalogPath, '## 资料目录\n\n- id: document-id\n', 'utf8');
  const loaded = service.renderLoadedContext(await service.loadForAgent());
  assert.match(loaded, /id: document-id/);
  assert.ok(loaded.includes(`<root_path>${directory}</root_path>`));
  assert.match(loaded, /相对 root_path/);
  assert.doesNotMatch(loaded, /目录为空/);

  writeFileSync(catalogPath, '   \n', 'utf8');
  assert.match(service.renderLoadedContext(await service.loadForAgent()), /目录为空/);
});

test('accepts a summary longer than the prompt budget instead of failing the import', () => {
  const { parseCatalogSummary } = require(join(buildDirectory, 'documents/document-catalog.service.js'));
  const summary = '长'.repeat(300);
  const parsed = parseCatalogSummary(
    JSON.stringify({ summary, keywords: ['甲', '乙', '丙'], documentType: '课程资料' }),
  );
  assert.equal(Array.from(parsed.summary).length, 300);
});

test('rejects malformed catalog output without echoing provider or document text', () => {
  const { DocumentCatalogError, parseCatalogSummary } = require(
    join(buildDirectory, 'documents/document-catalog.service.js'),
  );
  const isInvalid = (error) =>
    error instanceof DocumentCatalogError && error.code === 'INVALID_SUMMARY';

  assert.throws(
    () => parseCatalogSummary('not json DOCUMENT-BODY'),
    (error) => isInvalid(error) && !error.message.includes('DOCUMENT-BODY'),
  );
  assert.throws(
    () => parseCatalogSummary(JSON.stringify({ summary: '  ', keywords: ['甲', '乙', '丙'], documentType: 'x' })),
    isInvalid,
  );
  assert.throws(
    () => parseCatalogSummary(JSON.stringify({ summary: '摘要', keywords: ['甲'], documentType: 'x' })),
    isInvalid,
  );
  assert.throws(
    () => parseCatalogSummary(JSON.stringify({ summary: '摘要', keywords: ['甲', '乙', '丙'], documentType: '' })),
    isInvalid,
  );
});
