import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';

/** Tokenization model used for chunk budgeting; must match the embedding model's tokenizer. */
export const CHUNK_TOKENIZER_MODEL = 'bge-small-zh-v1.5';

/** Counts sub-word tokens exactly as the embedding model will, so chunk budgets are real. */
export interface TokenCounter {
  readonly modelId: string;
  count(text: string): number;
}

/** Location of the bundled tokenizer file, resolved relative to the compiled module. */
function tokenizerPath(): string {
  // dist/documents/chunking -> apps/backend/assets; .test-dist uses the same depth.
  return join(__dirname, '../../../assets/models', CHUNK_TOKENIZER_MODEL, 'tokenizer.json');
}

let cached: TokenCounter | undefined;

/**
 * Loads the bundled BERT-style tokenizer once per process.
 *
 * The file is committed to the repository (429 KB) instead of being fetched at runtime: chunk
 * budgets must be identical offline, in tests, and in a packaged build.
 */
export function getChunkTokenCounter(): TokenCounter {
  if (cached) return cached;
  const parsed: unknown = JSON.parse(readFileSync(tokenizerPath(), 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`tokenizer 文件格式不可用：${tokenizerPath()}`);
  }
  // `@huggingface/tokenizers` instantiates from the parsed tokenizer.json plus a config object.
  const tokenizer = new Tokenizer(parsed, {});
  cached = {
    modelId: CHUNK_TOKENIZER_MODEL,
    count: (text: string) => tokenizer.encode(text).ids.length,
  };
  return cached;
}
