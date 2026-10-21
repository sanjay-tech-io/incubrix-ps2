import type { Atom } from "@incubrix/contracts";
import { canonicalJson, sha256Text, type Db } from "./util.ts";

/** Everything that can change the words or the atoms. Change any field and the key changes. */
export interface TranscriptSettings {
  asrProvider: string;
  asrModel: string;
  diarizationProvider: string;
  numSpeakers: number | null;
  silenceNoiseDb: number;
  silenceMinUs: number;
  clampMinWordUs: number;
  lowConfidencePermille: number;
}

export function transcriptCacheKey(sourceSha256: string, s: TranscriptSettings): string {
  return sha256Text(canonicalJson({ v: 1, sourceSha256, ...s }));
}

export interface TranscriptRow {
  cache_key: string;
  source_sha256: string;
  settings: TranscriptSettings;
  atoms: Atom[];
  manifest: Record<string, unknown>;
}

export async function getTranscript(db: Db, key: string): Promise<TranscriptRow | null> {
  const { rows } = await db.query<TranscriptRow>("select cache_key, source_sha256, settings, atoms, manifest from transcripts where cache_key=$1", [key]);
  return rows[0] ?? null;
}

export async function putTranscript(db: Db, row: TranscriptRow): Promise<void> {
  await db.query(
    "insert into transcripts(cache_key, source_sha256, settings, atoms, manifest) values ($1,$2,$3,$4,$5) on conflict (cache_key) do nothing",
    [row.cache_key, row.source_sha256, JSON.stringify(row.settings), JSON.stringify(row.atoms), JSON.stringify(row.manifest)],
  );
}
