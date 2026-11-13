const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reports whether a value is a UUIDv4 string.
 *
 * Persisted conversation and message ids are UUIDv4; assistant-ui generates its own short ids for
 * the reply it renders, so callers use this to tell a durable anchor from a live one.
 */
export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}
