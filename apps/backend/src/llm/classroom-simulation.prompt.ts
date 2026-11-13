import {
  CLASSROOM_STUDENT_IDS,
  CLASSROOM_STUDENTS,
} from '../lessons/classroom-students';
import { truncateChars } from '../lessons/transcript-format';
import { parseJsonObject } from './model-json';

/** Most recent transcript lines given to the director and the student. */
export const CLASSROOM_TRANSCRIPT_MESSAGE_LIMIT = 12;
/** Character budget for the rendered transcript, measured after escaping. */
export const CLASSROOM_TRANSCRIPT_CHAR_LIMIT = 4_000;
/** Longest raw model output quoted in an error message. */
const MAX_QUOTED_OUTPUT_CHARS = 200;

const STUDENT_ROSTER = CLASSROOM_STUDENT_IDS.map((id) => {
  const student = CLASSROOM_STUDENTS[id];
  return `- ${id}：${student.name}（${student.persona}）`;
}).join('\n');

/** Point facts the director needs before deciding who speaks next. */
export interface DirectorPointContext {
  label: string | null;
  turns: number;
  closed: boolean;
  maxTurns: number;
}

/** Point facts the student needs for this turn. */
export interface StudentPointContext {
  label: string | null;
  turns: number;
  forceClose: boolean;
  maxTurns: number;
}

/** Parsed director answer: who speaks, and whether the teacher started a new point. */
export interface DirectorDecision {
  student: unknown;
  mode: 'new' | 'continue';
  pointLabel: string | null;
}

/**
 * Fixed classroom director prompt.
 *
 * It replaces Pi's coding-agent prompt outright (`systemPrompt`) instead of appending to it: a
 * classroom turn never touches the workspace, and leftover file/tool instructions would invite
 * calls this session cannot serve. Besides picking a student, the director is the only model that
 * decides whether the teacher moved to a new knowledge point.
 */
export const CLASSROOM_SYSTEM_PROMPT = [
  '你是一位课堂模拟导演，负责判断知识点是否继续，并决定下一句由哪名学生回应。',
  '',
  '## 课堂设定',
  '班里有三名学生：',
  STUDENT_ROSTER,
  '',
  '## 选人规则',
  '- 在没有任何学生回答记录的情况下，随机挑选其中一人。',
  '- 根据学生的性格设定和上下文语境挑选本次回答人选。性格主动的学生权重稍高，并允许追问，但同一知识点达到上限后必须收束。',
  '- 不是每一次都必须换人，结合语境选择同一个人还是其他人。',
  '- 如果老师指定了目标对象，则返回目标对象学生。',
  '- 禁止单调的按次序选人；这会破坏沉浸感，也容易打断知识点深入理解的节奏。',
  '- 当前知识点需要收束时，优先选择最近一次提问的学生来完成确认。',
  '',
  '## 知识点规则',
  '- 老师引入新的讲解内容（新的概念、新的问题）时，mode="new"，并用不超过 20 字概括 pointLabel。',
  '- 老师继续回答当前知识点时，mode="continue"。',
  '- 当前知识点已收束或学生发言达到上限时，mode 必须为 continue，本轮只让学生确认理解。',
  '- 不要为了换人而把同一知识点的普通追问标记为 new；只有老师真正开启新内容时才重置。',
  '',
  '## 输出格式',
  '只输出一个 JSON 对象，不要 Markdown、不要解释、不要输出其他文字：',
  '{"student":"su","mode":"continue","pointLabel":null}',
  'student 只能是 su、lin、gu 之一；mode 只能是 new 或 continue；mode 为 new 时 pointLabel 必填。',
].join('\n');

/** Builds the director's user message: current point state plus the transcript. */
export function buildDirectorPrompt(
  transcript: string,
  speakerSequence: string,
  point: DirectorPointContext,
): string {
  const state = point.closed
    ? '已收束：本轮只确认，不再提问'
    : point.turns >= point.maxTurns
      ? '已达上限：本轮必须收束'
      : '进行中';
  return [
    '## 知识点状态',
    `当前知识点：${point.label ?? '（尚未开始）'}`,
    `学生已发言：${point.turns}/${point.maxTurns}`,
    `状态：${state}`,
    '',
    '## 最近学生发言顺序（旧→新）',
    speakerSequence || '（还没有学生发言）',
    '',
    '## 当前课堂记录',
    transcript,
    '',
    '请判断老师这条消息是开启新知识点还是继续当前知识点，并选出下一名学生，按约定输出 JSON。',
  ].join('\n');
}

/** Builds the student's user message: the transcript, whose turn it is, and the point task. */
export function buildStudentPrompt(
  transcript: string,
  studentName: string,
  point: StudentPointContext,
): string {
  const task = point.forceClose
    ? `本轮是收束：不要再提问。用一到两句话确认你对「${point.label ?? '这一点'}」理解了什么，用通过结束语表达。`
    : '正常回应老师；最多提出一个疑点，不要重复已经问过的问题。';
  return [
    '## 当前课堂记录',
    transcript,
    '',
    '## 本轮知识点',
    `${point.label ?? '（新课）'}（学生已发言 ${point.turns}/${point.maxTurns} 次）`,
    '',
    '## 本轮要求',
    task,
    '',
    `现在轮到你（${studentName}）回应老师最后一条讲解，只输出你说的话。`,
  ].join('\n');
}

/** Parses the director's JSON answer, validating the point mode. */
export function parseDirectorDecision(text: string): DirectorDecision {
  try {
    const value = parseJsonObject(text);
    const record = value as Record<string, unknown>;
    const mode = record.mode === 'new' ? 'new' : 'continue';
    const pointLabel =
      typeof record.pointLabel === 'string'
        ? truncateChars(record.pointLabel.trim(), 40)
        : null;
    return { student: record.student, mode, pointLabel };
  } catch (error) {
    throw new Error(
      `Classroom director returned an unusable answer: ${
        error instanceof Error ? error.message : String(error)
      } ${JSON.stringify(truncateChars(text.trim(), MAX_QUOTED_OUTPUT_CHARS))}`,
    );
  }
}
