import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, newSession, submitOperations, submitUndo, timelineHash, currentTimeline, type Operation, type SessionState } from "@incubrix/engine";
import { makeFixture } from "../../../packages/engine/test/fixtures/transcript.ts";
import { speedLimits } from "../src/runtime.ts";
import { makeClip } from "./clips.ts";
import { ingest, integration, startStack, type Stack } from "./harness.ts";

// End to end over HTTP: upload a generated clip, run the worker (mock ASR), then steps 1-7 of the worked example through the
// rules parser; every step's timeline_hash must equal an engine-only replay of the operations the API returned.
const U = 1_000_000;
const fixtureWords = makeFixture()
  .atoms.filter((a) => a.kind === "word")
  .map((a) => ({ text: a.text, start_us: a.startUs, end_us: a.endUs, confidence_permille: 950, speaker: "S1" }));

describe.skipIf(!integration)("worked example over HTTP (mock ASR)", () => {
  let s: Stack;
  let sessionId: string;
  let D = 0;
  beforeAll(async () => {
    s = await startStack({ words: fixtureWords });
  }, 120_000);
  afterAll(async () => s?.stop());

  const say = async (text: string, extra: Record<string, unknown> = {}) => {
    const r = await s.call("POST", `/api/v1/sessions/${sessionId}/instructions`, { say: text, ...extra });
    expect(r.status).toBe(200);
    return r.body;
  };

  it("uploads the clip, the job runs with progress and succeeds, the original is stored untouched", async () => {
    const file = makeClip({ seconds: 200 });
    const { videoId, jobId, job } = await ingest(s, file);
    expect(job.status).toBe("succeeded");
    expect(job.progress).toBe(100);
    expect(job.result.manifest.providers.asr.provider).toBe("mock");
    expect(job.result.links.video).toBe(`/api/v1/videos/${videoId}`);
    const v = (await s.call("GET", `/api/v1/videos/${videoId}`)).body;
    expect(v.status).toBe("ready");
    expect(v.probe.has_audio).toBe(true);
    expect(v.probe.fps).toEqual({ num: 25, den: 1 });
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = await fetch(v.download_url);
    const bytes = Buffer.from(await stored.arrayBuffer());
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(v.sha256); // the stored original is byte-identical
    D = v.probe.duration_s;
    expect(Math.abs(D - 200)).toBeLessThan(0.1);
    expect(jobId).toMatch(/^job_/);
  }, 120_000);

  it("opens a session", async () => {
    const vid = (await s.pool.query("select id from videos limit 1")).rows[0].id;
    const r = await s.call("POST", "/api/v1/sessions", { video_id: vid });
    expect(r.status).toBe(201);
    sessionId = r.body.session_id;
    expect(r.body.duration_s).toBeCloseTo(D, 3);
  });

  it("steps 1-7 give the same hashes as an engine-only replay of the returned operations", async () => {
    const t = await s.pool.query("select t.atoms, v.probe from videos v join transcripts t on t.cache_key = v.transcript_key limit 1");
    const p = t.rows[0].probe;
    const ctx = createContext({ sha256: p.sha256, durationUs: p.duration_us, fps: p.fps, hasAudio: true, hasVideo: true, variableFrameRate: false }, t.rows[0].atoms, speedLimits(4));
    let e: SessionState = newSession();
    const engineApply = (text: string, ops: Operation[]) => (e = submitOperations(ctx, e, text, ops).state);
    const hashNow = () => timelineHash(currentTimeline(ctx, e));
    const policyOk = (a: any) => expect(a.summary).toMatch(/Time policy: current/);

    const a1 = await say('add a caption "Welcome!" on "welcome to the channel"');
    expect(a1).toMatchObject({ status: "applied", time_policy: "current" });
    policyOk(a1);
    engineApply("1", a1.operations);
    expect(a1.timeline_hash).toBe(hashNow());

    const a2 = await say("cut the first 30 seconds");
    expect(a2.status).toBe("applied");
    expect(a2.duration_s).toBeCloseTo(D - 30, 3);
    policyOk(a2);
    engineApply("2", a2.operations);
    expect(a2.timeline_hash).toBe(hashNow());

    const a3 = await say("remove the part about pricing");
    expect(a3.status).toBe("needs_clarification");
    expect(a3.options).toHaveLength(3);
    expect(a3.timeline_hash).toBe(a2.timeline_hash); // a question changes nothing
    expect(a3.summary).toMatch(/Time policy: current/);

    const a3b = await say("the second one");
    expect(a3b.status).toBe("applied");
    expect(a3b.duration_s).toBeCloseTo(D - 35, 3);
    engineApply("3", a3b.operations);
    expect(a3b.timeline_hash).toBe(hashNow());

    const a4 = await say("speed up 1:00-1:30 by 2x");
    expect(a4).toMatchObject({ status: "applied", time_policy: "current" });
    expect(a4.duration_s).toBeCloseTo(D - 50, 3);
    engineApply("4", a4.operations);
    expect(a4.timeline_hash).toBe(hashNow());

    const a5 = await say("put the intro back");
    expect(a5.status).toBe("applied");
    expect(a5.duration_s).toBeCloseTo(D - 20, 3);
    engineApply("5", a5.operations);
    expect(a5.timeline_hash).toBe(hashNow());

    const a6 = await say("undo");
    expect(a6.timeline_hash).toBe(a4.timeline_hash); // exactly the state after step 4
    e = submitUndo(ctx, e, "undo").state;
    expect(a6.timeline_hash).toBe(hashNow());

    const a7 = await say("make that caption red");
    expect(a7.status).toBe("applied");
    engineApply("7", a7.operations);
    expect(a7.timeline_hash).toBe(hashNow());

    // an "original" instruction names that policy in its summary
    const a8 = await say("remove 3:00-3:05 in the original");
    expect(a8.time_policy).toBe("original");
    expect(a8.summary).toMatch(/Time policy: original/);
    engineApply("8", a8.operations);
    expect(a8.timeline_hash).toBe(hashNow());

    // every answer carries a manifest
    for (const a of [a1, a2, a3, a4, a7]) {
      expect(a.manifest.providers.parser).toEqual({ name: "rules", version: "1" });
      expect(a.manifest.cost_estimate.cpu_seconds).toBeGreaterThanOrEqual(0);
      expect(a.manifest.rights.reference).toBe("SOURCES.md");
    }

    const tl = (await s.call("GET", `/api/v1/sessions/${sessionId}/timeline`)).body;
    expect(tl.timeline_hash).toBe(a8.timeline_hash);
    expect(tl.effects[0]).toMatchObject({ kind: "caption", text: "Welcome!", state: "active" });
    const conv = (await s.call("GET", `/api/v1/sessions/${sessionId}/conversation`)).body;
    expect(conv.turns.map((x: any) => x.status)).toEqual(["applied", "applied", "needs_clarification", "applied", "applied", "applied", "applied", "applied", "applied"]);
    expect(conv.turns.every((x: any) => /Time policy/.test(x.answer.summary))).toBe(true);
    const hist = (await s.call("GET", `/api/v1/sessions/${sessionId}/history`)).body;
    expect(hist.entries.some((x: any) => x.kind === "undo" && x.group === 0)).toBe(true);
    expect(hist.entries.find((x: any) => x.kind === "cut").op.span.start.atom).toMatch(/^a_/); // atoms, not seconds
  });

  it("step 8: render is an honest 501", async () => {
    const r = await s.call("POST", `/api/v1/sessions/${sessionId}/render`, {});
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("after a restart (new API, empty memory) replay gives the identical hash, and editing continues", async () => {
    const before = (await s.call("GET", `/api/v1/sessions/${sessionId}/timeline`)).body.timeline_hash;
    await s.restartApi();
    const after = (await s.call("GET", `/api/v1/sessions/${sessionId}/timeline`)).body.timeline_hash;
    expect(after).toBe(before);
    const next = await s.call("POST", `/api/v1/sessions/${sessionId}/instructions`, { say: "undo" });
    expect(next.body.status).toBe("applied");
    const again = await s.call("POST", `/api/v1/sessions/${sessionId}/instructions`, { say: "redo" });
    expect(again.body.timeline_hash).toBe(before);
  });
});
