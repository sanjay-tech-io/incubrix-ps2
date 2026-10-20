import type pg from "pg";
import { ApiError } from "@incubrix/errors";
import { canonicalJson, sha256Text } from "./util.ts";

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function requestHash(body: unknown): string {
  return sha256Text(canonicalJson(body ?? null));
}

/**
 * Same key + same body: replay the stored response and do NOT run `work` again.
 * Same key + different body: 409 IDEMPOTENCY_KEY_REUSED.
 * Why the claim row is inserted first: two concurrent requests with one key cannot both run the work;
 * the loser sees the unfinished claim and gets a retryable 409.
 * A 5xx result is not stored (the claim is released), so the client can retry the same key.
 */
export async function withIdempotency(
  pool: pg.Pool,
  scope: string,
  key: string | undefined,
  hash: string,
  work: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (!key) return { ...(await work()), replayed: false };

  const claimed = await pool.query(
    "insert into idempotency_keys(scope, key, request_hash) values ($1,$2,$3) on conflict (scope, key) do nothing returning key",
    [scope, key, hash],
  );
  if (claimed.rowCount === 0) {
    const { rows } = await pool.query("select request_hash, status_code, response from idempotency_keys where scope=$1 and key=$2", [scope, key]);
    const row = rows[0];
    if (!row) return withIdempotency(pool, scope, key, hash, work); // released between our two queries
    if (row.request_hash !== hash) throw new ApiError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request body.", { scope });
    if (row.status_code === null) throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "A request with this Idempotency-Key is still running.", { scope });
    return { status: row.status_code, body: row.response, replayed: true };
  }

  try {
    const res = await work();
    if (res.status >= 500) {
      await pool.query("delete from idempotency_keys where scope=$1 and key=$2", [scope, key]);
    } else {
      await pool.query("update idempotency_keys set status_code=$3, response=$4 where scope=$1 and key=$2", [scope, key, res.status, JSON.stringify(res.body)]);
    }
    return { ...res, replayed: false };
  } catch (e) {
    await pool.query("delete from idempotency_keys where scope=$1 and key=$2", [scope, key]);
    throw e;
  }
}

