const assert = require('node:assert/strict');
const test = require('node:test');
const { join, resolve } = require('node:path');

const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { renderCatalogIndex } = require(join(buildDirectory, 'documents/document-catalog.service.js'));

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
