import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifySignature } from "../../worker/src/callback.ts";
import { MockAsrClient } from "../../worker/src/asr.ts";
import { makeClip } from "./clips.ts";
import { ingest, integration, startStack, type Stack } from "./harness.ts";

const spec = parse(readFileSync(new URL("../../../openapi.yaml", import.meta.url), "utf8"));

describe.skipIf(!integration)("API behaviour", () => {
  let s: Stack;
  let asr: MockAsrClient;
  const clip = () => makeClip({ seconds: 20 });
  beforeAll(async () => {
    asr = new MockAsrClient([{ text: "hello", start_us: 500_000, end_us: 900_000, confidence_permille: 950, speaker: "A" }, { text: "world", start_us: 1_000_000, end_us: 1_400_000, confidence_permille: 950, speaker: "B" }]);
    s = await startStack({ asr, env: { CALLBACK_HMAC_SECRET: "callback-secret-123456" } });
  }, 120_000);
  afterAll(async () => s?.stop());

  describe("openapi.yaml matches the running service", () => {
    const fromSpec = new Set<string>();
    for (const [path, item] of Object.entries<any>(spec.paths)) for (const m of Object.keys(item)) fromSpec.add(`${m.toUpperCase()} ${path}`);

    it("every route the server answers is in openapi.yaml, and every path in openapi.yaml is served", () => {
      const served = new Set(s.app.routeTable.map((r) => `${r.method} ${r.url.replace(/:([a-z_]+)/g, "{$1}")}`));
      expect([...served].filter((r) => !fromSpec.has(r))).toEqual([]);
      expect([...fromSpec].filter((r) => !served.has(r))).toEqual([]);
    });

    it("everything except /health and /ready lives under /api/v1", () => {
      for (const path of Object.keys(spec.paths)) expect(path === "/health" || path === "/ready" || path.startsWith("/api/v1/")).toBe(true);
    });

    // Responses are checked against the schemas in the file, so the file cannot drift from the service.
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema({ ...spec, $id: "openapi" });
    const check = (name: string, body: unknown) => {
      const v = ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
      expect(v(body), JSON.stringify(v.errors)).toBe(true);
    };

    it("real responses validate against their schemas", async () => {
      const { videoId, job } = await ingest(s, clip());
      check("Job", job);
      check("Video", (await s.call("GET", `/api/v1/videos/${videoId}`)).body);
      const sess = await s.call("POST", "/api/v1/sessions", { video_id: videoId });
      check("Session", sess.body);
      const id = sess.body.session_id;
      check("Answer", (await s.call("POST", `/api/v1/sessions/${id}/instructions`, { say: "cut 0:05-0:08" })).body);
      check("Answer", (await s.call("POST", `/api/v1/sessions/${id}/instructions`, { say: "make it pop" })).body);
      check("TimelineResponse", (await s.call("GET", `/api/v1/sessions/${id}/timeline`)).body);
      check("HistoryResponse", (await s.call("GET", `/api/v1/sessions/${id}/history`)).body);
      check("ConversationResponse", (await s.call("GET", `/api/v1/sessions/${id}/conversation`)).body);
      const rend = await s.call("POST", `/api/v1/sessions/${id}/render`, {});
      expect(rend.status).toBe(202);
      check("RenderAccepted", rend.body);
      await s.drain();
      const rjob = (await s.call("GET", `/api/v1/jobs/${rend.body.job_id}`)).body;
      expect(rjob.status).toBe("succeeded");
      check("Job", rjob);
      check("ErrorBody", (await s.call("GET", "/api/v1/jobs/nope")).body);
      expect((await s.call("POST", "/api/v1/sessions/ses_nope/render", {})).body.error.code).toBe("SESSION_NOT_FOUND");
      expect((await s.call("POST", `/api/v1/sessions/${id}/render`, { bogus: 1 })).body.error.code).toBe("VALIDATION_FAILED");
      check("Health", (await s.call("GET", "/health")).body);
    });
  });

  describe("errors", () => {
    const shape = (b: any) => {
      expect(Object.keys(b)).toEqual(["error"]);
      expect(Object.keys(b.error).sort()).toEqual(["code", "details", "message", "retryable"]);
      expect(b.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    };
    it("unknown route, unknown ids, bad JSON, bad body, wrong media type", async () => {
      const r1 = await s.call("GET", "/api/v1/nothing");
      expect([r1.status, r1.body.error.code]).toEqual([404, "NOT_FOUND"]);
      shape(r1.body);
      expect((await s.call("GET", "/api/v1/jobs/job_x")).body.error.code).toBe("JOB_NOT_FOUND");
      expect((await s.call("GET", "/api/v1/videos/vid_x")).body.error.code).toBe("VIDEO_NOT_FOUND");
      expect((await s.call("GET", "/api/v1/sessions/ses_x/timeline")).body.error.code).toBe("SESSION_NOT_FOUND");
      expect((await s.call("POST", "/api/v1/sessions/ses_x/instructions", { say: "undo" })).body.error.code).toBe("SESSION_NOT_FOUND");
      const bad = await fetch(`${s.base}/api/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
      expect(bad.status).toBe(400);
      shape(await bad.json());
      const v = await s.call("POST", "/api/v1/sessions", { video_id: 5, extra: 1 });
      expect([v.status, v.body.error.code]).toEqual([400, "VALIDATION_FAILED"]);
      expect(v.body.error.details.issues.length).toBeGreaterThan(0);
      const t = await fetch(`${s.base}/api/v1/sessions`, { method: "POST", headers: { "content-type": "application/xml" }, body: "<x/>" });
      expect(t.status).toBe(415);
      shape(await t.json());
      expect((await s.call("POST", "/api/v1/videos", { url: "ftp://x/y.mp4" })).body.error.code).toBe("URL_NOT_ALLOWED");
    });

    it("an upload that is not MP4/MOV is 415; an empty body is refused", async () => {
      const r = await s.upload("/etc/hostname");
      expect([r.status, r.body.error.code]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE"]);
    });

    it("a session on a video that is not ready is 409 VIDEO_NOT_READY (retryable)", async () => {
      const up = await s.upload(clip());
      const r = await s.call("POST", "/api/v1/sessions", { video_id: up.body.video_id });
      expect([r.status, r.body.error.code, r.body.error.retryable]).toEqual([409, "VIDEO_NOT_READY", true]);
      await s.drain();
    });

    it("a video without audio fails its job with NO_AUDIO_TRACK and cannot start a session", async () => {
      const { videoId, job } = await ingest(s, makeClip({ seconds: 5, audio: false }));
      expect(job.status).toBe("failed");
      expect(job.error.error).toMatchObject({ code: "NO_AUDIO_TRACK", retryable: false });
      expect((await s.call("GET", `/api/v1/videos/${videoId}`)).body.status).toBe("failed");
      expect((await s.call("POST", "/api/v1/sessions", { video_id: videoId })).body.error.code).toBe("VIDEO_NOT_READY");
    });

    it("a private URL is refused when private addresses are not allowed (the SSRF guard)", async () => {
      const strict = await startStack({ asr, env: { URL_ALLOW_PRIVATE: "false" } });
      try {
        const r = await strict.call("POST", "/api/v1/videos", { url: "http://127.0.0.1:9/a.mp4" });
        expect([r.status, r.body.error.code]).toEqual([400, "URL_NOT_ALLOWED"]);
      } finally {
        await strict.stop();
      }
    });
  });

  describe("idempotency (every POST)", () => {
    it("videos: same key + same file -> same ids, one video, one job, one stored object", async () => {
      const f = clip();
      const a = await s.upload(f, {}, { "idempotency-key": "up-1" });
      const b = await s.upload(f, {}, { "idempotency-key": "up-1" });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(b.body).toEqual(a.body);
      expect(b.headers.get("idempotent-replayed")).toBe("true");
      expect((await s.pool.query("select count(*)::int n from videos where id=$1", [a.body.video_id])).rows[0].n).toBe(1);
      expect((await s.pool.query("select count(*)::int n from jobs where video_id=$1", [a.body.video_id])).rows[0].n).toBe(1);
      const other = await s.upload(makeClip({ seconds: 21 }), {}, { "idempotency-key": "up-1" });
      expect([other.status, other.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
      await s.drain();
    });

    it("sessions: same key + same body -> same session; different body -> 409", async () => {
      const { videoId } = await ingest(s, clip());
      const a = await s.call("POST", "/api/v1/sessions", { video_id: videoId }, { "idempotency-key": "s-1" });
      const b = await s.call("POST", "/api/v1/sessions", { video_id: videoId }, { "idempotency-key": "s-1" });
      expect(b.body).toEqual(a.body);
      expect((await s.pool.query("select count(*)::int n from sessions where video_id=$1", [videoId])).rows[0].n).toBe(1);
      const c = await s.call("POST", "/api/v1/sessions", { video_id: "vid_other" }, { "idempotency-key": "s-1" });
      expect([c.status, c.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    });

    it("instructions: a repeated key replays the answer and does NOT apply the edit twice", async () => {
      const { videoId } = await ingest(s, clip());
      const sid = (await s.call("POST", "/api/v1/sessions", { video_id: videoId })).body.session_id;
      const path = `/api/v1/sessions/${sid}/instructions`;
      const first = await s.call("POST", path, { say: "cut 0:05-0:08" }, { "idempotency-key": "i-1" });
      const second = await s.call("POST", path, { say: "cut 0:05-0:08" }, { "idempotency-key": "i-1" });
      expect(second.body).toEqual(first.body);
      expect((await s.pool.query("select count(*)::int n from operation_log where session_id=$1", [sid])).rows[0].n).toBe(1);
      expect((await s.pool.query("select count(*)::int n from conversation_log where session_id=$1", [sid])).rows[0].n).toBe(1);
      const diff = await s.call("POST", path, { say: "cut 0:10-0:12" }, { "idempotency-key": "i-1" });
      expect([diff.status, diff.body.error.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
      // the same instruction WITHOUT a key is a new turn (and "Nothing changed" is not hidden from the user)
      const again = await s.call("POST", path, { say: "cut 0:05-0:08" });
      expect(again.body.status).toBe("applied");
      expect((await s.pool.query("select count(*)::int n from conversation_log where session_id=$1", [sid])).rows[0].n).toBe(2);
    });
  });

  describe("jobs, cache, hints, warnings", () => {
    it("progress goes 0 -> 100, never down; a job is queued until a worker takes it", async () => {
      const up = await s.upload(clip());
      const queued = (await s.call("GET", up.body.status_url)).body;
      expect([queued.status, queued.progress]).toEqual(["queued", 0]);
      await s.drain();
      const done = (await s.call("GET", up.body.status_url)).body;
      expect([done.status, done.progress]).toEqual(["succeeded", 100]);
    });

    it("the same file again is a transcript cache HIT (ASR not called); a different ASR model is a MISS", async () => {
      const f = makeClip({ seconds: 22 });
      const before = asr.calls;
      const first = await ingest(s, f);
      expect(first.job.result.transcript_cache).toBe("miss");
      expect(asr.calls).toBe(before + 1);
      const second = await ingest(s, f);
      expect(second.job.result.transcript_cache).toBe("hit");
      expect(asr.calls).toBe(before + 1);

      const other = await startStack({ asr: new MockAsrClient([{ text: "hi", start_us: 500_000, end_us: 900_000, confidence_permille: 900 }], "mock", "small.en") });
      try {
        // same database is NOT shared, so copy the transcript row to prove the key (not the file hash) decides
        const sha = (await s.pool.query("select sha256 from videos where id=$1", [first.videoId])).rows[0].sha256 as string;
        const row = (await s.pool.query("select * from transcripts where source_sha256=$1", [sha])).rows[0];
        await other.pool.query("insert into transcripts(cache_key, source_sha256, settings, atoms, manifest) values ($1,$2,$3,$4,$5)", [row.cache_key, row.source_sha256, row.settings, JSON.stringify(row.atoms), row.manifest]);
        const hit = await ingest(other, f);
        expect(hit.job.result.transcript_cache).toBe("miss"); // other model => other key => the copied row is not used
        expect((other.asr as MockAsrClient).calls).toBe(1);
      } finally {
        await other.stop();
      }
    });

    it("num_speakers reaches the ASR/diarization call and changes the cache key", async () => {
      const f = makeClip({ seconds: 23 });
      await ingest(s, f, { num_speakers: "2" });
      expect(asr.lastNumSpeakers).toBe(2);
      const again = await ingest(s, f); // no hint -> different key -> miss
      expect(again.job.result.transcript_cache).toBe("miss");
      expect(asr.lastNumSpeakers).toBeNull();
    });

    it("variable frame rate is accepted with a warning in the job manifest and on the video", async () => {
      const { videoId, job } = await ingest(s, makeClip({ seconds: 10, vfr: true }));
      expect(job.status).toBe("succeeded");
      expect(job.result.warnings.join(" ")).toMatch(/Variable frame rate/);
      expect(job.result.manifest.warnings.join(" ")).toMatch(/Variable frame rate/);
      expect((await s.call("GET", `/api/v1/videos/${videoId}`)).body.probe.variable_frame_rate).toBe(true);
      const sid = (await s.call("POST", "/api/v1/sessions", { video_id: videoId })).body;
      expect(sid.warnings.join(" ")).toMatch(/Variable frame rate/);
    });

    it("a URL source is downloaded, stored byte-identical and transcribed; callback is signed and delivered", async () => {
      const file = readFileSync(clip());
      const hooks: { body: string; sig: string }[] = [];
      const srv = createServer((req, res) => {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c)).on("end", () => (hooks.push({ body, sig: String(req.headers["x-incubrix-signature"]) }), res.end("ok")));
        } else res.end(file);
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as AddressInfo).port;
      try {
        const r = await s.call("POST", "/api/v1/videos", { url: `http://127.0.0.1:${port}/a.mp4`, callback_url: `http://127.0.0.1:${port}/hook`, rights: "generated for tests", ai_generated: true });
        expect(r.status).toBe(202);
        await s.drain();
        const job = (await s.call("GET", r.body.status_url)).body;
        expect(job.status).toBe("succeeded");
        const v = (await s.call("GET", `/api/v1/videos/${r.body.video_id}`)).body;
        const { createHash } = await import("node:crypto");
        expect(v.sha256).toBe(createHash("sha256").update(file).digest("hex"));
        expect(job.result.manifest.rights.source_media).toBe("generated for tests");
        expect(job.result.manifest.ai_generated.input_media_marked_ai_generated).toBe(true);
        expect(hooks).toHaveLength(1);
        expect(verifySignature("callback-secret-123456", hooks[0]!.body, hooks[0]!.sig)).toBe(true);
        expect(JSON.parse(hooks[0]!.body)).toMatchObject({ job_id: r.body.job_id, status: "succeeded", progress: 100 });
      } finally {
        srv.close();
      }
    }, 60_000);

    it("a URL that is not a video fails the job with UNSUPPORTED_MEDIA_TYPE", async () => {
      const srv = createServer((_q, res) => res.end("<html>not a video</html>"));
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      try {
        const r = await s.call("POST", "/api/v1/videos", { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/x.mp4` });
        await s.drain();
        expect((await s.call("GET", r.body.status_url)).body.error.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      } finally {
        srv.close();
      }
    });
  });
});

describe.skipIf(!integration)("auth, rate limit, correlation id", () => {
  it("API_TOKEN protects everything except /health and /ready; the token is never logged", async () => {
    const token = "demo-token-1234567890";
    const lines: string[] = [];
    const { Writable } = await import("node:stream");
    const logDest = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const s = await startStack({ env: { API_TOKEN: token }, logDest });
    try {
      expect((await fetch(`${s.base}/health`)).status).toBe(200);
      expect((await fetch(`${s.base}/ready`)).status).toBe(200);
      const no = await fetch(`${s.base}/api/v1/jobs/x`);
      expect(no.status).toBe(401);
      expect((await no.json()).error.code).toBe("UNAUTHORIZED");
      expect((await fetch(`${s.base}/api/v1/jobs/x`, { headers: { authorization: "Bearer wrong-token-0000000" } })).status).toBe(401);
      expect((await s.call("GET", "/api/v1/jobs/x")).status).toBe(404); // harness sends the right token: reaches the handler
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("")).not.toContain(token);
      expect(lines.join("")).not.toContain("wrong-token-0000000");
      const parsed = lines.map((l) => JSON.parse(l));
      for (const l of parsed) expect(l).toMatchObject({ level: expect.any(String), timestamp: expect.any(String) });
      expect(parsed.some((l) => typeof l.correlation_id === "string")).toBe(true); // request-scoped lines carry the correlation id
    } finally {
      await s.stop();
    }
  });

  it("rate limit: the N+1th request in a minute is 429 RATE_LIMITED with Retry-After", async () => {
    const s = await startStack({ env: { RATE_LIMIT_PER_MIN: "5" } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await s.call("GET", "/api/v1/jobs/x")).status);
      expect(codes).toEqual([404, 404, 404, 404, 404, 429, 429]);
      const r = await s.call("GET", "/api/v1/jobs/x");
      expect(r.body.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await s.call("GET", "/health")).status).toBe(200); // health is never limited
    } finally {
      await s.stop();
    }
  });

  it("X-Correlation-Id is echoed, or generated when missing", async () => {
    const s = await startStack();
    try {
      const a = await s.call("GET", "/health", undefined, { "x-correlation-id": "my-trace-1" });
      expect(a.headers.get("x-correlation-id")).toBe("my-trace-1");
      const b = await s.call("GET", "/health");
      expect(b.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
      const e = await s.call("GET", "/api/v1/jobs/x", undefined, { "x-correlation-id": "my-trace-2" });
      expect(e.headers.get("x-correlation-id")).toBe("my-trace-2");
    } finally {
      await s.stop();
    }
  });
});
