/**
 * Test helper: recursively freeze plain data (objects and arrays; Maps and typed arrays are left alone).
 * Logs, timelines, sessions and operations are meant to be immutable values; freezing them in a test turns any
 * accidental in-place mutation inside the engine into a TypeError (ES modules run in strict mode), so the
 * property tests fail loudly instead of silently corrupting a cached value.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (value instanceof Map || value instanceof Set || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return value;
}
