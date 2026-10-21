import type { Db } from "./util.ts";

export interface StoredPassages<P> {
  passages: P[];
  vectors: number[][];
}

export async function getPassageVectors<P>(db: Db, transcriptKey: string, modelId: string): Promise<StoredPassages<P> | null> {
  const { rows } = await db.query("select passages, vectors from passage_embeddings where transcript_key=$1 and model_id=$2", [transcriptKey, modelId]);
  return rows[0] ? { passages: rows[0].passages, vectors: rows[0].vectors } : null;
}

export async function putPassageVectors<P>(db: Db, transcriptKey: string, modelId: string, v: StoredPassages<P>): Promise<void> {
  await db.query("insert into passage_embeddings(transcript_key, model_id, passages, vectors) values ($1,$2,$3,$4) on conflict do nothing", [
    transcriptKey, modelId, JSON.stringify(v.passages), JSON.stringify(v.vectors),
  ]);
}

export async function getQueryVector(db: Db, modelId: string, query: string): Promise<number[] | null> {
  const { rows } = await db.query("select vector from query_embeddings where model_id=$1 and query=$2", [modelId, query]);
  return rows[0]?.vector ?? null;
}

export async function putQueryVector(db: Db, modelId: string, query: string, vector: number[]): Promise<void> {
  await db.query("insert into query_embeddings(model_id, query, vector) values ($1,$2,$3) on conflict do nothing", [modelId, query, JSON.stringify(vector)]);
}
