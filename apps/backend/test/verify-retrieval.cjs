require('reflect-metadata');

const { mkdirSync } = require('node:fs');
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
const { RetrievalService } = load('retrieval/retrieval.service.js');
const { EmbeddingService } = load('embedding/embedding.service.js');
const { DocumentParserService } = load('platform/document-parser/document-parser.service.js');
const { PdfTextParser } = load('platform/document-parser/parsers/pdf-text.parser.js');
const { DocxParser } = load('platform/document-parser/parsers/docx.parser.js');
const { PlainTextParser } = load('platform/document-parser/parsers/plain-text.parser.js');

/**
 * Manual end-to-end check for the retrieval business line.
 *
 * Usage: node test/verify-retrieval.cjs <file> <query> [query...]
 * Ingests the file (idempotent) into `TEACHFORGE_DATA_DIR` and prints fused hits per query.
 */
async function main() {
  const [filePath, ...queries] = process.argv.slice(2);
  if (!filePath || queries.length === 0) {
    console.error('usage: node test/verify-retrieval.cjs <file> <query> [query...]');
    process.exitCode = 1;
    return;
  }

  const dataDirectory = process.env.TEACHFORGE_DATA_DIR ?? join(process.cwd(), '.verify-data');
  mkdirSync(dataDirectory, { recursive: true });
  const dataSource = new DataSource({ ...buildDatabaseOptions(), logging: false });
  await dataSource.initialize();

  const embeddings = new EmbeddingService();
  const parser = new DocumentParserService(
    new PdfTextParser(),
    new DocxParser(),
    new PlainTextParser(),
  );
  const documents = new DocumentsService(
    dataSource.getRepository(DocumentEntity),
    dataSource.getRepository(DocumentVersionEntity),
    dataSource.getRepository(DocumentChunkEntity),
    dataSource,
    parser,
    embeddings,
    dataDirectory,
  );
  const retrieval = new RetrievalService(dataSource, embeddings);

  try {
    const started = Date.now();
    const ingested = await documents.ingestFile({ filePath: resolve(filePath) });
    const vectors = await dataSource.query(
      'SELECT COUNT(*) AS total FROM chunk_embeddings WHERE embeddingModel = ?',
      [embeddings.modelId],
    );
    console.log(
      `ingest ${Date.now() - started}ms | ${ingested.status} | ${ingested.chunkCount} chunks | ` +
        `${vectors[0].total} vectors (${embeddings.modelId} ${embeddings.dimension}d)`,
    );

    for (const query of queries) {
      const queryStarted = Date.now();
      const hits = await retrieval.search({ query, limit: 3 });
      console.log(`\nquery: ${query} | ${Date.now() - queryStarted}ms | hits ${hits.length}`);
      for (const hit of hits) {
        const locator = JSON.parse(hit.locatorJson);
        console.log(
          `  rrf ${hit.score.rrf.toFixed(4)} | lex ${hit.score.lexicalRank ?? '-'} | ` +
            `vec ${hit.score.vectorRank ?? '-'} (${(hit.score.vectorScore ?? 0).toFixed(3)}) | ` +
            `page ${locator.pageStart ?? '-'} | ${JSON.stringify(hit.content.slice(0, 60))}`,
        );
      }
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
