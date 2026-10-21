import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

/** Resource ids are random on purpose: they never feed a timeline hash (atom ids and effect ids do not use them). */
export function newId(prefix: "vid" | "ses" | "job"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/** JSON with sorted keys, so equal objects hash equal whatever the key order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type Db = pg.Pool | pg.PoolClient;

/** Run fn in one transaction. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
