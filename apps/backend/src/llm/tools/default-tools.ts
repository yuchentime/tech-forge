/** Pi's built-in file tools enabled in every TeachForge LLM session. */
export const DEFAULT_LLM_TOOL_MODIFIERS = [
  '+read',
  '+edit',
  '+write',
] as const;

/** Prevent shell execution while allowing the built-in filesystem tools. */
export const EXCLUDED_LLM_TOOLS = ['bash'] as const;
