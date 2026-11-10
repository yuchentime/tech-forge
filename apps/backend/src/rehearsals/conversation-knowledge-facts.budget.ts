import {
  buildKnowledgeFactsUserPrompt,
  KNOWLEDGE_FACTS_SYSTEM_PROMPT,
} from './conversation-knowledge-facts.prompts';
import type {
  FactEvaluation,
  FactInputSnapshot,
  FactPromptPayload,
  FactPromptSelection,
  KnowledgeFactContent,
} from './conversation-knowledge-facts.types';

/** Raised when the mandatory fact material cannot fit the selected model's context window. */
export class KnowledgeFactBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeFactBudgetError';
  }
}

/** Output tokens reserved for the fact JSON. */
export const FACT_OUTPUT_RESERVE_TOKENS = 8_192;

/** Safety margin as a share of the provider context window. */
export const FACT_SAFETY_MARGIN_RATIO = 0.1;

/**
 * Bytes reserved for the structural wrapper and the worst-case JSON repair instruction.
 *
 * The estimate deliberately uses UTF-8 bytes as a token upper bound; Chinese text is therefore
 * treated conservatively instead of being counted by characters.
 */
export const FACT_STRUCTURE_AND_REPAIR_ALLOWANCE_BYTES = 4_096;

/** Computes the token budget available to the prompt for one resolved context window. */
export function getAvailableFactPromptTokens(contextWindow: number | null): number {
  if (contextWindow === null || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new KnowledgeFactBudgetError('模型上下文窗口未知，无法构造事实输入。');
  }
  const safetyMargin = Math.ceil(contextWindow * FACT_SAFETY_MARGIN_RATIO);
  const available =
    contextWindow - FACT_OUTPUT_RESERVE_TOKENS - safetyMargin;
  if (available <= 0) {
    throw new KnowledgeFactBudgetError('模型上下文窗口不足以容纳事实输出预留。');
  }
  return available;
}

/** Estimates an upper token bound for one prompt using UTF-8 byte length. */
function estimatePromptTokens(systemPrompt: string, userPrompt: string): number {
  return (
    Buffer.byteLength(systemPrompt, 'utf8') +
    Buffer.byteLength(userPrompt, 'utf8') +
    FACT_STRUCTURE_AND_REPAIR_ALLOWANCE_BYTES
  );
}

/** Builds the payload for one truncation level; history stays in ascending time order. */
function buildPayload(
  existingFact: (KnowledgeFactContent & { generatedAt: string }) | null,
  history: readonly FactEvaluation[],
  current: FactEvaluation,
  totalEvaluationCount: number,
): FactPromptPayload {
  const first = history[0]?.endedAt ?? null;
  const last = history[history.length - 1]?.endedAt ?? null;
  return {
    existingFact,
    historyEvaluations: [...history],
    currentEvaluation: current,
    totalEvaluationCount,
    historyTruncated: history.length < totalEvaluationCount - 1,
    omittedHistoryCount: totalEvaluationCount - 1 - history.length,
    retainedHistoryFrom: first,
    retainedHistoryTo: last,
  };
}

/**
 * Chooses the largest history window that fits the resolved model context.
 *
 * All available history is tried first. On overflow, the oldest evaluations are removed one whole
 * evaluation at a time, down to N=0. The current evaluation and the previous fact are never
 * truncated; if they alone overflow, generation must fail instead of publishing a partial fact.
 */
export function buildBudgetedKnowledgeFactsPrompt(input: {
  contextWindow: number | null;
  snapshot: FactInputSnapshot;
  current: FactEvaluation;
  systemPrompt?: string;
}): FactPromptSelection {
  const systemPrompt = input.systemPrompt ?? KNOWLEDGE_FACTS_SYSTEM_PROMPT;
  const availableTokens = getAvailableFactPromptTokens(input.contextWindow);
  const history = input.snapshot.evaluations.slice(0, -1);
  const totalEvaluationCount = input.snapshot.evaluations.length;

  for (let retained = history.length; retained >= 0; retained -= 1) {
    const retainedHistory = history.slice(history.length - retained);
    const payload = buildPayload(
      input.snapshot.existingFact,
      retainedHistory,
      input.current,
      totalEvaluationCount,
    );
    const prompt = buildKnowledgeFactsUserPrompt(payload);
    const estimatedTokenUpperBound = estimatePromptTokens(systemPrompt, prompt);
    if (estimatedTokenUpperBound <= availableTokens) {
      return {
        prompt,
        retainedHistoryCount: retained,
        omittedHistoryCount: payload.omittedHistoryCount,
        retainedHistoryFrom: payload.retainedHistoryFrom,
        retainedHistoryTo: payload.retainedHistoryTo,
        estimatedTokenUpperBound,
        availableTokens,
      };
    }
  }

  throw new KnowledgeFactBudgetError(
    '必保留的旧事实与本次评估超出模型上下文窗口。',
  );
}
