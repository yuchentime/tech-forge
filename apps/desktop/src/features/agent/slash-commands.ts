/**
 * The slash commands the composer can attach and the chat bubble can replay.
 *
 * Kept in a plain module (no React) so the chat adapter can map a chip to its persisted id without
 * importing the composer UI, and so the renderer and the backend literally share one list of ids.
 */

/** Visual identity of one slash command in the menu and the composer chip. */
export type SlashCommandIcon = 'database' | 'research';

/** Stable command ids; the backend stores these verbatim in `contextRefsJson.commands`. */
export type SlashCommandId = 'knowledge' | 'research';

/** One entry offered by the composer's slash menu. */
export interface SlashCommandItem {
  id: SlashCommandId;
  label: string;
  description: string;
  /** Command text the adapter prepends when the chip is present. */
  insert: string;
  icon: SlashCommandIcon;
}

/**
 * The knowledge command.
 *
 * This string is the protocol: the backend parses exactly it (plus the older aliases) from the prompt
 * prefix. Renaming it here without updating `knowledge-command.ts` disables retrieval silently — the
 * command simply never fires and the raw text reaches the model — so the two are kept in the same
 * wording and both are covered by tests.
 */
export const KNOWLEDGE_SLASH_COMMAND: SlashCommandItem = {
  id: 'knowledge',
  label: '查询资料库',
  description: '查询本地上传的资料库',
  insert: '/查询资料库 ',
  icon: 'database',
};

/**
 * The deep-research command.
 *
 * `/探索主题` is also a backend protocol: `deep-research-command.ts` parses exactly this token and
 * loads the bundled `deep-research` Pi skill. The backend always retrieves knowledge first; the skill
 * may then search the web when useful, and writes a Markdown document and an SVG knowledge map into
 * the conversation workspace.
 */
export const DEEP_RESEARCH_SLASH_COMMAND: SlashCommandItem = {
  id: 'research',
  label: '探索主题',
  description: '输入一个主题，AI 将结合资料库与网络深入研究并生成知识地图',
  insert: '/探索主题 ',
  icon: 'research',
};

/** Every command the composer offers, in menu order. */
export const SLASH_COMMANDS: readonly SlashCommandItem[] = [
  KNOWLEDGE_SLASH_COMMAND,
  DEEP_RESEARCH_SLASH_COMMAND,
];

/** Finds the menu entry behind a stored chip command, for labels and icons. */
export function getSlashCommand(command: string | null): SlashCommandItem | null {
  if (!command) return null;
  return SLASH_COMMANDS.find((item) => item.insert.trim() === command) ?? null;
}

/** Finds the menu entry behind a persisted command id, for restored history chips. */
export function getSlashCommandById(id: SlashCommandId): SlashCommandItem | null {
  return SLASH_COMMANDS.find((item) => item.id === id) ?? null;
}
