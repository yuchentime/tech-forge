/**
 * Extracts the first JSON object from model text that may include fences or prose.
 *
 * Models wrap structured answers inconsistently; the caller still validates the parsed shape.
 */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Model output did not contain a JSON object.');
  }
  return JSON.parse(text.slice(start, end + 1));
}
