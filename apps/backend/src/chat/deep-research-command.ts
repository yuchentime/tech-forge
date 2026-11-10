/**
 * Slash command that turns one ordinary chat turn into a knowledge-base deep research run.
 *
 * The string must match the desktop composer (`SlashCommandMenu.insert`). A mismatch is silent:
 * the backend would treat the turn as a normal question while the UI still shows a research chip.
 * The parser tests and the composer constant are the two sides of that protocol.
 */
export const DEEP_RESEARCH_COMMAND = '/探索主题';

/**
 * Pi skill loaded for a research turn.
 *
 * The skill owns the document and knowledge-map procedure; the backend only decides when to load
 * it. Keeping the name here also means a renamed skill fails loudly in `LlmService` instead of
 * sending the literal `/skill:...` text to the model.
 */
export const DEEP_RESEARCH_SKILL_NAME = 'deep-research';

/** One prompt split into the research switch and the topic the user typed. */
export interface ParsedDeepResearchCommand {
  /** True when the turn must retrieve knowledge and run the deep-research skill. */
  force: boolean;
  /** Prompt with the command removed; unchanged when `force` is false. */
  prompt: string;
}

/**
 * Reads the leading deep-research command from a user prompt.
 *
 * Like the knowledge command, only a literal leading token followed by whitespace counts. A bare
 * command, `/探索主题化`, or the command in the middle of a sentence stays plain text: silently
 * dropping text or silently starting a long research run would both be worse than doing nothing.
 */
export function parseDeepResearchCommand(raw: string): ParsedDeepResearchCommand {
  const text = raw.trimStart();
  if (!text.startsWith(DEEP_RESEARCH_COMMAND)) {
    return { force: false, prompt: raw };
  }
  const remainder = text.slice(DEEP_RESEARCH_COMMAND.length);
  if (remainder !== '' && !/^\s/.test(remainder)) {
    return { force: false, prompt: raw };
  }
  const prompt = remainder.trim();
  if (prompt === '') return { force: false, prompt: raw };
  return { force: true, prompt };
}
