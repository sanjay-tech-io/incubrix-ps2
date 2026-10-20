/**
 * Canonical JSON: the exact text that timeline_hash is computed over.
 *
 * Why strict: the hash must be identical on every machine and every run. So keys
 * are sorted (insertion order is irrelevant), there is no whitespace, and
 * anything that could serialise differently or lossy (floats, NaN, undefined)
 * is an error instead of being quietly coerced. Time is integer microseconds
 * everywhere, so a float showing up here is a bug we want to hear about.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) throw new Error(`canonicalJson: non-integer or unsafe number at ${path}: ${String(v)}`);
      return String(v);
    case "object": {
      if (Array.isArray(v)) return "[" + v.map((x, i) => write(x, `${path}[${i}]`)).join(",") + "]";
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort(); // default sort = UTF-16 code unit order, stable across runtimes
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + write(obj[k], `${path}.${k}`)).join(",") + "}";
    }
    default:
      // undefined, function, symbol, bigint
      throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}
