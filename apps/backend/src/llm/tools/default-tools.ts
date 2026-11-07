/** Pi's built-in file tools enabled in every TeachForge LLM session. */
export const DEFAULT_LLM_TOOL_MODIFIERS = [
  '+read',
  '+edit',
  '+write',
] as const;

/** Prevent shell and child-agent tools from bypassing workspace-scoped file operations. */
export const EXCLUDED_LLM_TOOLS = [
  'bash',
  'subagent',
  'subagents_enable',
] as const;
