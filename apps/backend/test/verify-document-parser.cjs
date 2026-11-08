const { join, resolve } = require('node:path');

/** Isolated build output, so a running dev backend that locks `dist` does not block the check. */
const buildDirectory = resolve(__dirname, '..', process.env.BACKEND_TEST_BUILD_DIR ?? '.test-dist');
const { DocumentParserService } = require(join(buildDirectory, 'platform/document-parser/document-parser.service.js'));
const { PdfTextParser } = require(join(buildDirectory, 'platform/document-parser/parsers/pdf-text.parser.js'));
const { DocxParser } = require(join(buildDirectory, 'platform/document-parser/parsers/docx.parser.js'));
const { PlainTextParser } = require(join(buildDirectory, 'platform/document-parser/parsers/plain-text.parser.js'));

/**
 * Manual smoke check for the document parser adapter.
 *
 * Usage: node test/verify-document-parser.cjs <file> [file...]
 * Prints per-file parse duration, page count, character count, chosen parser and warning tallies.
 */
async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('usage: node test/verify-document-parser.cjs <file> [file...]');
    process.exitCode = 1;
    return;
  }

  const service = new DocumentParserService(
    new PdfTextParser(),
    new DocxParser(),
    new PlainTextParser(),
  );

  for (const input of inputs) {
    const inputPath = resolve(input);
    const originalName = input.split(/[\\/]/).pop() ?? 'file';
    const startedAt = Date.now();
    try {
      const result = await service.parse({ inputPath, originalName });
      const warnings = result.warnings.reduce((tally, warning) => {
        tally[warning.code] = (tally[warning.code] ?? 0) + 1;
        return tally;
      }, {});
      console.log(
        [
          `OK ${originalName}`,
          `  ${Date.now() - startedAt}ms`,
          `${result.source.pageCount} pages`,
          `${result.text.length} chars`,
          `${result.parser.id} (${result.parser.versionOrModel})`,
          JSON.stringify(warnings),
        ].join(' | '),
      );
      console.log(`  head: ${JSON.stringify(result.text.slice(0, 120))}`);
    } catch (error) {
      console.log(`FAIL ${originalName} | ${error.code ?? 'UNEXPECTED'} | ${error.message}`);
    }
  }
}

main();
