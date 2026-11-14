import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Preserves a custom tool's parameter schema while widening its callback types for Pi's mixed
 * `customTools` array. Pi's `defineTool()` is a runtime identity function, so this type-only
 * equivalent avoids a CommonJS `require()` of the ESM-only Pi package during backend startup.
 */
export function defineCustomTool<
  TParams extends TSchema,
  TDetails = unknown,
  TState = any,
>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
  return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}
