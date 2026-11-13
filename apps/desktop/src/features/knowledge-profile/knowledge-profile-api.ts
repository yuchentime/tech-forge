import { readBackendErrorMessage } from '../../api/backend-error';
import { isRecord } from '../../api/json';
import { hasDesktopBridge } from '../../types/desktop-bridge';

export type KnowledgeFactMasteryLevel =
  | 'proficient'
  | 'basic'
  | 'needs_improvement';

export type KnowledgeFactGenerationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export type KnowledgeFactEvidenceStatus =
  | 'sufficient'
  | 'insufficient'
  | 'conflicting';

export interface KnowledgeFactEvidenceRef {
  rehearsalId: string;
  pointId: string;
}

export interface KnowledgePointDetail {
  name: string;
  masteryLevel: KnowledgeFactMasteryLevel | null;
  evidenceStatus: KnowledgeFactEvidenceStatus;
  details: string;
  changeDescription: string;
  lastAssessedAt: string | null;
  evidenceRefs: KnowledgeFactEvidenceRef[];
}

/** Mirrors the conversation-fact schema, including its pre-publication null states. */
export interface KnowledgeFactView {
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

/** Small fact row returned by the collection endpoint; knowledge-point details are omitted. */
export interface KnowledgeFactListItem {
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

/** Response envelope returned by the lightweight collection endpoint. */
interface KnowledgeFactsListView {
  items: KnowledgeFactListItem[];
}

/** Single-conversation endpoint response, including its optional published fact. */
export interface ConversationKnowledgeFactsView {
  conversationId: string;
  fact: KnowledgeFactView | null;
}

const MASTERY_LEVELS = new Set<KnowledgeFactMasteryLevel>([
  'proficient',
  'basic',
  'needs_improvement',
]);
const GENERATION_STATUSES = new Set<KnowledgeFactGenerationStatus>([
  'pending',
  'running',
  'completed',
  'failed',
]);
const EVIDENCE_STATUSES = new Set<KnowledgeFactEvidenceStatus>([
  'sufficient',
  'insufficient',
  'conflicting',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Loads lightweight fact rows through the restricted local desktop bridge. */
export async function loadKnowledgeFacts(): Promise<KnowledgeFactListItem[]> {
  if (!hasDesktopBridge()) {
    throw new Error('请通过 TeachForge 桌面应用查看知识掌握。');
  }

  const response = await window.teachforge.request<unknown>({
    method: 'GET',
    path: '/api/knowledge-facts',
  });
  if (response.status !== 200 || !isKnowledgeFactsListView(response.data)) {
    throw new Error(
      readBackendErrorMessage(response.data, '读取知识掌握情况失败，请重试。'),
    );
  }
  return response.data.items;
}

/** Loads one full fact only after the user opens that conversation's detail page. */
export async function loadConversationKnowledgeFact(
  conversationId: string,
): Promise<KnowledgeFactView | null> {
  if (!hasDesktopBridge()) {
    throw new Error('请通过 TeachForge 桌面应用查看知识掌握。');
  }
  if (!UUID_PATTERN.test(conversationId)) {
    throw new Error('会话标识无效，无法读取评估详情。');
  }

  const response = await window.teachforge.request<unknown>({
    method: 'GET',
    path: `/api/conversations/${encodeURIComponent(conversationId)}/knowledge-facts`,
  });
  if (
    response.status !== 200 ||
    !isConversationKnowledgeFactsView(response.data) ||
    response.data.conversationId !== conversationId
  ) {
    throw new Error(
      readBackendErrorMessage(response.data, '读取评估详情失败，请重试。'),
    );
  }
  return response.data.fact;
}

/** Checks the lightweight collection envelope and each detail-free fact row. */
function isKnowledgeFactsListView(value: unknown): value is KnowledgeFactsListView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['items']) &&
    Array.isArray(value.items) &&
    value.items.every(isKnowledgeFactListItem)
  );
}

/** Validates the compact collection row without expecting the omitted details field. */
function isKnowledgeFactListItem(value: unknown): value is KnowledgeFactListItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'conversationId',
      'summary',
      'tags',
      'masteryLevel',
      'generationStatus',
      'lastError',
      'generatedAt',
      'createdAt',
      'updatedAt',
    ]) &&
    typeof value.conversationId === 'string' &&
    UUID_PATTERN.test(value.conversationId) &&
    isNullableNonEmptyString(value.summary, 200) &&
    isNullableTags(value.tags) &&
    isNullableMasteryLevel(value.masteryLevel) &&
    isGenerationStatus(value.generationStatus) &&
    isNullableError(value.lastError) &&
    (value.generatedAt === null || isIsoDateTime(value.generatedAt)) &&
    isIsoDateTime(value.createdAt) &&
    isIsoDateTime(value.updatedAt) &&
    isListLifecycleValid(value)
  );
}

/** Validates the full single-conversation response returned on demand. */
function isConversationKnowledgeFactsView(
  value: unknown,
): value is ConversationKnowledgeFactsView {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['conversationId', 'fact']) &&
    typeof value.conversationId === 'string' &&
    UUID_PATTERN.test(value.conversationId) &&
    (value.fact === null || isKnowledgeFact(value.fact))
  );
}

/** Validates the lifecycle/content relationship of the detail-free collection fields. */
function isListLifecycleValid(value: Record<string, unknown>): boolean {
  const hasPublishedContent = value.generatedAt !== null;
  const contentIsValid = hasPublishedContent
    ? typeof value.summary === 'string' && Array.isArray(value.tags)
    : value.summary === null &&
      value.tags === null &&
      value.masteryLevel === null;
  const lifecycleIsValid =
    value.generationStatus === 'completed'
      ? hasPublishedContent && value.lastError === null
      : value.generationStatus === 'failed'
        ? typeof value.lastError === 'string'
        : value.lastError === null;
  return contentIsValid && lifecycleIsValid;
}

/** Checks a nullable fact summary or error string with its contract length bound. */
function isNullableNonEmptyString(value: unknown, maxLength: number): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.trim().length > 0 &&
      codePointLength(value) <= maxLength)
  );
}

/** Checks nullable collection tags and their count, content and uniqueness constraints. */
function isNullableTags(value: unknown): boolean {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length <= 8 &&
      value.every(isNonEmptyString) &&
      new Set(value.map((tag) => tag.trim())).size === value.length)
  );
}

/** Narrows a nullable mastery level to the fact contract's three supported levels. */
function isNullableMasteryLevel(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      MASTERY_LEVELS.has(value as KnowledgeFactMasteryLevel))
  );
}

/** Checks a generation status against the closed fact lifecycle enum. */
function isGenerationStatus(value: unknown): value is KnowledgeFactGenerationStatus {
  return (
    typeof value === 'string' &&
    GENERATION_STATUSES.has(value as KnowledgeFactGenerationStatus)
  );
}

/** Checks nullable error summaries and their contract length bound. */
function isNullableError(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.trim().length > 0 &&
      codePointLength(value) <= 500)
  );
}

/** Enforces field, lifecycle and nested-value constraints for one fact snapshot. */
function isKnowledgeFact(value: unknown): value is KnowledgeFactView {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'summary',
    'knowledgePointDetails',
    'tags',
    'masteryLevel',
    'generationStatus',
    'lastError',
    'generatedAt',
    'createdAt',
    'updatedAt',
  ])) {
    return false;
  }

  const hasPublishedContent = value.generatedAt !== null;
  const summaryIsValid =
    value.summary === null ||
    (typeof value.summary === 'string' &&
      value.summary.trim().length > 0 &&
      codePointLength(value.summary) > 0 &&
      codePointLength(value.summary) <= 200);
  const detailsAreValid =
    value.knowledgePointDetails === null ||
    (Array.isArray(value.knowledgePointDetails) &&
      value.knowledgePointDetails.every(isKnowledgePointDetail));
  const tagsAreValid =
    value.tags === null ||
    (Array.isArray(value.tags) &&
      value.tags.length <= 8 &&
      value.tags.every(isNonEmptyString) &&
      new Set(value.tags.map((tag) => tag.trim())).size === value.tags.length);
  const masteryIsValid =
    value.masteryLevel === null ||
    (typeof value.masteryLevel === 'string' &&
      MASTERY_LEVELS.has(value.masteryLevel as KnowledgeFactMasteryLevel));
  const generationStatusIsValid =
    typeof value.generationStatus === 'string' &&
    GENERATION_STATUSES.has(value.generationStatus as KnowledgeFactGenerationStatus);
  const errorIsValid =
    value.lastError === null ||
    (typeof value.lastError === 'string' &&
      value.lastError.trim().length > 0 &&
      codePointLength(value.lastError) <= 500);
  const timestampsAreValid =
    isIsoDateTime(value.createdAt) &&
    isIsoDateTime(value.updatedAt) &&
    (value.generatedAt === null || isIsoDateTime(value.generatedAt));
  const lifecycleIsValid =
    value.generationStatus === 'completed'
      ? value.generatedAt !== null && value.lastError === null
      : value.generationStatus === 'failed'
        ? typeof value.lastError === 'string' && value.lastError.trim().length > 0
        : value.lastError === null;

  if (
    !summaryIsValid ||
    !detailsAreValid ||
    !tagsAreValid ||
    !masteryIsValid ||
    !generationStatusIsValid ||
    !errorIsValid ||
    !timestampsAreValid ||
    !lifecycleIsValid
  ) {
    return false;
  }

  if (!hasPublishedContent) {
    return (
      value.summary === null &&
      value.knowledgePointDetails === null &&
      value.tags === null &&
      value.masteryLevel === null
    );
  }

  if (
    typeof value.summary !== 'string' ||
    !Array.isArray(value.knowledgePointDetails) ||
    !Array.isArray(value.tags)
  ) {
    return false;
  }

  return true;
}

/** Validates the closed nested knowledge-point and evidence-reference shapes. */
function isKnowledgePointDetail(value: unknown): value is KnowledgePointDetail {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'name',
    'masteryLevel',
    'evidenceStatus',
    'details',
    'changeDescription',
    'lastAssessedAt',
    'evidenceRefs',
  ])) {
    return false;
  }

  if (
    !isNonEmptyString(value.name) ||
    !(value.masteryLevel === null ||
      (typeof value.masteryLevel === 'string' &&
        MASTERY_LEVELS.has(value.masteryLevel as KnowledgeFactMasteryLevel))) ||
    typeof value.evidenceStatus !== 'string' ||
    !EVIDENCE_STATUSES.has(value.evidenceStatus as KnowledgeFactEvidenceStatus) ||
    !isNonEmptyString(value.details) ||
    !isNonEmptyString(value.changeDescription) ||
    !(value.lastAssessedAt === null || isIsoDateTime(value.lastAssessedAt)) ||
    !Array.isArray(value.evidenceRefs)
  ) {
    return false;
  }

  const evidenceKeys = new Set<string>();
  for (const ref of value.evidenceRefs) {
    if (
      !isRecord(ref) ||
      !hasOnlyKeys(ref, ['rehearsalId', 'pointId']) ||
      typeof ref.rehearsalId !== 'string' ||
      !UUID_PATTERN.test(ref.rehearsalId) ||
      !isNonEmptyString(ref.pointId)
    ) {
      return false;
    }
    const key = `${ref.rehearsalId}::${ref.pointId.trim()}`;
    if (evidenceKeys.has(key)) return false;
    evidenceKeys.add(key);
  }

  if (value.evidenceStatus === 'insufficient') {
    return value.masteryLevel === null && value.lastAssessedAt === null;
  }
  if (value.evidenceStatus === 'sufficient') {
    return value.masteryLevel !== null && value.lastAssessedAt !== null;
  }
  return true;
}

/** Returns true only for non-empty, trimmed strings used by the fact contract. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Counts Unicode code points, matching JSON Schema's string-length definition. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Checks an RFC 3339-style timestamp and rejects values JavaScript cannot parse. */
function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_TIME_PATTERN.test(value)) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month === 2
      ? isLeapYear
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/** Narrows JSON objects and rejects arrays and null. */


/** Enforces the additionalProperties:false behavior from the API JSON Schema. */
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}
