/** Lifecycle states the activity list can render for one tool call. */
export type ToolActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Verbs that describe each built-in file tool in ordinary user language. */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  grep: '搜索',
  web_search: '搜索网页',
  web_fetch: '抓取网页',
  memory_write: '记录记忆',
  memory_search: '搜索记忆',
  memory_list: '读取记忆',
};

/** Caps the query or URL shown next to an activity row. */
const TOOL_TARGET_MAX_CHARS = 120;

/** Describes one tool call as a plain-language action plus its visible target. */
export interface ToolActivityDescription {
  /** Plain-language action including lifecycle tense; never the raw tool name. */
  action: string;
  /** Text the tool searched for, or the web query/URL. */
  pattern?: string;
  /** Last path segment only, so the row never exposes the surrounding directories. */
  fileName?: string;
}

/**
 * Turns one raw tool call into the wording shown in the activity list.
 * Only `pattern` and `path` are read, so no other argument can reach the UI.
 */
export function describeToolActivity(
  toolName: string,
  status: ToolActivityStatus,
  args: unknown,
): ToolActivityDescription {
  const pattern = getToolTarget(toolName, args);
  const fileName = getFileName(getStringArg(args, 'path'));

  return {
    action: getToolAction(toolName, status),
    ...(pattern ? { pattern } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

/** Maps a tool and its lifecycle state to a plain-language action. */
function getToolAction(toolName: string, status: ToolActivityStatus): string {
  const verb = TOOL_VERBS[toolName] ?? '处理';
  if (status === 'running') return `正在${verb}`;
  if (status === 'completed') return `已${verb}`;
  if (status === 'failed') return `${verb}失败`;
  // 取消不区分工具，避免“已取消搜索”这类生硬组合。
  return '已取消';
}

/** Selects the one visible target each tool may expose, and nothing else. */
function getToolTarget(toolName: string, args: unknown): string {
  if (toolName === 'grep') return getStringArg(args, 'pattern');
  if (toolName === 'web_search') {
    return clipTarget(getStringArg(args, 'query'));
  }
  if (toolName === 'web_fetch') {
    return clipTarget(getStringArg(args, 'url'));
  }
  return '';
}

/** Keeps a long query or URL from taking over the activity row. */
function clipTarget(value: string): string {
  const characters = Array.from(value);
  return characters.length > TOOL_TARGET_MAX_CHARS
    ? `${characters.slice(0, TOOL_TARGET_MAX_CHARS - 1).join('')}…`
    : value;
}

/** Reads one named string argument and ignores every other tool field. */
function getStringArg(args: unknown, key: string): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return '';
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** Reduces a path to its final segment and drops root or relative placeholders. */
function getFileName(filePath: string): string {
  const segments = filePath
    .split(/[\\/]/u)
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return segments.at(-1) ?? '';
}
