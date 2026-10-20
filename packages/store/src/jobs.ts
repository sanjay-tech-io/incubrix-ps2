import type pg from "pg";
import { newId, type Db } from "./util.ts";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export interface JobRow {
  id: string;
  type: "ingest" | "transcribe" | "render" | "export";
  status: JobStatus;
  progress: number;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  callback_url: string | null;
  video_id: string | null;
  session_id: string | null;
  request: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = "id, type, status, progress, result, error, callback_url, video_id, session_id, request, created_at, updated_at";

export async function createJob(db: Db, j: { type: JobRow["type"]; videoId?: string; sessionId?: string; callbackUrl?: string | null; request?: object }): Promise<string> {
  const id = newId("job");
  await db.query("insert into jobs(id, type, video_id, session_id, callback_url, request) values ($1,$2,$3,$4,$5,$6)", [
    id, j.type, j.videoId ?? null, j.sessionId ?? null, j.callbackUrl ?? null, j.request ? JSON.stringify(j.request) : null,
  ]);
  return id;
}

export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(`select ${COLS} from jobs where id=$1`, [id]);
  return rows[0] ?? null;
}

/**
 * Take the oldest queued job. FOR UPDATE SKIP LOCKED: two workers never get the same row, and a worker
 * never waits for a row another worker is claiming. The status flip commits at once, so the lock is short.
 */
export async function claimNextJob(pool: pg.Pool): Promise<JobRow | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const { rows } = await c.query<JobRow>(`select ${COLS} from jobs where status='queued' order by created_at, id for update skip locked limit 1`);
    const job = rows[0];
    if (!job) {
      await c.query("commit");
      return null;
    }
    await c.query("update jobs set status='running', updated_at=now() where id=$1", [job.id]);
    await c.query("commit");
    return { ...job, status: "running" };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Progress is monotonic; updating it also refreshes updated_at, which is the worker's heartbeat. */
export async function setProgress(db: Db, id: string, progress: number): Promise<void> {
  await db.query("update jobs set progress=greatest(progress, $2), updated_at=now() where id=$1 and status='running'", [id, Math.max(0, Math.min(100, Math.round(progress)))]);
}

export async function succeedJob(db: Db, id: string, result: object): Promise<void> {
  await db.query("update jobs set status='succeeded', progress=100, result=$2, updated_at=now() where id=$1", [id, JSON.stringify(result)]);
}

export async function failJob(db: Db, id: string, error: object): Promise<void> {
  await db.query("update jobs set status='failed', error=$2, updated_at=now() where id=$1", [id, JSON.stringify(error)]);
}

/** A job `running` with no heartbeat for staleSeconds belonged to a crashed worker: put it back in the queue. */
export async function requeueStale(db: Db, staleSeconds: number): Promise<number> {
  const r = await db.query("update jobs set status='queued', progress=0, updated_at=now() where status='running' and updated_at < now() - make_interval(secs => $1)", [staleSeconds]);
  return r.rowCount ?? 0;
}
