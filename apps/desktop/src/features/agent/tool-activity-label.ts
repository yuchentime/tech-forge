/** Lifecycle states the activity list can render for one tool call. */
export type ToolActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Verbs that describe each built-in file tool in ordinary user language. */
const TOOL_VERBS: Readonly<Record<string, string>> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  grep: '搜索',
  // pi-memory 扩展注册的工具；它们没有 path 参数，只借用同一套动词措辞。
  memory_write: '记录记忆',
  memory_read: '读取记忆',
  memory_search: '搜索记忆',
  memory_forget: '删除记忆',
  memory_restore: '恢复记忆',
  memory_status: '检查记忆',
  scratchpad: '更新便签',
};

/** Describes one tool call as a plain-language action plus its visible target. */
export interface ToolActivityDescription {
  /** Plain-language action including lifecycle tense; never the raw tool name. */
  action: string;
  /** Text the tool searched for, present only for grep. */
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
  const pattern = toolName === 'grep' ? getStringArg(args, 'pattern') : '';
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
