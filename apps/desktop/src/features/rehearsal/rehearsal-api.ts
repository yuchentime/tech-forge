import { readBackendErrorMessage } from '../../api/backend-error';
import { hasDesktopBridge } from '../../types/desktop-bridge';

export type RehearsalStatus =
  | 'preparing'
  | 'awaiting_answer'
  | 'evaluating'
  | 'preparing_next'
  | 'reporting'
  | 'completed'
  | 'failed';

export type RehearsalTurnStatus =
  | 'awaiting_answer'
  | 'answer_saved'
  | 'evaluated'
  | 'skipped'
  | 'unanswered'
  | 'failed';

export type RehearsalTurnKind = 'base' | 'follow_up';
export type RehearsalEndReason = 'manual' | 'limit' | 'failed';
export type RehearsalAction = 'follow_up' | 'next_question';
export type AssessmentLevel = 'correct' | 'partial' | 'incorrect' | 'uncertain';

export interface RehearsalAssessment {
  level: AssessmentLevel;
  issues: string[];
  evidence: string[];
  missingPoints: string[];
}

export interface RehearsalPlanPoint {
  id: string;
  label: string;
  why: string;
  status?: 'pending' | 'covered' | 'weak';
  note?: string;
}

export interface RehearsalPlan {
  topic: string;
  learningSummary: string;
  knowledgePoints: RehearsalPlanPoint[];
  generatedAt: string;
}

export interface RehearsalReport {
  summary: string;
  knowledgePointMastery: Array<{
    pointId: string;
    status: 'mastered' | 'partial' | 'weak' | 'unverified';
    evidence: string;
  }>;
  strengths: string[];
  gaps: string[];
  suggestions: string[];
  recommendedReview: string[];
  disclaimer: string;
}

export interface RehearsalProgress {
  asked: number;
  limit: number;
  remaining: number;
  baseQuestions: number;
  skipped: number;
  currentFollowUpDepth: number;
}

export interface RehearsalQuestion {
  turnId: string;
  sequenceNo: number;
  baseSequenceNo: number;
  followUpDepth: number;
  kind: RehearsalTurnKind;
  text: string;
}

export interface RehearsalTurn {
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

export interface RehearsalDetail {
  rehearsalId: string;
  conversationId: string;
  status: RehearsalStatus;
  topic: string | null;
  persona: string | null;
  plan: RehearsalPlan | null;
  progress: RehearsalProgress;
  currentQuestion: RehearsalQuestion | null;
  turns: RehearsalTurn[];
  report: RehearsalReport | null;
  endReason: RehearsalEndReason | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface RehearsalSummary {
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

export interface RehearsalList {
  items: RehearsalSummary[];
  counts: {
    completed: number;
    active: number;
    failed: number;
  };
  nextCursor: string | null;
}

export interface RehearsalTurnResult {
  turnId: string;
  assessment: RehearsalAssessment | null;
  action: RehearsalAction | null;
  question: RehearsalQuestion | null;
  completed: boolean;
  report: RehearsalReport | null;
  progress: RehearsalProgress;
}

/** One JSON request through the protected desktop bridge. */
async function request<T>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<T> {
  if (!hasDesktopBridge()) {
    throw new Error('浏览器预览无法读取本地演练，请通过 TeachForge 桌面应用打开。');
  }
  const response = await window.teachforge.request<T>({ method, path, body });
  if (response.status >= 400) {
    throw new Error(
      readBackendErrorMessage(response.data, '演练请求失败，请稍后重试。'),
    );
  }
  return response.data;
}

/** Starts one rehearsal batch for a conversation. */
export function startRehearsal(
  conversationId: string,
  persona: string | undefined,
  startRequestId: string,
): Promise<RehearsalDetail> {
  return request(
    `/api/conversations/${conversationId}/rehearsals`,
    'POST',
    { ...(persona?.trim() ? { persona } : {}), startRequestId },
  );
}

/** Reads the latest rehearsal for session/report recovery. */
export function getLatestRehearsal(
  conversationId: string,
): Promise<RehearsalDetail | null> {
  return request(`/api/conversations/${conversationId}/rehearsals/latest`, 'GET');
}

/** Reads one rehearsal with turns and report. */
export function getRehearsal(rehearsalId: string): Promise<RehearsalDetail> {
  return request(`/api/rehearsals/${rehearsalId}`, 'GET');
}

/** Reads one history page. */
export function listRehearsals(
  conversationId: string,
  query: {
    limit?: number;
    cursor?: string;
    status?: 'all' | 'active' | 'completed' | 'failed';
  } = {},
): Promise<RehearsalList> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.status) params.set('status', query.status);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return request(
    `/api/conversations/${conversationId}/rehearsals${suffix}`,
    'GET',
  );
}

/** Submits one answer and returns the assessment plus next question or report. */
export function answerRehearsal(
  rehearsalId: string,
  turnId: string,
  answer: string,
  answerRequestId: string,
): Promise<RehearsalTurnResult> {
  return request(`/api/rehearsals/${rehearsalId}/answers`, 'POST', {
    turnId,
    answer,
    answerRequestId,
  });
}

/** Skips the current question. */
export function skipRehearsal(
  rehearsalId: string,
  turnId: string,
): Promise<RehearsalTurnResult> {
  return request(`/api/rehearsals/${rehearsalId}/skip`, 'POST', { turnId });
}

/** Ends the rehearsal and returns the completed detail. */
export function endRehearsal(rehearsalId: string): Promise<RehearsalDetail> {
  return request(`/api/rehearsals/${rehearsalId}/end`, 'POST');
}

/** Discards a rehearsal with no answers after the user confirms ending. */
export function discardRehearsal(
  rehearsalId: string,
): Promise<{ rehearsalId: string; discarded: true }> {
  return request(`/api/rehearsals/${rehearsalId}`, 'DELETE');
}
