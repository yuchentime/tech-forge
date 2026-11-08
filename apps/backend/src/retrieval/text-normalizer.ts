/**
 * Text normalisation shared by indexing and (later) query building.
 *
 * Chinese has no word delimiters, so FTS5's `unicode61` tokenizer treats a whole sentence as one
 * token and a two-character query never matches. The stream therefore emits Han bigrams; ASCII and
 * other alphabetic runs stay whole and are stemmed later by the FTS `porter` tokenizer.
 */

/** Characters that survive document conversion but must never reach the index. */
const INVISIBLE = /[\u200B-\u200D\uFEFF\u2060]/g;
/** Markdown backslash escapes (`178\-2119`) and HTML anchors injected by DOCX conversion. */
const MARKDOWN_ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~|"'$])/g;
const HTML_ANCHOR = /<a\s+[^>]*>\s*<\/a>/gi;
/** Han ideographs plus CJK punctuation ranges treated as one script run. */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM = /[\p{L}\p{N}]/u;

/** One search term plus the run it came from, so query building can regroup them into phrases. */
interface Term {
  value: string;
  runId: number;
}

/** Removes conversion artifacts that would pollute tokens or character offsets. */
function clean(input: string): string {
  return input
    .replace(HTML_ANCHOR, '')
    .replace(INVISIBLE, '')
    .replace(MARKDOWN_ESCAPE, '$1')
    .normalize('NFKC')
    .toLowerCase();
}

/**
 * Splits cleaned text into terms: Han runs become bigrams, other runs become whole words.
 *
 * A single Han character is kept as a unigram; without it a one-character query would vanish.
 */
function splitTerms(input: string): Term[] {
  const terms: Term[] = [];
  let runId = 0;
  let run: string[] = [];
  let runIsHan = false;

  const flush = (): void => {
    if (run.length === 0) return;
    if (runIsHan) {
      const text = run.join('');
      if (text.length === 1) terms.push({ value: text, runId });
      else for (let index = 0; index + 1 < text.length; index += 1) terms.push({ value: text.slice(index, index + 2), runId });
    } else {
      terms.push({ value: run.join(''), runId });
    }
    run = [];
    runId += 1;
  };

  for (const character of Array.from(input)) {
    if (HAN.test(character)) {
      if (!runIsHan) flush();
      runIsHan = true;
      run.push(character);
      continue;
    }
    if (ALNUM.test(character)) {
      if (runIsHan) flush();
      runIsHan = false;
      run.push(character);
      continue;
    }
    // Any separator ends the current run; separators are never indexed themselves.
    flush();
  }
  flush();
  return terms;
}

/** Builds the persisted search-term stream: Han bigrams and whole words joined by spaces. */
export function toSearchTerms(input: string): string {
  return splitTerms(clean(input))
    .map((term) => term.value)
    .join(' ');
}

/**
 * Returns the character when the whole query is one Han character.
 *
 * Such a query cannot use the bigram index: a character inside a longer Han run is indexed only as
 * part of bigrams, so `工` would miss every chunk that contains `工具`. Callers use this to fall
 * back to a substring scan instead of a MATCH expression.
 */
export function singleHanCharacter(input: string): string | null {
  const terms = splitTerms(clean(input));
  if (terms.length !== 1) return null;
  const value = terms[0].value;
  return value.length === 1 && HAN.test(value) ? value : null;
}

/**
 * Builds an FTS5 MATCH expression for a user query.
 *
 * Per Han run: a single bigram stays a term, two bigrams become a phrase (order matters and recall is
 * still fine), and longer runs become an OR of bigrams because a three-word Chinese query rarely
 * appears as one contiguous phrase — BM25 then sorts by how many bigrams matched. Separate runs and
 * ASCII words are AND-ed. Returns `null` when the query has no indexable term.
 */
export function buildMatchQuery(input: string): string | null {
  const terms = splitTerms(clean(input));
  if (terms.length === 0) return null;

  const termsByRun = new Map<number, string[]>();
  for (const term of terms) {
    const bucket = termsByRun.get(term.runId) ?? [];
    bucket.push(term.value);
    termsByRun.set(term.runId, bucket);
  }

  const groups: string[] = [];
  for (const values of termsByRun.values()) {
    // Up to three bigrams (≤4 characters) stays a phrase: it is short enough that a false-positive
    // OR match would be likely, and long enough that a contiguous hit is plausible.
    if (values.length <= 3) groups.push(quotePhrase(values));
    else groups.push(`(${values.map((value) => quotePhrase([value])).join(' OR ')})`);
  }
  return groups.length > 0 ? groups.join(' AND ') : null;
}

/** Quotes a term group as an FTS5 phrase, escaping embedded double quotes. */
function quotePhrase(values: string[]): string {
  const joined = values.join(' ').replace(/"/g, '""');
  return `"${joined}"`;
}
