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
  // The transcript tags students by name, so the roster pairs each name with the id the answer uses.
  return `- ${student.name}（${id}）：${student.persona}`;
}).join('\n');

/** Point status bar the director uses to decide whether the discussion is sufficient. */
export interface DirectorPointContext {
  label: string | null;
  turns: number;
  maxTurns: number;
}

/** Point facts the student needs for this turn. */
export interface StudentPointContext {
  label: string | null;
  turns: number;
  forceClose: boolean;
  maxTurns: number;
}

/** Parsed director answer: who speaks, the point status bar, and whether to close the point. */
export interface DirectorDecision {
  student: unknown;
  pointLabel: string | null;
  done: boolean;
  /** Student nominated to open the next knowledge point; used only when this turn closes. */
  nextStudent: unknown;
  /** Optional short focus for that next question. */
  nextFocus: string | null;
}

/**
 * Fixed classroom director prompt.
 *
 * It replaces Pi's coding-agent prompt outright (`systemPrompt`) instead of appending to it: a
 * classroom turn never touches the workspace, and leftover file/tool instructions would invite
 * calls this session cannot serve. The director both picks the next student and decides whether the
 * current knowledge point has been discussed enough.
 */
export const CLASSROOM_SYSTEM_PROMPT = [
  '你是一位课堂模拟导演，负责判断当前知识点的讨论是否足够，并决定下一句由哪名学生回应。',
  '',
  '## 课堂设定',
  '班里有三名学生：',
  STUDENT_ROSTER,
  '',
  '## 选人规则',
  '- 在没有任何学生回答记录的情况下，随机挑选其中一人。',
  '- 根据学生的性格设定和上下文语境挑选本次回答人选。性格主动的学生权重稍高，并允许追问。',
  '- 不是每一次都必须换人，结合语境选择同一个人还是其他人。',
  '- 如果老师指定了目标对象，则返回目标对象学生。',
  '- 禁止单调的按次序选人；这会破坏沉浸感，也容易打断知识点深入理解的节奏。',
  '',
  '## 知识点状态栏',
  '输入会给出当前知识点标签 `pointLabel` 与该知识点已有的学生发言次数。',
  '- 老师开启新的讲解内容时，更新 `pointLabel`，用不超过 20 字概括；否则保持原标签。',
  '- 判断老师与学生关于这个知识点的讨论是否已经足够结束：老师回答清晰、学生的核心疑问已经解决时，`done=true`；还需要确认时 `done=false`。',
  '- 学生已发言达到 3 次时，默认 `done=true`；只有老师最新消息明显没有回应学生的问题，或老师明确表示还要展开时才 `done=false`。',
  '- 老师最新消息是明确的回答/补充且没有引入新内容时，优先 `done=true`，不要因为学生还能继续提问就无限延长。',
  '- 最多 5 次学生发言，达到上限系统会强制收束。',
  '- 收束时仍要选一名学生，由该学生做确认而不是继续提问。',
  '',
  '## 收束后的下一问',
  '每轮都要提名一名负责开启下一个知识点的学生，即使本轮不收束（代码会在收束时使用）。',
  '- `nextStudent` 必须是 su/lin/gu 中与 `student` 不同的人；根据性格互补选择，让下一问提供不同视角。',
  '- `nextFocus` 用不超过 20 字给出建议的新概念；不确定时可留空。',
  '- 不要提名本轮收束的学生。',
  '',
  '## 输出格式',
  '只输出一个 JSON 对象，不要 Markdown、不要解释、不要输出其他文字：',
  '{"student":"su","pointLabel":"缓存雪崩的触发条件","done":false,"nextStudent":"lin","nextFocus":"重试与唯一 ID 的一致性"}',
  'student/nextStudent 只能是 su、lin、gu 之一；pointLabel 保持或更新当前知识点；done 是布尔值。',
].join('\n');

/** Builds the director's user message: the status bar plus the transcript. */
export function buildDirectorPrompt(
  transcript: string,
  speakerSequence: string,
  point: DirectorPointContext,
): string {
  return [
    '## 知识点状态栏',
    `pointLabel：${point.label ?? '（尚未开始）'}`,
    `学生已发言：${point.turns}/${point.maxTurns}`,
    point.turns >= point.maxTurns
      ? '已达到上限：本轮 done 必须为 true，学生只做确认。'
      : point.turns >= 3
        ? '已进行 3 次以上：除非老师的回答明显没有回应学生，否则本轮 done 必须为 true。'
        : '讨论仍在进行：判断是否已经足够结束。',
    '',
    '## 最近学生发言顺序（旧→新）',
    speakerSequence || '（还没有学生发言）',
    '',
    '## 当前课堂记录',
    transcript,
    '',
    '请判断这个知识点的讨论是否足够结束，并选出下一名学生，按约定输出 JSON。',
  ].join('\n');
}

/** Builds the prompt for the student who opens the next knowledge point after a close. */
export function buildNextPointQuestionPrompt(input: {
  transcript: string;
  studentName: string;
  oldLabel: string | null;
  nextFocus: string | null;
}): string {
  return [
    '## 当前课堂记录',
    input.transcript,
    '',
    '## 上一个知识点',
    input.oldLabel ?? '（未命名）',
    '',
    '## 本轮任务',
    '上一个知识点已经结束。现在由你开启下一个知识点：',
    input.nextFocus
      ? `建议聚焦：${input.nextFocus}`
      : '请从课程内容中选择一个相关的新概念。',
    '',
    '要求：',
    '- 从你的性格视角提出一个问题，开启新的讨论；',
    '- 不要重复上一个知识点，不要编造课程中没有的事实；',
    '- 只输出你的问题，不要解释。',
  ].join('\n');
}

/** Builds the student's user message: the transcript, whose turn it is, and the point task. */
export function buildStudentPrompt(
  transcript: string,
  studentName: string,
  point: StudentPointContext,
): string {
  const task = point.forceClose
    ? `讨论已经足够：不要再提问。用一到两句话确认你对「${point.label ?? '这一点'}」理解了什么，并请老师继续下一个知识点。`
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

/** Parses the director's JSON answer, validating the status bar. */
export function parseDirectorDecision(text: string): DirectorDecision {
  try {
    const value = parseJsonObject(text);
    const record = value as Record<string, unknown>;
    const pointLabel =
      typeof record.pointLabel === 'string'
        ? truncateChars(record.pointLabel.trim(), 40)
        : null;
    const nextFocus =
      typeof record.nextFocus === 'string'
        ? truncateChars(record.nextFocus.trim(), 40)
        : null;
    return {
      student: record.student,
      pointLabel,
      done: record.done === true,
      nextStudent: record.nextStudent,
      nextFocus,
    };
  } catch (error) {
    throw new Error(
      `Classroom director returned an unusable answer: ${
        error instanceof Error ? error.message : String(error)
      } ${JSON.stringify(truncateChars(text.trim(), MAX_QUOTED_OUTPUT_CHARS))}`,
    );
  }
}
