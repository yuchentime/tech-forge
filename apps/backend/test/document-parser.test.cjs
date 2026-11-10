const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { deflateRawSync } = require('node:zlib');

/** Isolated build output, so a running dev backend that locks `dist` does not block the suite. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { DocumentParserService } = require(join(buildDirectory, 'platform/document-parser/document-parser.service.js'));
const { PdfTextParser } = require(join(buildDirectory, 'platform/document-parser/parsers/pdf-text.parser.js'));
const { DocxParser, cleanMarkdown } = require(join(buildDirectory, 'platform/document-parser/parsers/docx.parser.js'));
const { PlainTextParser } = require(join(buildDirectory, 'platform/document-parser/parsers/plain-text.parser.js'));

/** Creates the adapter under test; limits are overridable per assertion. */
function createService(limits) {
  return new DocumentParserService(
    new PdfTextParser(),
    new DocxParser(),
    new PlainTextParser(),
    limits,
  );
}

/** Writes bytes into a throwaway directory and returns the absolute path. */
function fixture(directory, name, content) {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

/** Shared binary fixtures: a minimal PDF writer and a minimal DOCX zip builder. */
const { buildPdf, buildDocx } = require('./helpers/document-fixtures.cjs');

const workDir = mkdtempSync(join(tmpdir(), 'teachforge-parser-'));
test.after(() => rmSync(workDir, { recursive: true, force: true }));

test('routes Markdown and plain text without touching a binary parser', async () => {
  const service = createService();
  const md = await service.parse({
    inputPath: fixture(workDir, 'notes.md', '# 标题\n\n段落内容'),
    originalName: 'notes.md',
  });
  const txt = await service.parse({
    inputPath: fixture(workDir, 'notes.txt', '纯文本内容'),
    originalName: 'notes.txt',
  });

  assert.equal(md.parser.id, 'plain-text');
  assert.equal(md.format, 'markdown');
  assert.equal(md.pages.length, 1);
  assert.equal(txt.format, 'plain_text');
  assert.deepEqual(service.availableParsers(), ['pdf-text', 'docx', 'plain-text']);
});

test('rebuilds PDF pages, keeping page numbers and line order', async () => {
  const pdf = buildPdf([
    [
      { x: 50, y: 780, text: 'First page heading' },
      { x: 50, y: 760, text: 'body line one' },
      { x: 50, y: 744, text: 'body line two' },
    ],
    [{ x: 50, y: 780, text: 'Second page content' }],
  ]);
  const result = await createService().parse({
    inputPath: fixture(workDir, 'two-page.pdf', pdf),
    originalName: 'two-page.pdf',
  });

  assert.equal(result.parser.id, 'pdf-text');
  assert.equal(result.source.pageCount, 2);
  assert.equal(result.pages[0].pageNo, 1);
  assert.equal(result.pages[1].pageNo, 2);
  assert.match(result.pages[0].text, /First page heading/);
  assert.match(result.pages[1].text, /Second page content/);
  // Line order inside a page must survive; the source order is top-down.
  assert.ok(result.pages[0].text.indexOf('heading') < result.pages[0].text.indexOf('body line one'));
});

test('reports a table-of-contents page instead of silently indexing it', async () => {
  const tocLines = Array.from({ length: 4 }, (_, index) => ({
    x: 50,
    y: 780 - index * 16,
    text: `${index + 1}.1 Section title . . . . . . . ${index + 10}`,
  }));
  const result = await createService().parse({
    inputPath: fixture(workDir, 'toc.pdf', buildPdf([tocLines])),
    originalName: 'toc.pdf',
  });

  assert.ok(result.warnings.some((warning) => warning.code === 'TOC_LIKE'));
});

test('detects a two-column page and says so', async () => {
  const lines = [];
  for (let index = 0; index < 12; index += 1) {
    lines.push({ x: 50, y: 780 - index * 16, text: `left column line ${index}` });
    lines.push({ x: 330, y: 780 - index * 16, text: `right column line ${index}` });
  }
  const result = await createService().parse({
    inputPath: fixture(workDir, 'columns.pdf', buildPdf([lines])),
    originalName: 'columns.pdf',
  });

  assert.ok(
    result.warnings.some((warning) => warning.code === 'MULTI_COLUMN_SUSPECTED'),
    `warnings: ${JSON.stringify(result.warnings.map((warning) => warning.code))}`,
  );
});

test('rejects a PDF without a text layer instead of returning empty text', async () => {
  const empty = buildPdf([[]]);
  await assert.rejects(
    () => createService().parse({ inputPath: fixture(workDir, 'scan.pdf', empty), originalName: 'scan.pdf' }),
    (error) => error.code === 'NO_TEXT_LAYER',
  );
});

test('converts DOCX, promoting bold-only headings and flagging flattened tables', async () => {
  const result = await createService().parse({
    inputPath: fixture(workDir, 'lesson.docx', buildDocx()),
    originalName: 'lesson.docx',
  });

  assert.equal(result.parser.id, 'docx');
  assert.equal(result.pages.length, 1);
  assert.match(result.text, /^# 第一章 光合作用/m);
  assert.match(result.text, /^## 重点提示/m);
  assert.ok(result.warnings.some((warning) => warning.code === 'UNSTRUCTURED_TABLE'));
});

test('drops enormous DOCX data URLs instead of emitting unreadable Markdown lines', () => {
  const markdown = `before\n\n![diagram](data:image/png;base64,${'A'.repeat(700000)})\n\nafter`;
  const cleaned = cleanMarkdown(markdown);
  assert.match(cleaned, /\[原文图片已省略：diagram\]/);
  assert.doesNotMatch(cleaned, /data:image\/png;base64/);
  assert.ok(Math.max(...cleaned.split('\n').map((line) => line.length)) < 1000);
});

test('rejects renamed files, oversized files, relative paths and unsupported types', async () => {
  const pdfPath = fixture(workDir, 'renamed.docx', buildPdf([[{ x: 50, y: 780, text: 'x' }]]));
  await assert.rejects(
    () => createService().parse({ inputPath: pdfPath, originalName: 'renamed.docx' }),
    (error) => error.code === 'UNSUPPORTED_FORMAT',
  );

  const bigPath = fixture(workDir, 'big.txt', 'x'.repeat(2048));
  await assert.rejects(
    () => createService({ maxFileBytes: 16, timeoutMs: 1000 }).parse({ inputPath: bigPath, originalName: 'big.txt' }),
    (error) => error.code === 'FILE_TOO_LARGE',
  );

  await assert.rejects(
    () => createService().parse({ inputPath: 'relative/path.md', originalName: 'path.md' }),
    (error) => error.code === 'INVALID_INPUT_FILE',
  );

  const docPath = fixture(workDir, 'legacy.doc', 'binary');
  await assert.rejects(
    () => createService().parse({ inputPath: docPath, originalName: 'legacy.doc' }),
    (error) => error.code === 'UNSUPPORTED_FORMAT',
  );
});

test('honours an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createService().parse({
      inputPath: fixture(workDir, 'abort.md', '# 标题'),
      originalName: 'abort.md',
      signal: controller.signal,
    }),
    (error) => error.code === 'PARSER_CANCELLED',
  );
});
