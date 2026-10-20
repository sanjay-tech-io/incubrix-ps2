import { newId, type Db } from "./util.ts";

export interface VideoRow {
  id: string;
  sha256: string | null;
  source_url: string | null;
  storage_key: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  status: "processing" | "ready" | "failed";
  probe: Record<string, unknown> | null;
  warnings: string[];
  num_speakers_hint: number | null;
  transcript_key: string | null;
  rights: string | null;
  ai_generated: boolean;
  created_at: Date;
}

const COLS = "id, sha256, source_url, storage_key, filename, mime_type, size_bytes, status, probe, warnings, num_speakers_hint, transcript_key, rights, ai_generated, created_at";

export async function createVideo(
  db: Db,
  v: { sourceUrl?: string; sha256?: string; storageKey?: string; filename?: string; mimeType?: string; sizeBytes?: number; numSpeakers?: number; rights?: string; aiGenerated?: boolean },
): Promise<string> {
  const id = newId("vid");
  await db.query(
    "insert into videos(id, source_url, sha256, storage_key, filename, mime_type, size_bytes, num_speakers_hint, rights, ai_generated) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [id, v.sourceUrl ?? null, v.sha256 ?? null, v.storageKey ?? null, v.filename ?? null, v.mimeType ?? null, v.sizeBytes ?? null, v.numSpeakers ?? null, v.rights ?? null, v.aiGenerated ?? false],
  );
  return id;
}

export async function getVideo(db: Db, id: string): Promise<VideoRow | null> {
  const { rows } = await db.query<VideoRow>(`select ${COLS} from videos where id=$1`, [id]);
  return rows[0] ?? null;
}

export async function updateVideo(
  db: Db,
  id: string,
  p: Partial<{ sha256: string; storageKey: string; mimeType: string; sizeBytes: number; status: VideoRow["status"]; probe: object; warnings: string[]; transcriptKey: string }>,
): Promise<void> {
  await db.query(
    `update videos set sha256=coalesce($2, sha256), storage_key=coalesce($3, storage_key), mime_type=coalesce($4, mime_type), size_bytes=coalesce($5, size_bytes),
       status=coalesce($6, status), probe=coalesce($7, probe), warnings=coalesce($8, warnings), transcript_key=coalesce($9, transcript_key), updated_at=now() where id=$1`,
    [id, p.sha256 ?? null, p.storageKey ?? null, p.mimeType ?? null, p.sizeBytes ?? null, p.status ?? null, p.probe ? JSON.stringify(p.probe) : null, p.warnings ? JSON.stringify(p.warnings) : null, p.transcriptKey ?? null],
  );
}
