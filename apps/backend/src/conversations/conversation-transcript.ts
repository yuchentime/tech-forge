import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent';

/** Defines the Pi message shape stored in one ordered MessageEntity row. */
export interface PersistedPiMessage {
  format: 'teachforge-pi-message-v1';
  message: SessionMessageEntry['message'];
}

/** Defines durable progress for one tool execution row. */
export interface PersistedToolExecution {
  format: 'teachforge-tool-execution-v1';
  toolCallId: string;
  toolName: string;
  parentToolCallId?: string;
  displayPath?: string;
  /** Safe grep pattern kept for the history label; never the full argument object. */
  displayPattern?: string;
  /** 1-based first line requested by `read`; absent when the call named no window. */
  displayOffset?: number;
  /** Requested line count for `read`; absent when the call named no limit. */
  displayLimit?: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  durationMs?: number;
  partialResult?: unknown;
  result?: unknown;
}

/**
 * Keeps the only tool arguments a tool-execution row may persist: a path, the
 * grep search pattern, and a read window. Every other argument stays out of storage.
 */
export function getToolDisplayFields(
  toolName: string,
  args: unknown,
): {
  displayPath?: string;
  displayPattern?: string;
  displayOffset?: number;
  displayLimit?: number;
} {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {};
  }

  const record = args as Record<string, unknown>;
  const offset = record.offset;
  const limit = record.limit;
  const readOffset =
    toolName === 'read' &&
    typeof offset === 'number' &&
    Number.isSafeInteger(offset) &&
    offset >= 0
      ? { displayOffset: offset }
      : {};
  const readLimit =
    toolName === 'read' &&
    typeof limit === 'number' &&
    Number.isSafeInteger(limit) &&
    limit >= 1
      ? { displayLimit: limit }
      : {};
  return {
    ...(typeof record.path === 'string' ? { displayPath: record.path } : {}),
    ...(toolName === 'grep' && typeof record.pattern === 'string'
      ? { displayPattern: record.pattern }
      : {}),
    ...readOffset,
    ...readLimit,
  };
}

/** Names why one Pi tool execution ended as an error, without keeping its text. */
type ToolFailureReason =
  | 'output_limit_truncated'
  | 'invalid_arguments'
  | 'aborted'
  | 'blocked'
  | 'tool_not_found'
  | 'file_policy_denied'
  | 'tool_error';

/**
 * Classifies a failed Pi tool result into one stable reason.
 *
 * Pi rejects some calls before any tool code runs: a response that hit the output-token limit is
 * never executed, and malformed arguments fail validation. Those failures produce no filesystem
 * diagnostic, so their only signal is the result text; it is matched against the SDK's fixed
 * rejection messages and never logged, because a validation message repeats the raw arguments.
 * File-operation failures keep their own `llm.file_tool.operation.failed` details.
 */
export function getToolFailureReason(result: unknown): ToolFailureReason {
  const text = getToolResultHead(result);
  if (
    text.startsWith('Tool call "') &&
    text.includes('the response hit the output token limit')
  ) {
    return 'output_limit_truncated';
  }
  if (
    text.startsWith('Validation failed for tool "') ||
    text.startsWith('Invalid arguments for tool "')
  ) {
    return 'invalid_arguments';
  }
  if (text === 'Operation aborted') return 'aborted';
  if (text.startsWith('Tool execution was blocked')) return 'blocked';
  if (text.startsWith('Agent file access was denied by the local file policy')) {
    return 'file_policy_denied';
  }
  if (/^Tool .+ not found$/u.test(text)) return 'tool_not_found';
  return 'tool_error';
}

/** Reads only the leading text block of a tool result, capped so large payloads stay unscanned. */
function getToolResultHead(result: unknown, maxChars = 240): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  const block = result.content.find(
    (item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string',
  );
  return isRecord(block) && typeof block.text === 'string'
    ? block.text.slice(0, maxChars)
    : '';
}

/** Creates the row marker that groups one request's assistant lifecycle. */
export function createAssistantTurnMarker(): string {
  return JSON.stringify({ format: 'teachforge-assistant-turn-v1' });
}

/** Checks whether a legacy-compatible contentJson value is an assistant turn marker. */
export function isAssistantTurnMarker(contentJson: string): boolean {
  const value: unknown = JSON.parse(contentJson);
  return isRecord(value) && value.format === 'teachforge-assistant-turn-v1';
}

/** Wraps one native Pi message for storage without discarding tool payloads. */
export function serializePersistedPiMessage(
  message: SessionMessageEntry['message'],
): string {
  const persisted: PersistedPiMessage = {
    format: 'teachforge-pi-message-v1',
    message,
  };
  return JSON.stringify(persisted);
}

/** Reads one tagged Pi message while leaving legacy text-block rows distinguishable. */
export function parsePersistedPiMessage(
  contentJson: string,
): PersistedPiMessage | undefined {
  const value: unknown = JSON.parse(contentJson);
  if (!isRecord(value) || value.format !== 'teachforge-pi-message-v1') {
    return undefined;
  }
  if (!isRecord(value.message) || typeof value.message.role !== 'string') {
    throw new Error('Stored Pi message is malformed.');
  }
  return value as unknown as PersistedPiMessage;
}

/** Wraps tool state and partial output for storage in one ordered message row. */
export function serializeToolExecution(
  execution: Omit<PersistedToolExecution, 'format'>,
): string {
  const persisted: PersistedToolExecution = {
    format: 'teachforge-tool-execution-v1',
    ...execution,
  };
  return JSON.stringify(persisted);
}

/** Parses tool execution state from a tagged row payload. */
export function parseToolExecution(
  contentJson: string,
): PersistedToolExecution | undefined {
  const value: unknown = JSON.parse(contentJson);
  if (!isRecord(value) || value.format !== 'teachforge-tool-execution-v1') {
    return undefined;
  }
  const offset = value.displayOffset;
  const limit = value.displayLimit;
  if (
    typeof value.toolCallId !== 'string' ||
    typeof value.toolName !== 'string' ||
    (value.displayPath !== undefined && typeof value.displayPath !== 'string') ||
    (value.displayPattern !== undefined &&
      typeof value.displayPattern !== 'string') ||
    (offset !== undefined &&
      !(typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0)) ||
    (limit !== undefined &&
      !(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1)) ||
    (value.status !== 'running' &&
      value.status !== 'completed' &&
      value.status !== 'failed' &&
      value.status !== 'interrupted')
  ) {
    throw new Error('Stored tool execution is malformed.');
  }
  return value as unknown as PersistedToolExecution;
}

/** Resolves an incomplete assistant snapshot without replaying partial tool calls. */
export function recoverInterruptedPiMessage(
  message: SessionMessageEntry['message'],
  interrupted: boolean,
): SessionMessageEntry['message'] | undefined {
  if (!interrupted || message.role !== 'assistant') return message;

  const content = message.content.filter((block) => block.type !== 'toolCall');
  if (content.length === 0) return undefined;

  return {
    ...message,
    content,
    stopReason: 'aborted',
  };
}

/** Extracts calls from persisted assistant messages for restart reconciliation. */
export function getPersistedToolCalls(
  message: SessionMessageEntry['message'],
): Array<{ id: string; name: string }> {
  if (message.role !== 'assistant') return [];
  return message.content.flatMap((block) =>
    block.type === 'toolCall' ? [{ id: block.id, name: block.name }] : [],
  );
}

/** Rebuilds a missing Pi tool-result message from its durable execution record. */
export function createRecoveredToolResult(
  toolCallId: string,
  toolName: string,
  execution?: PersistedToolExecution,
): SessionMessageEntry['message'] {
  type PiToolResultMessage = Extract<
    SessionMessageEntry['message'],
    { role: 'toolResult' }
  >;

  const result = isRecord(execution?.result) ? execution.result : undefined;
  const resultContent =
    result && Array.isArray(result.content)
      ? (result.content as PiToolResultMessage['content'])
      : undefined;
  const partialOutput =
    execution?.partialResult === undefined
      ? ''
      : ` Last partial output: ${JSON.stringify(execution.partialResult)}`;
  const timestamp = Date.now();
  const recovered: PiToolResultMessage = {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: resultContent
      ? resultContent
      : [
          {
            type: 'text',
            text: `Tool execution was interrupted before its result was persisted.${partialOutput}`,
          },
        ],
    isError:
      result && typeof result.isError === 'boolean'
        ? result.isError
        : execution?.status !== 'completed',
    timestamp,
  };

  if (result?.details !== undefined) {
    recovered.details = result.details as PiToolResultMessage['details'];
  }
  if (result?.usage !== undefined) {
    recovered.usage = result.usage as PiToolResultMessage['usage'];
  }
  if (execution?.durationMs !== undefined) {
    recovered.durationMs = execution.durationMs;
  }
  return recovered;
}

/** Narrows unknown JSON data to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
