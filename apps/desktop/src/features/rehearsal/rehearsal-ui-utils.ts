import type {
  AssessmentLevel,
  RehearsalEndReason,
  RehearsalStatus,
  RehearsalTurn,
} from './rehearsal-api';

/** Formats an ISO date for drill history and reports. */
export function formatRehearsalDate(value: string | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Returns the Chinese label for one assessment level. */
export function assessmentLabel(level: AssessmentLevel): string {
  if (level === 'correct') return '正确';
  if (level === 'partial') return '部分掌握';
  if (level === 'incorrect') return '未掌握';
  return '证据不足';
}

/** Returns a theme-safe class set for one assessment level. */
export function assessmentTone(level: AssessmentLevel): string {
  if (level === 'correct') return 'bg-emerald-50 text-emerald-800';
  if (level === 'partial') return 'bg-amber-50 text-amber-800';
  if (level === 'incorrect') return 'bg-rose-50 text-rose-800';
  return 'bg-stone-100 text-stone-700';
}

/** Returns the Chinese label for a rehearsal end reason. */
export function endReasonLabel(reason: RehearsalEndReason | null): string {
  if (reason === 'manual') return '手动结束';
  if (reason === 'limit') return '达到 15 次提问上限';
  if (reason === 'coverage') return '计划知识点已覆盖';
  if (reason === 'failed') return '未完成';
  return '';
}

/** Returns whether a rehearsal status is still active. */
export function isActiveStatus(status: RehearsalStatus): boolean {
  return (
    status === 'preparing' ||
    status === 'awaiting_answer' ||
    status === 'evaluating' ||
    status === 'preparing_next' ||
    status === 'reporting'
  );
}

/** Returns the Chinese label for a turn status. */
export function turnStatusLabel(turn: RehearsalTurn): string {
  if (turn.status === 'skipped') return '已跳过';
  if (turn.status === 'unanswered') return '未作答';
  if (turn.status === 'failed') return '未完成评估';
  if (turn.status === 'evaluated') return '已评估';
  if (turn.status === 'answer_saved') return '评估中';
  return '等待回答';
}

/** Clips text for compact history/report rows. */
export function truncateText(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, limit - 1).join('')}…`;
}
