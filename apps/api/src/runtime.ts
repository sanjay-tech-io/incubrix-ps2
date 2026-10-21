import { newSession, type EngineContext, type SessionState } from "@incubrix/engine";
import type { Atom, Source } from "@incubrix/contracts";
import { ApiError } from "@incubrix/errors";
import { contextOf, getSession, getTranscript, getVideo, loadSessionState, sessionCounts, speedLimits, sourceOf, type Db, type VideoRow } from "@incubrix/store";
import type pg from "pg";

export interface Runtime {
  sessionId: string;
  videoId: string;
  video: VideoRow;
  ctx: EngineContext;
  state: SessionState;
  counts: { log: number; conversation: number };
}

/**
 * In-memory engine state per session. The DB is the truth: before every use the row counts are compared and the
 * state is rebuilt by replay when another process (or a restart) changed it. A fresh process rebuilds everything.
 */
export class RuntimeCache {
  private readonly map = new Map<string, Runtime>();
  private readonly maxSpeed: number;
  constructor(maxSpeed: number) {
    this.maxSpeed = maxSpeed;
  }

  invalidate(sessionId: string): void {
    this.map.delete(sessionId);
  }

  set(rt: Runtime): void {
    this.map.delete(rt.sessionId);
    this.map.set(rt.sessionId, rt);
    if (this.map.size > 50) this.map.delete(this.map.keys().next().value!);
  }

  async get(db: Db, sessionId: string): Promise<Runtime> {
    const hit = this.map.get(sessionId);
    const counts = await sessionCounts(db, sessionId);
    if (hit && hit.counts.log === counts.log && hit.counts.conversation === counts.conversation) return hit;

    const session = await getSession(db, sessionId);
    if (!session) throw new ApiError("SESSION_NOT_FOUND", `session ${sessionId} does not exist`);
    let ctx = hit?.ctx;
    let video = hit?.video;
    if (!ctx || !video) {
      const v = await getVideo(db, session.video_id);
      const t = v?.transcript_key ? await getTranscript(db, v.transcript_key) : null;
      if (!v || !t) throw new ApiError("VIDEO_NOT_READY", "the session's video has no transcript");
      ctx = contextOf(v, t.atoms as Atom[], this.maxSpeed);
      video = v;
    }
    const state = counts.log === 0 && counts.conversation === 0 ? newSession() : await loadSessionState(db, sessionId);
    const rt: Runtime = { sessionId, videoId: session.video_id, video, ctx, state, counts };
    this.set(rt);
    return rt;
  }
}

export type PgPool = pg.Pool;

export { speedLimits, sourceOf };
