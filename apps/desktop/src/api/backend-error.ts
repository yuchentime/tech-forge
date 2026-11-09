/** Shape of the error envelope Nest returns for a rejected request. */
interface BackendErrorEnvelope {
  message?: unknown;
}

/**
 * Extracts a safe human-readable message from a backend error envelope.
 *
 * Nest returns either a string or a list of validation messages; anything else falls back to the
 * caller's copy so an unexpected body never surfaces raw JSON in the UI.
 */
export function readBackendErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }
  const message = (value as BackendErrorEnvelope).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && message.every((part) => typeof part === 'string')) {
    return message.join(' ');
  }
  return fallback;
}

/**
 * Turns any thrown value into copy a user can act on.
 *
 * Backend messages are already Chinese and pass through; technical text such as `fetch failed`
 * stays as a parenthetical detail instead of being the whole message.
 */
export function describeFailure(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (message === '') return fallback;
  if (/[\u3400-\u9fff]/.test(message)) return message;
  return `${fallback}（${message}）`;
}
