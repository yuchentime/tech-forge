import { parseKnowledgeCommand } from '../knowledge/knowledge-command';
import { parseDeepResearchCommand } from './deep-research-command';

/** Everything one user prompt says about retrieval and skill invocation. */
export interface ParsedTurnCommand {
  /** The turn must run the bundled deep-research skill. */
  research: boolean;
  /** The turn must retrieve knowledge chunks before the model runs. */
  knowledge: boolean;
  /** Prompt with every recognised leading command removed. */
  prompt: string;
}

/** Maximum leading commands accepted on one turn: knowledge and research. */
const MAX_LEADING_COMMANDS = 2;

/**
 * Strips the knowledge and deep-research commands from the front of a prompt.
 *
 * The desktop normally attaches one chip, but manual input can contain both in either order. Both
 * are leading-token switches, so this loop consumes at most two and never touches text after the
 * first ordinary word. Deep research always implies knowledge retrieval; the `knowledge` flag only
 * records whether the user also asked for it explicitly.
 */
export function parseTurnCommand(raw: string): ParsedTurnCommand {
  let text = raw;
  let research = false;
  let knowledge = false;

  for (let index = 0; index < MAX_LEADING_COMMANDS; index += 1) {
    const researchCommand = parseDeepResearchCommand(text);
    if (researchCommand.force) {
      research = true;
      text = researchCommand.prompt;
      continue;
    }

    const knowledgeCommand = parseKnowledgeCommand(text);
    if (knowledgeCommand.force) {
      knowledge = true;
      text = knowledgeCommand.prompt;
      continue;
    }
    break;
  }

  return { research, knowledge, prompt: text };
}
