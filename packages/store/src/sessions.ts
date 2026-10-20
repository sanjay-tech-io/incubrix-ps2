import type pg from "pg";
import { ConversationEntry, LogEntry, type Atom, type Source } from "@incubrix/contracts";
import type { SessionState } from "@incubrix/engine";
import { newId, type Db } from "./util.ts";

export interface SessionRow {
  id: string;
  video_id: string;
  source_sha256: string;
  status: string;
  created_at: Date;
}

export async function createSession(db: Db, videoId: string, sha256: string, source: Source): Promise<string> {
  const id = newId("ses");
  await db.query(
    "insert into sessions(id, video_id, source_sha256, status, fps_num, fps_den, duration_us) values ($1,$2,$3,'ready',$4,$5,$6)",
    [id, videoId, sha256, source.fps?.num ?? null, source.fps?.den ?? null, source.durationUs],
  );
  return id;
}

export async function getSession(db: Db, id: string): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>("select id, video_id, source_sha256, status, created_at from sessions where id=$1", [id]);
  return rows[0] ?? null;
}

/**
 * Rebuild the engine state from the two logs. This is what a restart does: the log is the truth and
 * the timeline is replay(log), so the hash comes out identical.
 * DB seq is 1-based, engine seq is 0-based; undo/redo rows have group_no 0 and an empty op.
 */
export async function loadSessionState(db: Db, sessionId: string): Promise<SessionState> {
  const ops = await db.query("select seq, group_no, kind, op from operation_log where session_id=$1 order by seq", [sessionId]);
  const log = ops.rows.map((r) =>
    LogEntry.parse(r.kind === "undo" || r.kind === "redo" ? { seq: r.seq - 1, kind: r.kind } : { seq: r.seq - 1, kind: "edit", group: r.group_no, op: r.op }),
  );
  const conv = await db.query("select turn, instruction, answer, pending_question from conversation_log where session_id=$1 order by turn", [sessionId]);
  const conversation = conv.rows.map((r) =>
    ConversationEntry.parse({ turn: r.turn - 1, text: r.instruction, answer: r.answer.answer, appliedGroup: r.answer.appliedGroup, pending: r.pending_question }),
  );
  return { log, conversation };
}

export async function sessionCounts(db: Db, sessionId: string): Promise<{ log: number; conversation: number }> {
  const { rows } = await db.query("select (select count(*)::int from operation_log where session_id=$1) as l, (select count(*)::int from conversation_log where session_id=$1) as c", [sessionId]);
  return { log: rows[0].l, conversation: rows[0].c };
}

/** Append only what is new since `before`. Call it inside the caller's transaction: a turn is either fully stored or not at all. */
export async function appendTurn(c: pg.PoolClient, sessionId: string, before: SessionState, after: SessionState): Promise<void> {
  {
    for (const e of after.log.slice(before.log.length)) {
      const isEdit = e.kind === "edit";
      await c.query("insert into operation_log(session_id, seq, group_no, kind, op) values ($1,$2,$3,$4,$5)", [
        sessionId, e.seq + 1, isEdit ? e.group : 0, isEdit ? e.op.type : e.kind, JSON.stringify(isEdit ? e.op : {}),
      ]);
    }
    for (const t of after.conversation.slice(before.conversation.length)) {
      await c.query("insert into conversation_log(session_id, turn, instruction, status, answer, pending_question) values ($1,$2,$3,$4,$5,$6)", [
        sessionId, t.turn + 1, t.text, t.answer.status, JSON.stringify({ answer: t.answer, appliedGroup: t.appliedGroup }), t.pending ? JSON.stringify(t.pending) : null,
      ]);
    }
    await c.query("update sessions set updated_at=now() where id=$1", [sessionId]);
  }
}

/** Serialize instructions of one session across API instances (released at commit/rollback). */
export async function lockSession(c: pg.PoolClient, sessionId: string): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [sessionId]);
}

export type { Atom };
