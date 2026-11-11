/**
 * Pure text rules for long-term memory capture and conflict detection.
 *
 * These rules are deliberately small and deterministic: Chinese negation is not handled by db0's
 * English heuristics, and capture must never call a model. Keeping them pure makes them testable
 * without loading the embedding model.
 */

/** Sentences the user explicitly asks to remember, or durable preference markers. */
export const MEMORY_INTENT_PATTERN =
  /记住|记一下|帮我记|以后(都|每次|请)|每次(都|要)|不要(再)?用|我的偏好是|我习惯|我要求/;

/** Content that must never enter long-term memory (teaching state, credentials). */
export const MEMORY_EXCLUSION_PATTERN =
  /掌握|正确率|错题|薄弱|不会做|api[\s_-]?key|secret|token|密码/i;

const NEGATIVE_WORDS = [
  '不要',
  '别',
  '不再',
  '禁止',
  '避免',
  '不用',
  '无需',
  '取消',
  'not',
  "don't",
  'never',
  'no longer',
  'instead of',
];

const POSITIVE_WORDS = ['要', '用', '喜欢', '需要', '保持', '继续', 'prefer', 'always'];

/** Normalizes a memory for exact-duplicate comparison. */
export function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[。！？!?.,，;；:：]+$/u, '');
}

/** Classifies Chinese/English affirmation polarity; neutral content never supersedes. */
export function memoryPolarity(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();
  // A negation marker wins: "不要用 X" must not read as "用 X" just because the action word is
  // still present. Contrast phrases are out of scope for v1 and stay neutral only when no marker
  // exists at all.
  if (NEGATIVE_WORDS.some((word) => lower.includes(word))) return 'negative';
  if (POSITIVE_WORDS.some((word) => lower.includes(word))) return 'positive';
  return 'neutral';
}

/** Splits one message into sentence candidates without keeping empty fragments. */
export function splitMemorySentences(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Returns true when the sentence carries explicit memory intent. */
export function hasMemoryIntent(text: string): boolean {
  return MEMORY_INTENT_PATTERN.test(text);
}

/** Returns true when the sentence must be excluded from memory. */
export function isExcludedMemory(text: string): boolean {
  return MEMORY_EXCLUSION_PATTERN.test(text);
}

/**
 * Selects the sentences one user message may store automatically.
 *
 * At most two sentences, each between 4 and 300 characters, carrying explicit intent and not
 * matching an exclusion rule. Order is preserved.
 */
export function selectMemoryCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const sentence of splitMemorySentences(text)) {
    if (candidates.length >= 2) break;
    if (sentence.length < 4 || sentence.length > 300) continue;
    if (!hasMemoryIntent(sentence) || isExcludedMemory(sentence)) continue;
    candidates.push(sentence);
  }
  return candidates;
}
