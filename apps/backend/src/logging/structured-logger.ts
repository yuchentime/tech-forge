import type { Logger } from '@nestjs/common';

/** Defines the Nest logger levels used for structured Agent-flow events. */
export type StructuredLogLevel = 'log' | 'debug' | 'warn' | 'error';

/** Carries one internal request correlation ID across backend flow boundaries. */
export interface RequestLogContext {
  requestId: string;
  conversationId?: string;
}

/** Serializes one whitelisted event as a JSON message through the Nest logger. */
export function writeStructuredEvent(
  logger: Logger,
  level: StructuredLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const message = JSON.stringify({
    ...fields,
    event,
    timestamp: new Date().toISOString(),
  });

  switch (level) {
    case 'debug':
      logger.debug(message);
      return;
    case 'warn':
      logger.warn(message);
      return;
    case 'error':
      logger.error(message);
      return;
    default:
      logger.log(message);
  }
}

/** Default cap for one free-text field copied into a structured log line. */
export const LOG_TEXT_MAX_CHARS = 200;

/**
 * Clips free text before it enters a log field.
 *
 * Diagnostics need to see what was searched for, but a pasted document must not flood one line;
 * callers keeping whole documents out of logs should log identifiers and lengths instead.
 */
export function clipLogText(value: unknown, maxChars = LOG_TEXT_MAX_CHARS): string {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Returns safe exception type/code/stack metadata without logging its message. */
export function getSafeErrorLogFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }

  const fields: Record<string, unknown> = {
    errorType: normalizeErrorType(error.name),
  };
  const record = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };

  if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(record.code)) {
    fields.errorCode = record.code;
  }
  const statusCode = record.statusCode ?? record.status;
  if (typeof statusCode === 'number' && Number.isInteger(statusCode)) {
    fields.errorStatus = statusCode;
  }

  const stackFrames = error.stack
    ?.split(/\r?\n/)
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, 8)
    .map((line) => line.trim().slice(0, 240));
  if (stackFrames?.length) fields.stackFrames = stackFrames;
  return fields;
}

/** Bounds exception class names before placing them in structured log fields. */
function normalizeErrorType(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.$-]/g, '').slice(0, 80);
  return normalized || 'Error';
}
