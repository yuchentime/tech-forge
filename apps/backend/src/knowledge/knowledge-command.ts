/** Slash command that forces knowledge-base retrieval for exactly one turn. */
export const KNOWLEDGE_COMMAND = '/查询知识库';

/**
 * Shorter alias kept for prompts written before the composer menu existed.
 * Longer commands are matched first, so this can never shadow the canonical one.
 */
export const KNOWLEDGE_COMMAND_ALIAS = '/知识库';

const KNOWLEDGE_COMMANDS = [KNOWLEDGE_COMMAND, KNOWLEDGE_COMMAND_ALIAS] as const;

/** One prompt split into the knowledge switch and the question the model must answer. */
export interface ParsedKnowledgeCommand {
  /** True when the turn must retrieve from the knowledge base before answering. */
  force: boolean;
  /** Prompt with the command removed; unchanged when `force` is false. */
  prompt: string;
}

/**
 * Reads the leading knowledge command from a user prompt.
 *
 * Retrieval is an explicit user decision: only the literal leading command turns it on. A bare
 * command with no question, a look-alike token such as `/知识库化`, or the command in the middle of
 * the text stay plain prompts — silently dropping text or silently skipping retrieval would both be
 * worse than doing nothing.
 */
export function parseKnowledgeCommand(raw: string): ParsedKnowledgeCommand {
  const text = raw.trimStart();
  for (const command of KNOWLEDGE_COMMANDS) {
    if (!text.startsWith(command)) continue;
    const remainder = text.slice(command.length);
    // A separator is required so longer words that merely start with the command are not swallowed.
    if (remainder !== '' && !/^\s/.test(remainder)) continue;
    const prompt = remainder.trim();
    // A bare command has nothing to search for; keep the text as typed instead of erasing it.
    if (prompt === '') return { force: false, prompt: raw };
    return { force: true, prompt };
  }
  return { force: false, prompt: raw };
}
