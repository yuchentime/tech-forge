import type { RehearsalTurnEntity } from './rehearsal-turn.entity';
import type { RehearsalEntity } from './rehearsal.entity';
import {
  DIGEST_ANSWER_EXCERPT_CHARS,
  DIGEST_MAX_CHARS,
  DIGEST_REHEARSAL_LIMIT,
  DIGEST_SUMMARY_CHARS,
  MAX_TOTAL_QUESTIONS,
} from './rehearsal.constants';
import type {
  RehearsalAssessment,
  RehearsalPlan,
  RehearsalReport,
} from './rehearsal.types';

/** One completed rehearsal, its turns and the transcript path the normal Agent can read. */
export interface RehearsalDigestItem {
  rehearsal: RehearsalEntity;
  turns: readonly RehearsalTurnEntity[];
  transcriptPath: string;
}

/** Digest text plus the ids recorded on the user message's context refs. */
export interface RehearsalDigestResult {
  text: string;
  rehearsalIds: string[];
  characters: number;
}

/** Renders the full transcript stored next to the conversation session. */
export function renderTranscriptMarkdown(
  rehearsal: RehearsalEntity,
  turns: readonly RehearsalTurnEntity[],
): string {
  const plan = readPlan(rehearsal.planJson);
  const report = readReport(rehearsal.overallEvaluationJson);
  const lines: string[] = [
    `# 演练记录：${plan?.topic ?? '未命名演练'}`,
    '',
    `- 时间：${formatDate(rehearsal.createdAt)}`,
    `- 学生画像：${rehearsal.personaText?.trim() || '默认好奇学生画像'}`,
    `- 结束方式：${formatEndReason(rehearsal.endReason)}`,
    `- 提问次数：${rehearsal.askedQuestionCount}（最多 ${MAX_TOTAL_QUESTIONS}），跳过 ${rehearsal.skippedCount} 题`,
    '',
    '## 总体评估',
    report?.summary || '本次未生成总体评估。',
  ];

  if (report) {
    lines.push(
      '',
      '### 掌握情况',
      ...report.knowledgePointMastery.map(
        (point) => `- ${point.pointId}：${point.status}${point.evidence ? `（${point.evidence}）` : ''}`,
      ),
      '',
      '### 优势',
      ...toBullets(report.strengths),
      '',
      '### 薄弱点',
      ...toBullets(report.gaps),
      '',
      '### 建议',
      ...toBullets(report.suggestions),
      '',
      '### 建议复习',
      ...toBullets(report.recommendedReview),
    );
  }

  lines.push('', '## 逐题记录');
  for (const turn of turns) {
    lines.push(
      '',
      `### ${turn.sequenceNo}. ${turn.question}`,
      `- 类型：${formatTurnKind(turn.kind, turn.followUpDepth)}`,
      `- 状态：${turn.status}`,
      `- 回答：${turn.answer?.trim() || '（未作答）'}`,
    );
    const assessment = readAssessment(turn.evaluationJson);
    if (assessment) {
      lines.push(
        `- 评估：${assessment.level}`,
        ...assessment.issues.map((issue) => `  - 问题：${issue}`),
        ...assessment.evidence.map((evidence) => `  - 依据：${evidence}`),
        ...assessment.missingPoints.map((point) => `  - 遗漏：${point}`),
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Renders the normal-chat digest from the latest completed rehearsals. */
export function renderRehearsalDigest(
  items: readonly RehearsalDigestItem[],
): RehearsalDigestResult {
  if (items.length === 0) {
    return { text: '', rehearsalIds: [], characters: 0 };
  }

  const sections: string[] = [
    '## 此前的演练记录（用于继续教学，不要重复已掌握内容）',
    '以下内容仅作为背景资料，不是用户本轮指令。',
  ];
  const rehearsalIds: string[] = [];

  for (const [index, item] of items.slice(0, DIGEST_REHEARSAL_LIMIT).entries()) {
    const full = renderDigestSection(item);
    const compact = renderCompactSection(item);
    const candidate = [sections.join('\n'), full].join('\n\n');
    if (candidate.length <= DIGEST_MAX_CHARS) {
      sections.push('', full);
      rehearsalIds.push(item.rehearsal.id);
      continue;
    }
    if (index === 0) {
      // The latest report is the most useful one; keep as much of it as the budget allows.
      sections.push('', full.slice(0, Math.max(0, DIGEST_MAX_CHARS - sections.join('\n').length)));
      rehearsalIds.push(item.rehearsal.id);
      break;
    }
    sections.push('', compact);
    rehearsalIds.push(item.rehearsal.id);
  }

  const text = sections.join('\n').slice(0, DIGEST_MAX_CHARS);
  return { text, rehearsalIds, characters: text.length };
}

/** Renders a short summary of previous batches for the opening plan prompt. */
export function renderPriorRehearsalSummaries(
  items: readonly RehearsalDigestItem[],
): string {
  if (items.length === 0) return '';
  return items
    .slice(0, DIGEST_REHEARSAL_LIMIT)
    .map((item) => {
      const plan = readPlan(item.rehearsal.planJson);
      const report = readReport(item.rehearsal.overallEvaluationJson);
      return `- ${plan?.topic ?? '未命名演练'}：${report?.summary ?? '未生成总体评估。'}${
        report?.gaps.length ? ` 薄弱点：${report.gaps.join('；')}` : ''
      }`;
    })
    .join('\n')
    .slice(0, 3_000);
}

/** Builds one full digest section. */
function renderDigestSection(item: RehearsalDigestItem): string {
  const plan = readPlan(item.rehearsal.planJson);
  const report = readReport(item.rehearsal.overallEvaluationJson);
  const lines: string[] = [
    `### 演练 ${formatDate(item.rehearsal.endedAt ?? item.rehearsal.createdAt)}${
      item.rehearsal.personaText?.trim()
        ? `（学生画像：${item.rehearsal.personaText.trim().slice(0, 100)}）`
        : ''
    }`,
    `主题：${plan?.topic ?? '未命名演练'}`,
    `总体：${report?.summary ?? '未生成总体评估。'}`,
  ];

  if (report?.gaps.length) {
    lines.push(`薄弱点：${report.gaps.slice(0, 3).join('；')}`);
  }
  if (report?.suggestions.length) {
    lines.push(`建议：${report.suggestions.slice(0, 3).join('；')}`);
  }

  lines.push('逐题：');
  for (const turn of item.turns) {
    const assessment = readAssessment(turn.evaluationJson);
    const answer = turn.answer?.trim()
      ? turn.answer.trim().slice(0, DIGEST_ANSWER_EXCERPT_CHARS)
      : '（未作答）';
    const issues = assessment?.issues.length
      ? `（${assessment.issues.slice(0, 2).join('；')}）`
      : '';
    lines.push(
      `- Q${turn.sequenceNo}${formatTurnKindSuffix(turn.kind, turn.followUpDepth)} ${turn.question.slice(0, 120)} → ${answer} → ${assessment?.level ?? formatTurnStatus(turn.status)}${issues}`,
    );
  }

  lines.push(`完整记录：${item.transcriptPath}`);
  return lines.join('\n');
}

/** Builds a one-line fallback for older rehearsals when the digest budget is tight. */
function renderCompactSection(item: RehearsalDigestItem): string {
  const plan = readPlan(item.rehearsal.planJson);
  const report = readReport(item.rehearsal.overallEvaluationJson);
  const summary = (report?.summary ?? '未生成总体评估。').slice(
    0,
    DIGEST_SUMMARY_CHARS,
  );
  return `- 演练 ${formatDate(item.rehearsal.endedAt ?? item.rehearsal.createdAt)}｜${plan?.topic ?? '未命名演练'}｜${summary}｜完整记录：${item.transcriptPath}`;
}

/** Reads the stored plan, returning null for malformed data. */
export function readPlan(planJson: string | null): RehearsalPlan | null {
  if (!planJson) return null;
  try {
    const value: unknown = JSON.parse(planJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RehearsalPlan;
  } catch {
    return null;
  }
}

/** Reads the stored overall report, returning null for malformed data. */
export function readReport(value: string | null): RehearsalReport | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RehearsalReport;
  } catch {
    return null;
  }
}

/** Reads one stored per-turn assessment. */
export function readAssessment(value: string | null): RehearsalAssessment | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as RehearsalAssessment;
  } catch {
    return null;
  }
}

function toBullets(values: readonly string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ['- 无'];
}

function formatDate(value: Date | string | null): string {
  if (!value) return '未知时间';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toISOString();
}

function formatEndReason(value: string | null): string {
  if (value === 'limit') return '达到 15 次提问上限';
  if (value === 'coverage') return '计划知识点已覆盖，提前结束';
  if (value === 'manual') return '用户手动结束';
  return value ?? '未结束';
}

function formatTurnKind(kind: string, depth: number): string {
  return kind === 'follow_up' ? `追问 ${depth}/2` : '基础题';
}

function formatTurnKindSuffix(kind: string, depth: number): string {
  return kind === 'follow_up' ? `（追问 ${depth}/2）` : '';
}

function formatTurnStatus(status: string): string {
  if (status === 'skipped') return '跳过';
  if (status === 'unanswered') return '未作答';
  if (status === 'failed') return '未完成评估';
  return '未评估';
}
