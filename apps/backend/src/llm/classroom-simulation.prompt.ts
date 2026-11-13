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

/**
 * Fixed classroom director prompt.
 *
 * It replaces Pi's coding-agent prompt outright (`systemPrompt`) instead of appending to it: a
 * classroom turn never touches the workspace, and leftover file/tool instructions would invite
 * calls this session cannot serve. The only decision this model makes is which student speaks.
 */
export const CLASSROOM_SYSTEM_PROMPT = [
  '你是一位课堂模拟导演，负责决定下一句由哪名学生回应老师的讲解。',
  '',
  '## 课堂设定',
  '班里有三名学生：',
  STUDENT_ROSTER,
  '',
  '## 选人规则',
  '- 在没有任何学生回答记录的情况下，随机挑选其中一人。',
  '- 根据学生的性格设定和上下文语境挑选本次回答人选。不过，性格主动的学生，会获得相对较高的权重，并且允许追问，但追问不能超过 3 次，否则必须换人。',
  '- 不是每一次都必须换人，结合上下文语境，选择同一个人还是其他人。',
  '- 如果老师指定了目标对象，则返回目标对象学生。',
  '- 禁止单调的按次序选人，这会破坏沉浸感，也容易打断对一个知识点深入理解的节奏。',
  '',
  '## 输出格式',
  '只输出一个 JSON 对象，不要 Markdown、不要解释、不要输出其他文字：',
  '{"student":"su"}',
  'student 只能是 su、lin、gu 之一。',
].join('\n');

/** Builds the director's user message: transcript plus the un-truncated speaking order. */
export function buildDirectorPrompt(
  transcript: string,
  speakerSequence: string,
): string {
  return [
    '## 最近学生发言顺序（旧→新）',
    speakerSequence || '（还没有学生发言）',
    '',
    '## 当前课堂记录',
    transcript,
    '',
    '请选出接下来发言的学生，并按约定输出 JSON。',
  ].join('\n');
}

/** Builds the student's user message: the transcript plus whose turn it is. */
export function buildStudentPrompt(
  transcript: string,
  studentName: string,
): string {
  return [
    '## 当前课堂记录',
    transcript,
    '',
    `现在轮到你（${studentName}）回应老师最后一条讲解，只输出你说的话。`,
  ].join('\n');
}

/** Parses the director's JSON answer and returns its `student` field. */
export function parseDirectorSelection(text: string): unknown {
  try {
    const value = parseJsonObject(text);
    return (value as Record<string, unknown>).student;
  } catch (error) {
    throw new Error(
      `Classroom director returned an unusable answer: ${
        error instanceof Error ? error.message : String(error)
      } ${JSON.stringify(truncateChars(text.trim(), MAX_QUOTED_OUTPUT_CHARS))}`,
    );
  }
}
