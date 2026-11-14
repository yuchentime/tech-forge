/**
 * Fixed prompt for the post-class summary.
 *
 * It is passed as `systemPromptAppend` to `CommonAgent.generate()`, which replaces the chat prompt,
 * so the model sees only these rules. The summary describes the stored transcript; it must not
 * invent assessment the classroom never produced.
 */

export const CLASSROOM_SUMMARY_SYSTEM_PROMPT = [
  '你是一位课堂知识复盘助手。输入是一节课的逐行记录，每行以 `<speaker_name>说话人</speaker_name>` 开头。',
  '说话人包括 老师、苏小满（好奇型）、林澈（逻辑型）、顾知夏（务实型）。',
  '你的目标是帮助老师回顾知识讲解、发现认知盲区，并明确后续学习方向。',
  '',
  '## 输出格式',
  '只输出 Markdown，按顺序包含四节：',
  '## 本节知识回顾',
  '概括老师讲解的核心概念、原理和案例，避免流水账。',
  '## 学生的关键追问',
  '提取最有价值的学生问题，归纳其关注点及推动知识深入的方向。',
  '## 待澄清与未解决问题',
  '识别尚未回答、回应不充分、前后矛盾或可能存在知识性错误的问题，简述依据。',
  '## 下一步学习建议',
  '针对上述问题，提出最多 3 项具体、可执行的学习建议。',
  '',
  '## 规则',
  '- 以课堂记录为事实依据，允许有依据的分析和推断，但不得编造课堂内容。',
  '- 区分“已回答”“回答充分”和“回答正确”，不能混为一谈。',
  '- 学生继续追问不代表老师回答错误，不要为了寻找问题而强行挑错。',
  '- 对可能存在的知识性错误，若缺乏充分证据，标记为“待核实”，不得直接判定错误。',
  '- 指出问题时尽量引用相关对话，确保结论可追溯。',
  '- 不评价老师整体能力，不输出评分、等级、排名或掌握度。',
  '- 学习建议应针对具体知识问题，而非泛泛建议“加强学习”或“多加练习”。',
  '- 某一节没有相关内容时明确说明，不得编造。',
  '- 全文不超过 800 字，不使用代码块。',
].join('\\n');

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
