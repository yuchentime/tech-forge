import { MAX_PLAN_POINTS, MIN_PLAN_POINTS } from './rehearsal.constants';
import type {
  AssessmentLevel,
  MasteryStatus,
  PlanPointStatus,
  RehearsalAssessment,
  RehearsalDecision,
  RehearsalDecisionAction,
  RehearsalPlanPoint,
  RehearsalPlanUpdate,
  RehearsalReport,
  RehearsalSkipDecision,
} from './rehearsal.types';

const ASSESSMENT_LEVELS: readonly AssessmentLevel[] = [
  'correct',
  'partial',
  'incorrect',
  'uncertain',
];
const PLAN_STATUSES: readonly PlanPointStatus[] = [
  'pending',
  'covered',
  'weak',
];
const MASTERY_STATUSES: readonly MasteryStatus[] = [
  'mastered',
  'partial',
  'weak',
  'unverified',
];

/** Parsed opening-plan shape. */
export interface ParsedPlan {
  topic: string;
  learningSummary: string;
  knowledgePoints: RehearsalPlanPoint[];
  firstQuestion: string;
}

/** Extracts the first JSON object from model text that may include fences or prose. */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Model output did not contain a JSON object.');
  }
  return JSON.parse(text.slice(start, end + 1));
}

/** Validates the opening plan and first question. */
export function parsePlanResponse(value: unknown): ParsedPlan {
  const record = asRecord(value);
  const topic = readString(record.topic);
  const learningSummary = readString(record.learningSummary);
  const firstQuestion = readString(record.firstQuestion);
  if (!topic || !learningSummary || !firstQuestion) {
    throw new Error('Plan is missing topic, summary or first question.');
  }

  const rawPoints = record.knowledgePoints;
  if (
    !Array.isArray(rawPoints) ||
    rawPoints.length < MIN_PLAN_POINTS ||
    rawPoints.length > MAX_PLAN_POINTS
  ) {
    throw new Error(`Plan must contain ${MIN_PLAN_POINTS}-${MAX_PLAN_POINTS} points.`);
  }
  const seen = new Set<string>();
  const knowledgePoints = rawPoints.map((rawPoint, index) => {
    const point = asRecord(rawPoint);
    const label = readString(point.label);
    if (!label) throw new Error('Plan point is missing a label.');
    let id = readString(point.id) || `kp${index + 1}`;
    if (seen.has(id)) id = `kp${index + 1}`;
    seen.add(id);
    return {
      id,
      label,
      why: readString(point.why) || '',
      status: 'pending' as PlanPointStatus,
    };
  });

  return { topic, learningSummary, knowledgePoints, firstQuestion };
}

/**
 * Validates one answer decision.
 *
 * `finish` is the model's early exit when the planned content is covered; every other action must
 * carry the next question. Any other action name (including the old `complete`) is rejected.
 */
export function parseDecisionResponse(value: unknown): RehearsalDecision {
  const record = asRecord(value);
  const assessment = parseAssessment(record.assessment);
  const rawAction = readString(record.action);
  if (
    rawAction !== 'follow_up' &&
    rawAction !== 'next_question' &&
    rawAction !== 'finish'
  ) {
    throw new Error('Decision action is invalid.');
  }
  const action = rawAction as RehearsalDecisionAction;
  const nextQuestion =
    action === 'finish' ? undefined : readString(record.nextQuestion);
  if (action !== 'finish' && !nextQuestion) {
    throw new Error('Decision is missing the next question.');
  }
  return {
    assessment,
    planUpdates: parsePlanUpdates(record.planUpdates),
    action,
    nextQuestion,
    reason: readString(record.reason) || undefined,
  };
}

/** Validates one skip decision; skips never produce an assessment. */
export function parseSkipResponse(value: unknown): RehearsalSkipDecision {
  const record = asRecord(value);
  const nextQuestion = readString(record.nextQuestion);
  if (!nextQuestion) {
    throw new Error('Skip decision is missing the next question.');
  }
  return {
    planUpdates: parsePlanUpdates(record.planUpdates),
    nextQuestion,
    reason: readString(record.reason) || undefined,
  };
}

/** Validates the overall report. Per-question rows are not accepted from the model. */
export function parseReportResponse(value: unknown): RehearsalReport {
  const record = asRecord(value);
  const summary = readString(record.summary);
  if (!summary) throw new Error('Report is missing a summary.');

  const rawMastery = record.knowledgePointMastery;
  const knowledgePointMastery = Array.isArray(rawMastery)
    ? rawMastery.flatMap((rawEntry) => {
        const entry = asRecord(rawEntry);
        const pointId = readString(entry.pointId);
        const status = readString(entry.status);
        if (!pointId || !MASTERY_STATUSES.includes(status as MasteryStatus)) {
          return [];
        }
        return [
          {
            pointId,
            status: status as MasteryStatus,
            evidence: readString(entry.evidence) || '',
          },
        ];
      })
    : [];

  return {
    summary,
    knowledgePointMastery,
    strengths: readStringArray(record.strengths, 5),
    gaps: readStringArray(record.gaps, 5),
    suggestions: readStringArray(record.suggestions, 5),
    recommendedReview: readStringArray(record.recommendedReview, 5),
    disclaimer:
      readString(record.disclaimer) ||
      '本次演练只反映已作答内容，不等于全面掌握。',
  };
}

/** Reads a record, rejecting arrays and primitives. */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

/** Reads a trimmed string and caps its length to avoid runaway model output. */
function readString(value: unknown, maxLength = 4_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** Reads a bounded string array, dropping non-string entries. */
function readStringArray(value: unknown, maxEntries: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) =>
      typeof entry === 'string' && entry.trim()
        ? [entry.trim().slice(0, 500)]
        : [],
    )
    .slice(0, maxEntries);
}

/** Validates the assessment block shared by every answer decision. */
function parseAssessment(value: unknown): RehearsalAssessment {
  const record = asRecord(value);
  const level = readString(record.level);
  if (!ASSESSMENT_LEVELS.includes(level as AssessmentLevel)) {
    throw new Error('Assessment level is invalid.');
  }
  return {
    level: level as AssessmentLevel,
    issues: readStringArray(record.issues, 3),
    evidence: readStringArray(record.evidence, 5),
    missingPoints: readStringArray(record.missingPoints, 5),
  };
}

/** Validates optional plan-status updates. */
function parsePlanUpdates(value: unknown): RehearsalPlanUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawEntry) => {
    const entry = asRecord(rawEntry);
    const id = readString(entry.id, 100);
    const status = readString(entry.status, 20);
    if (!id || !PLAN_STATUSES.includes(status as PlanPointStatus)) return [];
    return [
      {
        id,
        status: status as PlanPointStatus,
        note: readString(entry.note, 300) || undefined,
      },
    ];
  });
}
