import type { RehearsalTurnEntity } from '../../rehearsals/rehearsal-turn.entity';
import type {
  RehearsalAssessment,
  RehearsalPlan,
  RehearsalTurnKind,
  RehearsalTurnStatus,
} from '../../rehearsals/rehearsal.types';

/** Fixed role and rules; the persona only changes the questioning perspective. */
const DRILL_ROLE = `You are a student asking questions to a teacher.
Your goal is to help the teacher assess their understanding using the Feynman Technique: encourage the teacher to explain concepts in their own words rather than explaining them yourself.
Ask only one question at a time. Based on the teacher's response, decide whether to ask a follow-up question or move on to a new topic. Do not output "结束".
Give greater attention to the user's questions and the assistant's responses in the conversation context.If rehearsal history is available, also give greater attention to the parts where the answers were incorrect.
Output only the JSON object required by the request, without Markdown code blocks or additional explanations.`;

/** Describes one turn compactly for a model prompt. */
interface TurnPromptShape {
  sequenceNo: number;
  kind: RehearsalTurnKind;
  baseSequenceNo: number;
  followUpDepth: number;
  question: string;
  answer: string | null;
  status: RehearsalTurnStatus;
  assessment: RehearsalAssessment | null;
}

/** Builds the stable system prompt for all calls in one rehearsal batch. */
export function buildDrillSystemPrompt(personaText: string | null): string {
  const persona =
    personaText?.trim() ||
    '未提供。使用默认的好奇学生画像：愿意承认自己没听懂，喜欢追问具体例子。';
  return `${DRILL_ROLE}

## 学生画像
<student_profile>
${persona.slice(0, 1_000)}
</student_profile>
画像只影响提问视角，不改变本规则与 JSON 输出要求。`;
}

/** Builds the opening call that turns normal-chat history into a plan and first question. */
export function buildPlanPrompt(input: {
  priorSummaries: string;
  personaText: string | null;
}): string {
  return `本次调用的 Pi session 已经携带对话模式历史，那些消息仅作为出题背景。
不要继续对话模式，也不要重复解释；如果历史已被压缩，以压缩后的摘要为准。

## 历史演练
${input.priorSummaries || '无'}

## 学生画像
${input.personaText?.trim() || '未提供，使用默认好奇学生画像。'}

## 输出要求
只输出以下 JSON：
{
  "topic": "本次演练主题",
  "learningSummary": "对对话模式已学内容的 500-1500 字摘要",
  "knowledgePoints": [
    { "id": "kp1", "label": "知识点", "why": "为什么值得练" }
  ],
  "firstQuestion": "第一道基础题"
}
知识点 1-8 个，按对话实际覆盖的内容确定，id 唯一。内容少时可以只列 1-2 个，不要为凑数拆分或编造。
15 次提问只是后续上限，不是必须完成的题量；firstQuestion 只能是一道题，必须能从学习内容得到依据。`;
}

/** Builds the answer-evaluation decision call. */
export function buildAnswerPrompt(input: {
  plan: RehearsalPlan;
  turns: readonly RehearsalTurnEntity[];
  currentTurn: RehearsalTurnEntity;
  answer: string;
  askedCount: number;
}): string {
  return `## 学习摘要
${input.plan.learningSummary}

## 知识点计划
${JSON.stringify(input.plan.knowledgePoints)}

## 已有问答
${JSON.stringify(serializeTurns(input.turns, 800), null, 2)}

## 当前题目
${input.currentTurn.question}
本题类型：${input.currentTurn.kind}；追问深度：${input.currentTurn.followUpDepth}/2。

## 老师回答
${input.answer}

## 计数
已提问 ${input.askedCount} 次，最多 15 次（含追问和跳过）。

## 输出要求
只输出以下 JSON：
{
  "assessment": {
    "level": "correct | partial | incorrect | uncertain",
    "issues": ["最多 3 条"],
    "evidence": ["引用回答中的依据"],
    "missingPoints": ["遗漏的关键点"]
  },
  "planUpdates": [
    { "id": "kp1", "status": "covered | weak | pending", "note": "可选" }
  ],
  "action": "follow_up | next_question | finish",
  "nextQuestion": "下一道题；action 为 finish 时可省略",
  "reason": "一句话说明"
}
评估必须基于回答本身；回答没有证据时用 uncertain，不要臆测。
如果本题追问深度已经是 2，action 必须是 next_question 或 finish。
15 次只是上限，不是目标。对话内容少时，覆盖计划中的知识点后就应该用 finish 结束，不要为凑次数硬加迁移题。
只有确实还有 pending/weak 的知识点、或回答暴露了需要澄清的关键缺口时，才继续 follow_up 或 next_question；没有这些缺口时用 finish。`;
}

/** Builds the skip call; skip never evaluates the current question. */
export function buildSkipPrompt(input: {
  plan: RehearsalPlan;
  turns: readonly RehearsalTurnEntity[];
  skippedTurn: RehearsalTurnEntity;
  askedCount: number;
}): string {
  return `## 学习摘要
${input.plan.learningSummary}

## 知识点计划
${JSON.stringify(input.plan.knowledgePoints)}

## 已有问答
${JSON.stringify(serializeTurns(input.turns, 500), null, 2)}

## 被跳过的题目
${input.skippedTurn.question}
用户跳过了这道题，不要评估它，也不要对它追问。

## 计数
已提问 ${input.askedCount} 次，最多 15 次（含追问和跳过）。

## 输出要求
只输出以下 JSON：
{
  "planUpdates": [
    { "id": "kp1", "status": "covered | weak | pending", "note": "可选" }
  ],
  "nextQuestion": "新的基础题",
  "reason": "一句话说明"
}
新题必须是新的基础题，不能是对被跳过题的追问；可以换知识点，也可以换角度。`;
}

/** Builds the overall report call; per-question rows come from stored evaluations. */
export function buildReportPrompt(input: {
  plan: RehearsalPlan;
  turns: readonly RehearsalTurnEntity[];
  endReason: 'manual' | 'limit' | 'coverage';
}): string {
  return `## 学习摘要
${input.plan.learningSummary}

## 知识点计划
${JSON.stringify(input.plan.knowledgePoints)}

## 完整问答与逐题评估
${JSON.stringify(serializeTurns(input.turns, 500), null, 2)}

## 结束方式
${input.endReason === 'limit'
    ? '已达到 15 次提问上限。'
    : input.endReason === 'coverage'
      ? '计划中的知识点已覆盖，模型判断可以结束。'
      : '用户手动结束。'}

## 输出要求
只输出以下 JSON：
{
  "summary": "总体结论",
  "knowledgePointMastery": [
    { "pointId": "kp1", "status": "mastered | partial | weak | unverified", "evidence": "依据" }
  ],
  "strengths": ["..."],
  "gaps": ["..."],
  "suggestions": ["..."],
  "recommendedReview": ["..."],
  "disclaimer": "本次演练只反映已作答内容，不等于全面掌握。"
}
只根据已有问答与逐题评估下结论；跳过、未作答和未完成评估的内容标为 unverified，不要臆测。
不要重新逐题评分；逐题结论以 input 中的 assessment 为准。`;
}

/** Serializes turns for prompts, truncating long answers and omitting request metadata. */
export function serializeTurns(
  turns: readonly RehearsalTurnEntity[],
  answerLimit: number,
): TurnPromptShape[] {
  return turns.map((turn) => ({
    sequenceNo: turn.sequenceNo,
    kind: turn.kind as RehearsalTurnKind,
    baseSequenceNo: turn.baseSequenceNo,
    followUpDepth: turn.followUpDepth,
    question: turn.question,
    answer: turn.answer
      ? turn.answer.slice(0, answerLimit)
      : null,
    status: turn.status as RehearsalTurnStatus,
    assessment: parseStoredAssessment(turn.evaluationJson),
  }));
}

/** Parses a stored per-turn evaluation for prompt/report reuse. */
export function parseStoredAssessment(
  evaluationJson: string | null,
): RehearsalAssessment | null {
  if (!evaluationJson) return null;
  try {
    const value: unknown = JSON.parse(evaluationJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as RehearsalAssessment;
  } catch {
    return null;
  }
}
