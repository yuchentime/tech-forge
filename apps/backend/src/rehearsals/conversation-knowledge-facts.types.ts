import type { MasteryStatus } from './rehearsal.types';

/** Durable lifecycle of one conversation's derived knowledge fact. */
export type KnowledgeFactGenerationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

/** Mastery level owned by the fact contract; deliberately separate from report statuses. */
export type KnowledgeFactMasteryLevel =
  | 'proficient'
  | 'basic'
  | 'needs_improvement';

/** How much valid evidence backs one knowledge point. */
export type KnowledgeFactEvidenceStatus =
  | 'sufficient'
  | 'insufficient'
  | 'conflicting';

/** Logical reference into one rehearsal plan; there is no knowledge-point table. */
export interface KnowledgeFactEvidenceRef {
  rehearsalId: string;
  pointId: string;
}

/** One knowledge point in a published fact. */
export interface KnowledgePointDetail {
  name: string;
  masteryLevel: KnowledgeFactMasteryLevel | null;
  evidenceStatus: KnowledgeFactEvidenceStatus;
  details: string;
  changeDescription: string;
  /** Latest valid assessment time, never the generation time. */
  lastAssessedAt: string | null;
  evidenceRefs: KnowledgeFactEvidenceRef[];
}

/** Model-produced content that is published as one atomic fact version. */
export interface KnowledgeFactContent {
  summary: string;
  knowledgePointDetails: KnowledgePointDetail[];
  tags: string[];
  masteryLevel: KnowledgeFactMasteryLevel | null;
}

/** Read-only fact returned by the conversation endpoint. */
export interface ConversationKnowledgeFactView {
  summary: string | null;
  knowledgePointDetails: KnowledgePointDetail[] | null;
  tags: string[] | null;
  masteryLevel: KnowledgeFactMasteryLevel | null;
  generationStatus: KnowledgeFactGenerationStatus;
  lastError: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Envelope of the read-only knowledge-facts endpoint. */
export interface ConversationKnowledgeFactsView {
  conversationId: string;
  fact: ConversationKnowledgeFactView | null;
}

/**
 * Lightweight collection row.
 *
 * It intentionally omits `knowledgePointDetails`: the list endpoint selects only the small
 * columns, so one conversation's potentially large detail JSON is never loaded or serialized.
 */
export interface ConversationKnowledgeFactListItem {
  conversationId: string;
  summary: string | null;
  tags: string[] | null;
  masteryLevel: KnowledgeFactMasteryLevel | null;
  generationStatus: KnowledgeFactGenerationStatus;
  lastError: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Envelope of the read-only knowledge-facts collection endpoint. */
export interface ConversationKnowledgeFactsListView {
  items: ConversationKnowledgeFactListItem[];
}

/** One point inside a rehearsal report, already joined with its plan label. */
export interface FactEvaluationPoint {
  pointId: string;
  name: string;
  status: MasteryStatus;
  evidence: string;
}

/** One completed rehearsal reduced to the evidence the fact model may use. */
export interface FactEvaluation {
  rehearsalId: string;
  endedAt: string;
  topic: string;
  knowledgePoints: FactEvaluationPoint[];
  report: {
    summary: string;
    strengths: string[];
    gaps: string[];
    suggestions: string[];
    recommendedReview: string[];
    disclaimer: string;
  };
}

/** Existing published fact plus every completed evaluation, loaded under one DB claim. */
export interface FactInputSnapshot {
  existingFact: (KnowledgeFactContent & { generatedAt: string }) | null;
  evaluations: FactEvaluation[];
}

/** User-data block sent to the fact model; every field is evidence, not instruction. */
export interface FactPromptPayload {
  existingFact: (KnowledgeFactContent & { generatedAt: string }) | null;
  historyEvaluations: FactEvaluation[];
  currentEvaluation: FactEvaluation;
  totalEvaluationCount: number;
  historyTruncated: boolean;
  omittedHistoryCount: number;
  retainedHistoryFrom: string | null;
  retainedHistoryTo: string | null;
}

/** Result of one budgeted prompt construction. */
export interface FactPromptSelection {
  prompt: string;
  retainedHistoryCount: number;
  omittedHistoryCount: number;
  retainedHistoryFrom: string | null;
  retainedHistoryTo: string | null;
  estimatedTokenUpperBound: number;
  availableTokens: number;
}
