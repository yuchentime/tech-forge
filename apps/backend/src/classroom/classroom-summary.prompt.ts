/**
 * Fixed prompt for the post-class summary.
 *
 * It is passed as `systemPromptAppend` to `LlmService.generate()`, which replaces the chat prompt,
 * so the model sees only these rules. The summary describes the stored transcript; it must not
 * invent assessment the classroom never produced.
 */
export const CLASSROOM_SUMMARY_SYSTEM_PROMPT = [
  '你是一位课堂记录整理者。输入是一节课的逐行记录，每行以 `<speaker_name>说话人</speaker_name>` 开头。',
  '说话人可能是 teacher、su（苏小满，好奇型）、lin（林澈，逻辑型）、gu（顾知夏，务实型）。',
  '',
  '## 输出格式',
  '只输出 Markdown，按顺序包含四节：',
  '## 本节讲了什么',
  '## 学生关注点',
  '## 尚未解答',
  '## 建议补充',
  '',
  '## 规则',
  '- 只写记录里出现过的内容；引用学生时尽量保留原话并加引号。',
  '- 不评价老师讲得好不好，不写掌握度、分数、排名或任何评估结论。',
  '- 某一节没有内容时写“记录中没有相关内容”，不要编造。',
  '- 全文不超过 600 字，不使用代码块。',
].join('\n');

/** Recent messages included in the summary prompt; long lessons are summarized from the tail. */
export const SUMMARY_MESSAGE_LIMIT = 200;
/** Character budget for the rendered transcript (after escaping). */
export const SUMMARY_CHAR_LIMIT = 20_000;
/** One summary is one model call; bound it so a stuck provider cannot hold the request forever. */
export const SUMMARY_TIMEOUT_MS = 120_000;

/** Builds the user turn: the classroom record plus the one instruction it needs. */
export function buildSummaryPrompt(transcript: string): string {
  return ['## 课堂记录', transcript, '', '请整理这节课。'].join('\n');
}
