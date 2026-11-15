import type { RehearsalEntity } from './rehearsal.entity';
import type { RehearsalTurnEntity } from './rehearsal-turn.entity';

/** Lifecycle of one rehearsal batch. */
export type RehearsalStatus =
  | 'preparing'
  | 'awaiting_answer'
  | 'evaluating'
  | 'preparing_next'
  | 'reporting'
  | 'completed'
  | 'failed';

/** Lifecycle of one question/answer turn. */
export type RehearsalTurnStatus =
  | 'awaiting_answer'
  | 'answer_saved'
  | 'evaluated'
  | 'skipped'
  | 'unanswered'
  | 'failed';

export type RehearsalTurnKind = 'base' | 'follow_up';
export type RehearsalEndReason =
  | 'manual'
  | 'limit'
  | 'coverage'
  | 'failed';
/** Next step returned to the UI; a finished drill has no next step. */
export type RehearsalAction = 'follow_up' | 'next_question';
/** Model-chosen continuation: finish means the covered content is sufficient. */
export type RehearsalDecisionAction = RehearsalAction | 'finish';
export type AssessmentLevel = 'correct' | 'partial' | 'incorrect' | 'uncertain';
export type PlanPointStatus = 'pending' | 'covered' | 'weak';
export type MasteryStatus = 'mastered' | 'partial' | 'weak' | 'unverified';
/** One knowledge point in the fact-shaped mock knowledge-card response. */
export interface KnowledgeCardPointView {
  name: string;
  masteryLevel: 'proficient' | 'basic' | 'needs_improvement' | null;
  evidenceStatus: 'sufficient' | 'insufficient' | 'conflicting';
  details: string;
  changeDescription: string;
  lastAssessedAt: string | null;
  evidenceRefs: Array<{ rehearsalId: string; pointId: string }>;
}

/** One published fact value carried by the knowledge-card mock API. */
export interface KnowledgeCardFactView {
  summary: string | null;
  knowledgePointDetails: KnowledgeCardPointView[] | null;
  tags: string[] | null;
  masteryLevel: 'proficient' | 'basic' | 'needs_improvement' | null;
  generationStatus: 'pending' | 'running' | 'completed' | 'failed';
  lastError: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One conversation-scoped item returned by the knowledge-card mock API. */
export interface KnowledgeCardView {
  conversationId: string;
  fact: KnowledgeCardFactView | null;
}

/** Collection returned by the local knowledge-profile mock endpoint. */
export interface KnowledgeCardsView {
  items: KnowledgeCardView[];
}

/** One planned knowledge point; the model may update status as the drill progresses. */
export interface RehearsalPlanPoint {
  id: string;
  label: string;
  why: string;
  status?: PlanPointStatus;
  note?: string;
}

/** Opening plan produced before the first question. */
export interface RehearsalPlan {
  topic: string;
  learningSummary: string;
  knowledgePoints: RehearsalPlanPoint[];
  generatedAt: string;
}

/** Per-answer evaluation stored on a turn. */
export interface RehearsalAssessment {
  level: AssessmentLevel;
  issues: string[];
  evidence: string[];
  missingPoints: string[];
}

/** One plan-status update returned by the model. */
export interface RehearsalPlanUpdate {
  id: string;
  status: PlanPointStatus;
  note?: string;
}

/** Structured model decision after one answer. */
export interface RehearsalDecision {
  assessment: RehearsalAssessment;
  planUpdates: RehearsalPlanUpdate[];
  action: RehearsalDecisionAction;
  nextQuestion?: string;
  reason?: string;
}

/** Structured model output for a skip; no assessment is produced. */
export interface RehearsalSkipDecision {
  planUpdates: RehearsalPlanUpdate[];
  nextQuestion: string;
  reason?: string;
}

/** Overall report; per-question rows are assembled from stored turns by the service. */
export interface RehearsalReport {
  summary: string;
  knowledgePointMastery: Array<{
    pointId: string;
    status: MasteryStatus;
    evidence: string;
  }>;
  strengths: string[];
  gaps: string[];
  suggestions: string[];
  recommendedReview: string[];
  disclaimer: string;
}

/** Progress counters exposed to the UI. */
export interface RehearsalProgress {
  asked: number;
  limit: number;
  remaining: number;
  baseQuestions: number;
  skipped: number;
  currentFollowUpDepth: number;
}

/** One question shown in the drill view or a history detail. */
export interface RehearsalQuestionView {
  turnId: string;
  sequenceNo: number;
  baseSequenceNo: number;
  followUpDepth: number;
  kind: RehearsalTurnKind;
  text: string;
}

/** One turn in a rehearsal detail response. */
export interface RehearsalTurnView {
  turnId: string;
  sequenceNo: number;
  baseSequenceNo: number;
  followUpDepth: number;
  kind: RehearsalTurnKind;
  pointId: string | null;
  question: string;
  answer: string | null;
  assessment: RehearsalAssessment | null;
  status: RehearsalTurnStatus;
  askedAt: string;
  answeredAt: string | null;
  evaluatedAt: string | null;
}

/** Full state used by the session page, report page and history detail. */
export interface RehearsalDetailView {
  rehearsalId: string;
  conversationId: string;
  status: RehearsalStatus;
  topic: string | null;
  persona: string | null;
  plan: RehearsalPlan | null;
  progress: RehearsalProgress;
  currentQuestion: RehearsalQuestionView | null;
  turns: RehearsalTurnView[];
  report: RehearsalReport | null;
  endReason: RehearsalEndReason | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** Start response: enough for the first question without the full turn list. */
export interface RehearsalStartView {
  rehearsalId: string;
  status: RehearsalStatus;
  topic: string;
  persona: string | null;
  plan: RehearsalPlan;
  question: RehearsalQuestionView;
  progress: RehearsalProgress;
}

/** Answer/skip response. */
export interface RehearsalTurnResultView {
  turnId: string;
  assessment: RehearsalAssessment | null;
  action: RehearsalAction | null;
  question: RehearsalQuestionView | null;
  completed: boolean;
  report: RehearsalReport | null;
  progress: RehearsalProgress;
}

/** One history-list row; intentionally excludes turns and the full report. */
export interface RehearsalSummaryView {
  rehearsalId: string;
  status: RehearsalStatus;
  topic: string | null;
  persona: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: RehearsalEndReason | null;
  progress: RehearsalProgress;
  overallSummary: string | null;
  hasReport: boolean;
}

/** Paginated history response. */
export interface RehearsalListView {
  items: RehearsalSummaryView[];
  counts: {
    completed: number;
    active: number;
    failed: number;
  };
  nextCursor: string | null;
}

/** Rehearsal row plus its ordered turns, used by report and digest builders. */
export interface RehearsalWithTurns {
  rehearsal: RehearsalEntity;
  turns: RehearsalTurnEntity[];
}

/** Real phases of an in-flight start; the renderer names what it is waiting on. */
export type RehearsalPreparingPhase =
  | 'history'
  | 'prior_summaries'
  | 'session'
  | 'plan'
  | 'saving';

/** Read-only phase snapshot for one in-flight start; never persisted. */
export interface RehearsalPreparingView {
  rehearsalId: string;
  phase: RehearsalPreparingPhase;
}
