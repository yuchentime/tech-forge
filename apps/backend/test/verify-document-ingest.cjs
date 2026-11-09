require('reflect-metadata');

const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { DataSource } = require('typeorm');

/** Isolated build output, so a running dev backend that locks `dist` does not block the check. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const load = (modulePath) => require(join(buildDirectory, modulePath));

const { buildDatabaseOptions } = load('database/database.options.js');
const { DocumentEntity } = load('documents/document.entity.js');
const { DocumentVersionEntity } = load('documents/document-version.entity.js');
const { DocumentChunkEntity } = load('documents/document-chunk.entity.js');
const { DocumentsService } = load('documents/documents.service.js');
const { DocumentParserService } = load('platform/document-parser/document-parser.service.js');
const { PdfTextParser } = load('platform/document-parser/parsers/pdf-text.parser.js');
const { DocxParser } = load('platform/document-parser/parsers/docx.parser.js');
const { PlainTextParser } = load('platform/document-parser/parsers/plain-text.parser.js');
const { EmbeddingService } = load('embedding/embedding.service.js');

/**
 * Manual end-to-end check: local file path in, persisted document rows out.
 *
 * Usage: node test/verify-document-ingest.cjs <file> [file...]
 * Storage and SQLite go to `<cwd>/.verify-data` (override with TEACHFORGE_DATA_DIR).
 */
async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('usage: node test/verify-document-ingest.cjs <file> [file...]');
    process.exitCode = 1;
    return;
  }

  const dataDirectory = process.env.TEACHFORGE_DATA_DIR ?? join(process.cwd(), '.verify-data');
  mkdirSync(dataDirectory, { recursive: true });
  const dataSource = new DataSource({ ...buildDatabaseOptions(), logging: false });
  await dataSource.initialize();

  const parser = new DocumentParserService(
    new PdfTextParser(),
    new DocxParser(),
    new PlainTextParser(),
  );
  const service = new DocumentsService(
    dataSource.getRepository(DocumentEntity),
    dataSource.getRepository(DocumentVersionEntity),
    dataSource.getRepository(DocumentChunkEntity),
    dataSource,
    parser,
    new EmbeddingService(),
    // Import-only dependency; ingest itself never touches the workspace.
    { getWorkspacePath: async () => dataDirectory },
    dataDirectory,
  );

  console.log(`data directory: ${dataDirectory}`);
  try {
    for (const input of inputs) {
      const filePath = resolve(input);
      const startedAt = Date.now();
      try {
        const result = await service.ingestFile({ filePath });
        const warnings = result.warnings.reduce((tally, warning) => {
          tally[warning.code] = (tally[warning.code] ?? 0) + 1;
          return tally;
        }, {});
        console.log(
          `OK ${filePath}`,
          `| ${Date.now() - startedAt}ms`,
          `| document ${result.documentId}`,
          `| version v${result.versionNo}`,
          `| ${result.chunkCount} chunks`,
          `| ${result.duplicate ? 'duplicate (skipped)' : result.status}`,
          `| ${JSON.stringify(warnings)}`,
        );
      } catch (error) {
        console.log(`FAIL ${filePath} | ${error.code ?? 'UNEXPECTED'} | ${error.message}`);
      }
    }

    const documents = await dataSource.getRepository(DocumentEntity).find();
    const versions = await dataSource.getRepository(DocumentVersionEntity).find();
    const chunks = await dataSource.getRepository(DocumentChunkEntity).find();
    console.log(
      `\npersisted: ${documents.length} documents, ${versions.length} versions, ${chunks.length} chunks`,
    );
    for (const version of versions) {
      const stored = join(dataDirectory, version.workspaceRelativePath);
      const storedHash = createHash('sha256').update(readFileSync(stored)).digest('hex');
      console.log(
        `  ${version.originalName} | v${version.versionNo} | ${version.processingStatus} | ` +
          `hash ${storedHash.slice(0, 12)} == ${version.contentHash.slice(0, 12)} | ${version.workspaceRelativePath}`,
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
