import type { FactEvaluation, KnowledgeFactContent, KnowledgeFactEvidenceRef, KnowledgePointDetail } from './conversation-knowledge-facts.types';

/** Raised when a model response violates the fact contract; never silently filtered. */
export class KnowledgeFactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeFactValidationError';
  }
}

/** Evidence needed to validate references and dates against real stored evaluations. */
export interface KnowledgeFactValidationContext {
  /** Every completed evaluation in the conversation, regardless of prompt truncation. */
  allEvaluations: readonly FactEvaluation[];
  /** Evaluations actually present in the prompt (retained history plus current). */
  promptEvaluations: readonly FactEvaluation[];
  /** Previously published fact, whose references may be carried forward unchanged. */
  existingFact: KnowledgeFactContent | null;
}

const FACT_KEYS = new Set([
  'summary',
  'knowledgePointDetails',
  'tags',
  'masteryLevel',
]);
const POINT_KEYS = new Set([
  'name',
  'masteryLevel',
  'evidenceStatus',
  'details',
  'changeDescription',
  'lastAssessedAt',
  'evidenceRefs',
]);
const EVIDENCE_REF_KEYS = new Set(['rehearsalId', 'pointId']);

const MASTERY_LEVELS = new Set(['proficient', 'basic', 'needs_improvement']);
const EVIDENCE_STATUSES = new Set(['sufficient', 'insufficient', 'conflicting']);
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects arrays, primitives and null where the contract requires an object. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KnowledgeFactValidationError(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

/** Enforces the contract's closed field set so unexpected model additions cannot leak. */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new KnowledgeFactValidationError(`${label} 包含未知字段 ${key}。`);
    }
  }
}

/** Reads a required, trimmed, non-empty string under a bounded length. */
function readRequiredString(
  value: unknown,
  label: string,
  maxLength = 4_000,
): string {
  if (typeof value !== 'string') {
    throw new KnowledgeFactValidationError(`${label} 必须是字符串。`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new KnowledgeFactValidationError(`${label} 不能为空。`);
  }
  if (Array.from(trimmed).length > maxLength) {
    throw new KnowledgeFactValidationError(`${label} 超过 ${maxLength} 字符。`);
  }
  return trimmed;
}

/** Reads a mastery level, allowing null where the contract marks it optional. */
function readMasteryLevel(
  value: unknown,
  label: string,
  nullable: boolean,
): KnowledgeFactContent['masteryLevel'] {
  if (value === null) {
    if (nullable) return null;
    throw new KnowledgeFactValidationError(`${label} 不能为空。`);
  }
  if (typeof value !== 'string' || !MASTERY_LEVELS.has(value)) {
    throw new KnowledgeFactValidationError(`${label} 不是有效等级。`);
  }
  return value as KnowledgeFactContent['masteryLevel'];
}

/** Reads one UTC ISO timestamp and normalizes it to `toISOString()` form. */
function readDateTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_DATE_TIME_PATTERN.test(value)) {
    throw new KnowledgeFactValidationError(`${label} 不是 ISO 时间。`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new KnowledgeFactValidationError(`${label} 不是有效时间。`);
  }
  return parsed.toISOString();
}

/** Normalizes a point name so exact duplicates can be detected deterministically. */
function normalizePointName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Returns every `rehearsalId::pointId` pair present in one evaluation list. */
function collectEvaluationRefs(
  evaluations: readonly FactEvaluation[],
): Set<string> {
  const refs = new Set<string>();
  for (const evaluation of evaluations) {
    for (const point of evaluation.knowledgePoints) {
      refs.add(`${evaluation.rehearsalId}::${point.pointId}`);
    }
  }
  return refs;
}

/** Returns every assessment time the stored evaluations can legitimately support. */
function collectAssessmentTimes(
  evaluations: readonly FactEvaluation[],
): Set<string> {
  const times = new Set<string>();
  for (const evaluation of evaluations) {
    const parsed = new Date(evaluation.endedAt);
    if (!Number.isNaN(parsed.getTime())) times.add(parsed.toISOString());
  }
  return times;
}

/** Reads the evidence-reference array and validates each pair's shape. */
function readEvidenceRefs(
  value: unknown,
  label: string,
): KnowledgeFactEvidenceRef[] {
  if (!Array.isArray(value)) {
    throw new KnowledgeFactValidationError(`${label} 必须是数组。`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `${label}[${index}]`);
    rejectUnknownKeys(record, EVIDENCE_REF_KEYS, `${label}[${index}]`);
    const rehearsalId = record.rehearsalId;
    const pointId = record.pointId;
    if (typeof rehearsalId !== 'string' || !UUID_PATTERN.test(rehearsalId)) {
      throw new KnowledgeFactValidationError(
        `${label}[${index}].rehearsalId 不是 UUID。`,
      );
    }
    if (typeof pointId !== 'string' || !pointId.trim()) {
      throw new KnowledgeFactValidationError(
        `${label}[${index}].pointId 不能为空。`,
      );
    }
    const key = `${rehearsalId}::${pointId.trim()}`;
    if (seen.has(key)) {
      throw new KnowledgeFactValidationError(`${label} 包含重复引用。`);
    }
    seen.add(key);
    return { rehearsalId, pointId: pointId.trim() };
  });
}

/** Validates one knowledge-point object, including its evidence/level/time combination. */
function readKnowledgePoint(
  value: unknown,
  index: number,
  context: KnowledgeFactValidationContext,
  promptRefs: ReadonlySet<string>,
  storedRefs: ReadonlySet<string>,
  assessmentTimes: ReadonlySet<string>,
): KnowledgePointDetail {
  const label = `knowledgePointDetails[${index}]`;
  const record = asRecord(value, label);
  rejectUnknownKeys(record, POINT_KEYS, label);

  const name = readRequiredString(record.name, `${label}.name`, 300);
  const evidenceStatus = record.evidenceStatus;
  if (
    typeof evidenceStatus !== 'string' ||
    !EVIDENCE_STATUSES.has(evidenceStatus)
  ) {
    throw new KnowledgeFactValidationError(`${label}.evidenceStatus 无效。`);
  }
  const masteryLevel = readMasteryLevel(
    record.masteryLevel,
    `${label}.masteryLevel`,
    true,
  );
  const details = readRequiredString(record.details, `${label}.details`);
  const changeDescription = readRequiredString(
    record.changeDescription,
    `${label}.changeDescription`,
  );

  let lastAssessedAt: string | null = null;
  if (record.lastAssessedAt !== null) {
    lastAssessedAt = readDateTime(
      record.lastAssessedAt,
      `${label}.lastAssessedAt`,
    );
    if (!assessmentTimes.has(lastAssessedAt)) {
      throw new KnowledgeFactValidationError(
        `${label}.lastAssessedAt 不是输入评估中的有效考察时间。`,
      );
    }
  }

  const evidenceRefs = readEvidenceRefs(record.evidenceRefs, `${label}.evidenceRefs`);
  for (const ref of evidenceRefs) {
    const key = `${ref.rehearsalId}::${ref.pointId}`;
    // A reference must exist in this conversation's stored evidence, and it must either be
    // present in the prompt or have been carried over verbatim from the previous fact.
    if (!storedRefs.has(key)) {
      throw new KnowledgeFactValidationError(
        `${label}.evidenceRefs 引用了不存在的演练知识点。`,
      );
    }
    if (!promptRefs.has(key) && !context.existingFact?.knowledgePointDetails.some(
      (point) => point.evidenceRefs.some(
        (oldRef) =>
          oldRef.rehearsalId === ref.rehearsalId &&
          oldRef.pointId === ref.pointId,
      ),
    )) {
      throw new KnowledgeFactValidationError(
        `${label}.evidenceRefs 不能引用未提供的评估。`,
      );
    }
  }

  if (evidenceStatus === 'insufficient') {
    if (masteryLevel !== null || lastAssessedAt !== null) {
      throw new KnowledgeFactValidationError(
        `${label} 证据不足时等级与考察时间必须为空。`,
      );
    }
  } else if (evidenceStatus === 'sufficient') {
    if (masteryLevel === null || lastAssessedAt === null) {
      throw new KnowledgeFactValidationError(
        `${label} 证据充分时必须给出等级与考察时间。`,
      );
    }
  }

  return {
    name,
    masteryLevel,
    evidenceStatus: evidenceStatus as KnowledgePointDetail['evidenceStatus'],
    details,
    changeDescription,
    lastAssessedAt,
    evidenceRefs,
  };
}

/**
 * Validates one model response against the fact contract.
 *
 * Unlike the rehearsal report parser, this rejects the whole response instead of dropping invalid
 * entries: a partially filtered fact could publish a current conclusion from discarded evidence.
 */
export function parseKnowledgeFactResponse(
  value: unknown,
  context: KnowledgeFactValidationContext,
): KnowledgeFactContent {
  const record = asRecord(value, '事实');
  rejectUnknownKeys(record, FACT_KEYS, '事实');

  const summary = readRequiredString(record.summary, 'summary', 200);
  if (Array.from(summary).length > 200) {
    throw new KnowledgeFactValidationError('summary 超过 200 字符。');
  }

  const rawTags = record.tags;
  if (!Array.isArray(rawTags)) {
    throw new KnowledgeFactValidationError('tags 必须是数组。');
  }
  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const [index, rawTag] of rawTags.entries()) {
    const tag = readRequiredString(rawTag, `tags[${index}]`, 40);
    if (seenTags.has(tag)) continue;
    seenTags.add(tag);
    tags.push(tag);
  }
  if (tags.length > 8) {
    throw new KnowledgeFactValidationError('tags 最多 8 个。');
  }

  const masteryLevel = readMasteryLevel(record.masteryLevel, 'masteryLevel', true);

  const rawPoints = record.knowledgePointDetails;
  if (!Array.isArray(rawPoints)) {
    throw new KnowledgeFactValidationError('knowledgePointDetails 必须是数组。');
  }
  const promptRefs = collectEvaluationRefs(context.promptEvaluations);
  const storedRefs = collectEvaluationRefs(context.allEvaluations);
  const assessmentTimes = collectAssessmentTimes(context.allEvaluations);
  const pointNames = new Set<string>();
  const knowledgePointDetails = rawPoints.map((point, index) => {
    const parsed = readKnowledgePoint(
      point,
      index,
      context,
      promptRefs,
      storedRefs,
      assessmentTimes,
    );
    const normalizedName = normalizePointName(parsed.name);
    if (pointNames.has(normalizedName)) {
      throw new KnowledgeFactValidationError(
        `knowledgePointDetails 包含重复知识点：${parsed.name}。`,
      );
    }
    pointNames.add(normalizedName);
    return parsed;
  });

  return {
    summary,
    knowledgePointDetails,
    tags,
    masteryLevel,
  };
}
