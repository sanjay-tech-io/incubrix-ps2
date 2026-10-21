import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@incubrix/errors";
import { appendTurn, claimNextJob, createJob, createSession, createVideo, getJob, getTranscript, loadSessionState, lockSession, putTranscript, requeueStale, requestHash, setProgress, succeedJob, transcriptCacheKey, tx, withIdempotency, type TranscriptSettings } from "../src/index.ts";
import { tempDb } from "./db.ts";

const SHA = "a".repeat(64);
const settings: TranscriptSettings = {
  asrProvider: "faster-whisper", asrModel: "base.en", diarizationProvider: "sherpa", numSpeakers: null,
  silenceNoiseDb: -35, silenceMinUs: 300_000, clampMinWordUs: 20_000, lowConfidencePermille: 600, voicedGapMinUs: 150_000, voicedGapMaxUs: 1_200_000,
};

describe("transcript cache key (pure)", () => {
  it("is stable for equal inputs", () => {
    expect(transcriptCacheKey(SHA, settings)).toBe(transcriptCacheKey(SHA, { ...settings }));
  });
  it.each([
    ["asr model", { asrModel: "small.en" }],
    ["asr provider", { asrProvider: "mock" }],
    ["diarization provider", { diarizationProvider: "mock" }],
    ["num_speakers", { numSpeakers: 2 }],
    ["silence noise", { silenceNoiseDb: -40 }],
    ["silence min", { silenceMinUs: 200_000 }],
    ["clamp min word", { clampMinWordUs: 30_000 }],
  ])("changes when the %s changes", (_n, patch) => {
    expect(transcriptCacheKey(SHA, { ...settings, ...patch })).not.toBe(transcriptCacheKey(SHA, settings));
  });
  it("changes with the file hash", () => {
    expect(transcriptCacheKey("b".repeat(64), settings)).not.toBe(transcriptCacheKey(SHA, settings));
  });
});

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;

run("store against Postgres", () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ pool, drop } = await tempDb()));
  afterAll(async () => drop());

  it("a transcript for a different model is a cache MISS, the same settings a HIT", async () => {
    const key = transcriptCacheKey(SHA, settings);
    await putTranscript(pool, { cache_key: key, source_sha256: SHA, settings, atoms: [], manifest: {} });
    expect(await getTranscript(pool, key)).not.toBeNull();
    expect(await getTranscript(pool, transcriptCacheKey(SHA, { ...settings, asrModel: "small.en" }))).toBeNull();
  });

  it("idempotency: same key + same body runs the work once and replays the answer", async () => {
    let runs = 0;
    const work = async () => (runs++, { status: 202, body: { job_id: "j" + runs } });
    const h = requestHash({ a: 1, b: [2] });
    const first = await withIdempotency(pool, "POST /x", "k1", h, work);
    const second = await withIdempotency(pool, "POST /x", "k1", requestHash({ b: [2], a: 1 }), work); // key order differs, body is equal
    expect(runs).toBe(1);
    expect(second).toEqual({ status: 202, body: first.body, replayed: true });
  });

  it("idempotency: same key + different body is 409 IDEMPOTENCY_KEY_REUSED and runs nothing", async () => {
    let runs = 0;
    await withIdempotency(pool, "POST /y", "k2", requestHash({ a: 1 }), async () => (runs++, { status: 201, body: {} }));
    await expect(withIdempotency(pool, "POST /y", "k2", requestHash({ a: 2 }), async () => (runs++, { status: 201, body: {} }))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(runs).toBe(1);
  });

  it("idempotency: the same key in another scope is independent; a 5xx result is not remembered", async () => {
    let runs = 0;
    await withIdempotency(pool, "POST /a", "k3", "h", async () => (runs++, { status: 201, body: {} }));
    await withIdempotency(pool, "POST /b", "k3", "h", async () => (runs++, { status: 201, body: {} }));
    expect(runs).toBe(2);
    await withIdempotency(pool, "POST /c", "k4", "h", async () => ({ status: 503, body: {} }));
    await withIdempotency(pool, "POST /c", "k4", "h", async () => (runs++, { status: 201, body: {} }));
    expect(runs).toBe(3);
  });

  it("idempotency: two concurrent requests with one key run the work once", async () => {
    let runs = 0;
    const slow = async () => (runs++, await new Promise((r) => setTimeout(r, 150)), { status: 202, body: { ok: true } });
    const results = await Promise.allSettled([withIdempotency(pool, "POST /z", "k5", "h", slow), withIdempotency(pool, "POST /z", "k5", "h", slow)]);
    expect(runs).toBe(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as ApiError).code).toBe("IDEMPOTENCY_IN_PROGRESS");
  });

  it("claimNextJob: concurrent workers never get the same job (SKIP LOCKED)", async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => createJob(pool, { type: "ingest" })));
    const claims = await Promise.all([1, 2, 3, 4, 5, 6].map(() => claimNextJob(pool)));
    const got = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.filter((g) => ids.includes(g))).toHaveLength(4);
    expect(claims.filter((c) => c === null).length).toBe(2);
    expect((await getJob(pool, ids[0]!))!.status).toBe("running");
  });

  it("progress never goes down; stale running jobs are re-queued, fresh ones are not", async () => {
    const id = await createJob(pool, { type: "ingest" });
    const job = await claimNextJob(pool);
    expect(job!.id).toBe(id);
    await setProgress(pool, id, 40);
    await setProgress(pool, id, 10);
    expect((await getJob(pool, id))!.progress).toBe(40);
    expect(await requeueStale(pool, 60)).toBe(0);
    await pool.query("update jobs set updated_at = now() - interval '5 minutes' where id=$1", [id]);
    expect(await requeueStale(pool, 60)).toBeGreaterThanOrEqual(1);
    expect((await getJob(pool, id))!.status).toBe("queued");
    await succeedJob(pool, id, { done: true });
    expect((await getJob(pool, id))!.progress).toBe(100);
  });

  it("session state round-trips through operation_log and conversation_log", async () => {
    const vid = await createVideo(pool, {});
    const source = { sha256: SHA, durationUs: 10_000_000, fps: { num: 25, den: 1 }, hasAudio: true, hasVideo: true, variableFrameRate: false };
    const sid = await createSession(pool, vid, SHA, source);
    const empty = { log: [], conversation: [] };
    const answer = { status: "applied" as const, operations: [], summary: "s", question: null, options: [], reason: null, timePolicy: "current" as const, warnings: [], timelineHash: "c".repeat(64), durationUs: 10_000_000 };
    const op = { type: "restore" as const, targetGroup: 1 };
    const after = {
      log: [{ seq: 0, kind: "edit" as const, group: 1, op }, { seq: 1, kind: "undo" as const }, { seq: 2, kind: "redo" as const }],
      conversation: [{ turn: 0, text: "put it back", answer, appliedGroup: 1, pending: null }],
    };
    await tx(pool, async (c) => {
      await lockSession(c, sid);
      await appendTurn(c, sid, empty, after);
    });
    expect(await loadSessionState(pool, sid)).toEqual(after);
  });

  it("operation_log rejects UPDATE and DELETE written through the store's own connection", async () => {
    const { rows } = await pool.query("select session_id from operation_log limit 1");
    await expect(pool.query("update operation_log set kind='cut' where session_id=$1", [rows[0].session_id])).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from operation_log where session_id=$1", [rows[0].session_id])).rejects.toThrow(/append-only/);
  });
});

import { assertFreeDisk } from "../src/index.ts";
describe("disk space check at startup", () => {
  it("fails clearly (folder, free and required GB) when the disk is nearly full, passes otherwise", async () => {
    const full = async () => ({ bavail: 1_000_000, bsize: 4096 }); // ~3.8 GB... too small for 5 GB
    await expect(assertFreeDisk("/tmp", 5, full)).rejects.toThrow(/not enough free disk space in \/tmp: 3\.8 GB free, 5 GB required \(MIN_FREE_DISK_GB\)/);
    const roomy = async () => ({ bavail: 10_000_000, bsize: 4096 });
    expect(await assertFreeDisk("/tmp", 5, roomy)).toBeGreaterThan(30);
  });
});
