import type { Db } from "./util.ts";

export interface LlmCacheRow {
  cache_key: string;
  provider: string;
  model: string;
  response: Record<string, unknown>;
}

export async function getLlmCache(db: Db, key: string): Promise<LlmCacheRow | null> {
  const { rows } = await db.query<LlmCacheRow>("select cache_key, provider, model, response from llm_cache where cache_key=$1", [key]);
  return rows[0] ?? null;
}

export async function putLlmCache(db: Db, row: LlmCacheRow): Promise<void> {
  await db.query("insert into llm_cache(cache_key, provider, model, response) values ($1,$2,$3,$4) on conflict (cache_key) do nothing", [row.cache_key, row.provider, row.model, JSON.stringify(row.response)]);
}
