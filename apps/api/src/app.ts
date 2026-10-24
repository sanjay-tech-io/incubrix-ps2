import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import multipart from "@fastify/multipart";
import type { Config } from "@incubrix/config";
import {
  currentTimeline, effectDisplay, timelineHash, materialize, formatTime, type Effect,
} from "@incubrix/engine";
import { ApiError, ERRORS, errorBody } from "@incubrix/errors";
import { applyParsed, topicRequest, type InstructionParser, type SideData } from "@incubrix/nlu";
import type { SemanticService } from "@incubrix/semantic";
import type { CallInfo, LlmFallback } from "@incubrix/llm";
import { presignGet, putFile, putText } from "@incubrix/storage";
import { buildOtioPayload, type OtioExporter } from "@incubrix/otio";
import { isDocPath, registerDocs } from "./docs.ts";
import {
  appendTurn, assertUrlAllowed, findStoredOriginal, createJob, createSession, createVideo, getJob, getSession, getVideo, jobView, lockSession, requestHash, tx, withIdempotency,
  type Logger,
} from "@incubrix/store";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { answerView, instructionManifest } from "./answer.ts";
import { RateLimiter } from "./ratelimit.ts";
import { RuntimeCache } from "./runtime.ts";

export interface ApiDeps {
  pool: pg.Pool;
  s3: S3Client;
  /** Client used only to sign download links (its endpoint is the one clients can reach). */
  s3Public: S3Client;
  cfg: Config;
  log: Logger;
  parser: InstructionParser;
  /** Meaning search (null = off: exact words only, and the answer says so). */
  semantic?: SemanticService | null;
  /** Language-model fallback (null = off). Used only when the rules parser does not understand an instruction. */
  llm?: LlmFallback | null;
  /** OpenTimelineIO exporter (OTIO_PROVIDER: the Python service, or the mock). */
  otio: OtioExporter;
  now?: () => number;
}

export interface RouteRecord {
  method: string;
  url: string;
}

// The probes answer at the root and under /api/v1 (same handlers, same answers): a reviewer may look in either place.
const PUBLIC_PATHS = new Set(["/health", "/ready", "/api/v1/health", "/api/v1/ready"]);

const CreateVideoUrl = z.strictObject({
  url: z.url(),
  num_speakers: z.number().int().min(1).max(20).optional(),
  callback_url: z.url().optional(),
  rights: z.string().max(500).optional(),
  ai_generated: z.boolean().optional(),
});
const CreateSession = z.strictObject({ video_id: z.string().min(1) });
const RenderBody = z.strictObject({ callback_url: z.url().optional() });
const InstructionBody = z
  .strictObject({ say: z.string().trim().min(1).max(2000).optional(), answer: z.union([z.number().int().min(1), z.string().trim().min(1).max(200)]).optional() })
  .refine((b) => b.say !== undefined || b.answer !== undefined, { message: "send `say` or `answer`" });

function zodDetails(e: z.ZodError): Record<string, unknown> {
  return { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ApiError("VALIDATION_FAILED", "The request body is invalid.", zodDetails(r.error));
  return r.data;
}

function singleHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function buildApp(d: ApiDeps): Promise<FastifyInstance & { routeTable: RouteRecord[] }> {
  const { pool, cfg } = d;
  const app = Fastify({
    loggerInstance: d.log,
    // The correlation id is the request id: taken from X-Correlation-Id or generated, bound into every log line, echoed back.
    genReqId: (req) => singleHeader(req.headers["x-correlation-id"])?.slice(0, 100) || randomUUID(),
    // Every request-scoped log line (including Fastify's own) carries correlation_id.
    childLoggerFactory: (logger, bindings) => logger.child({ correlation_id: (bindings as { reqId?: string }).reqId }),
    exposeHeadRoutes: false,
    bodyLimit: 1024 * 1024,
    // Behind Caddy (TRUST_PROXY=true) req.ip is the client's address from X-Forwarded-For, which Caddy overwrites; otherwise it is the socket peer.
    trustProxy: cfg.TRUST_PROXY,
  }) as unknown as FastifyInstance & { routeTable: RouteRecord[] }; // pino's Logger vs Fastify's FastifyBaseLogger only differ in types
  const routeTable: RouteRecord[] = [];
  app.routeTable = routeTable;
  app.addHook("onRoute", (r) => {
    // The documentation routes are tooling, not API: the contract test compares only the documented API routes.
    if (isDocPath(r.url.replace(/:name$/, "x"))) return;
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "OPTIONS") routeTable.push({ method: m, url: r.url });
  });

  await app.register(multipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 2000 } });
  const limiter = new RateLimiter(cfg.RATE_LIMIT_PER_MIN, 60_000, d.now);
  const runtimes = new RuntimeCache(cfg.MAX_SPEED);

  // ---- cross-cutting hooks -------------------------------------------------------------------------------------
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Correlation-Id", req.id);
    const path = req.url.split("?")[0]!;
    if (PUBLIC_PATHS.has(path) || isDocPath(path)) return;
    // Rate limit BEFORE the token check, per client IP: otherwise a wrong token costs nothing and can be guessed without limit.
    const wait = limiter.hit(req.ip);
    if (wait > 0) {
      reply.header("Retry-After", String(wait));
      throw new ApiError("RATE_LIMITED", `Too many requests. Try again in ${wait} s.`, { retry_after_s: wait });
    }
    if (cfg.API_TOKEN) {
      const header = singleHeader(req.headers.authorization) ?? "";
      const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
      const want = Buffer.from(cfg.API_TOKEN);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new ApiError("UNAUTHORIZED", "Missing or wrong access token. Send `Authorization: Bearer <token>`.");
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    let api: ApiError;
    if (err instanceof ApiError) api = err;
    else if (err.code === "FST_REQ_FILE_TOO_LARGE" || err.code === "FST_ERR_CTP_BODY_TOO_LARGE") api = new ApiError("FILE_TOO_LARGE", `The request is larger than the limit (${cfg.MAX_UPLOAD_MB} MB for uploads).`);
    else if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") api = new ApiError("UNSUPPORTED_MEDIA_TYPE", "Send JSON (application/json) or a multipart upload.");
    else if (err instanceof z.ZodError) api = new ApiError("VALIDATION_FAILED", "The request is invalid.", zodDetails(err));
    else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) api = new ApiError("VALIDATION_FAILED", err.message);
    else {
      req.log.error({ err: err.message, stack: err.stack }, "unhandled error");
      api = new ApiError("INTERNAL_ERROR", "Unexpected server error.", { correlation_id: req.id });
    }
    if (api.code === "INTERNAL_ERROR") api = new ApiError("INTERNAL_ERROR", api.message, { correlation_id: req.id });
    void reply.status(ERRORS[api.code].status).send(api.body());
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send(errorBody("NOT_FOUND", `No route ${req.method} ${req.url.split("?")[0]}.`));
  });

  const idem = async (req: FastifyRequest, reply: FastifyReply, scope: string, hash: string, work: () => Promise<{ status: number; body: unknown }>) => {
    const key = singleHeader(req.headers["idempotency-key"]);
    if (key !== undefined && (key.length === 0 || key.length > 200)) throw new ApiError("VALIDATION_FAILED", "Idempotency-Key must be 1 to 200 characters.");
    const r = await withIdempotency(pool, scope, key, hash, work);
    if (r.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(r.status).send(r.body);
  };

  registerDocs(app, new URL("../../../openapi.yaml", import.meta.url));

  // ---- ops -------------------------------------------------------------------------------------------------------
  // HEAD is registered next to GET on purpose (uptime checkers and `curl -I` use it). Same handler, so the same status;
  // Fastify sends no body for HEAD. Auto-created HEAD routes stay off (exposeHeadRoutes: false) so HEAD is not open elsewhere.
  const health = async () => ({ status: "ok", service: "api" });
  const ready = async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      await pool.query("select 1");
      await d.s3.send(new HeadBucketCommand({ Bucket: cfg.S3_BUCKET }));
      return { status: "ready", service: "api" };
    } catch (e) {
      d.log.warn({ err: (e as Error).message }, "not ready");
      return reply.status(503).send(errorBody("SERVICE_UNAVAILABLE", "Database or storage is not reachable."));
    }
  };
  app.route({ method: ["GET", "HEAD"], url: "/health", handler: health });
  app.route({ method: ["GET", "HEAD"], url: "/ready", handler: ready });
  app.route({ method: ["GET", "HEAD"], url: "/api/v1/health", handler: health });
  app.route({ method: ["GET", "HEAD"], url: "/api/v1/ready", handler: ready });

  // ---- videos ----------------------------------------------------------------------------------------------------
  app.post("/api/v1/videos", async (req, reply) => {
    if (req.isMultipart()) return uploadVideo(req, reply);
    const body = parseBody(CreateVideoUrl, req.body);
    await assertUrlAllowed(body.url, cfg.URL_ALLOW_PRIVATE);
    if (body.callback_url) await assertUrlAllowed(body.callback_url, cfg.URL_ALLOW_PRIVATE);
    return idem(req, reply, "POST /api/v1/videos", requestHash({ kind: "url", ...body }), async () => {
      const videoId = await createVideo(pool, { sourceUrl: body.url, ...(body.num_speakers ? { numSpeakers: body.num_speakers } : {}), ...(body.rights ? { rights: body.rights } : {}), aiGenerated: body.ai_generated ?? false });
      const jobId = await createJob(pool, { type: "ingest", videoId, callbackUrl: body.callback_url ?? null });
      return { status: 202, body: { video_id: videoId, job_id: jobId, status_url: `/api/v1/jobs/${jobId}` } };
    });
  });

  async function uploadVideo(req: FastifyRequest, reply: FastifyReply) {
    const dir = await mkdtemp(join(tmpdir(), "incubrix-upload-"));
    try {
      const fields: Record<string, string> = {};
      let file: { path: string; filename: string; sha256: string; size: number } | null = null;
      for await (const part of req.parts()) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value);
          continue;
        }
        if (part.fieldname !== "file" || file) {
          part.file.resume();
          continue;
        }
        const hash = createHash("sha256");
        let size = 0;
        let head: Buffer | null = null;
        const meter = new Transform({
          transform(chunk: Buffer, _e, cb) {
            if (head === null) {
              head = chunk.subarray(0, 12);
              // MP4 and MOV both carry an "ftyp" box at bytes 4-8.
              if (head.length < 12 || head.toString("latin1", 4, 8) !== "ftyp") return cb(new ApiError("UNSUPPORTED_MEDIA_TYPE", "Only MP4 and MOV videos are accepted."));
            }
            size += chunk.length;
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        const path = join(dir, "upload");
        await pipeline(part.file, meter, createWriteStream(path));
        if (part.file.truncated) throw new ApiError("FILE_TOO_LARGE", `The upload is larger than ${cfg.MAX_UPLOAD_MB} MB.`);
        if (size === 0) throw new ApiError("VALIDATION_FAILED", "The uploaded file is empty.");
        file = { path, filename: part.filename ?? "upload.mp4", sha256: hash.digest("hex"), size };
      }
      if (!file) throw new ApiError("VALIDATION_FAILED", "Send the video in a multipart field named `file`.");
      const meta = parseBody(
        z.strictObject({
          num_speakers: z.coerce.number().int().min(1).max(20).optional(),
          callback_url: z.url().optional(),
          rights: z.string().max(500).optional(),
          ai_generated: z.enum(["true", "false"]).optional(),
        }),
        fields,
      );
      if (meta.callback_url) await assertUrlAllowed(meta.callback_url, cfg.URL_ALLOW_PRIVATE);
      const f = file;
      const ext = /\.mov$/i.test(f.filename) ? ".mov" : ".mp4";
      return await idem(req, reply, "POST /api/v1/videos", requestHash({ kind: "upload", sha256: f.sha256, size: f.size, filename: f.filename, ...meta }), async () => {
        // The original goes to storage byte for byte; only its hash and size are recorded.
        const videoId = await createVideo(pool, {
          sha256: f.sha256, filename: f.filename, sizeBytes: f.size, mimeType: ext === ".mov" ? "video/quicktime" : "video/mp4",
          ...(meta.num_speakers ? { numSpeakers: meta.num_speakers } : {}), ...(meta.rights ? { rights: meta.rights } : {}), aiGenerated: meta.ai_generated === "true",
        });
        // The same bytes are stored once: a second upload of an identical file points at the first object.
        const key = (await findStoredOriginal(pool, f.sha256)) ?? `videos/${videoId}/original${ext}`;
        if (key === `videos/${videoId}/original${ext}`) await putFile(d.s3, cfg.S3_BUCKET, key, f.path, ext === ".mov" ? "video/quicktime" : "video/mp4");
        await pool.query("update videos set storage_key=$2 where id=$1", [videoId, key]);
        const jobId = await createJob(pool, { type: "ingest", videoId, callbackUrl: meta.callback_url ?? null });
        return { status: 202, body: { video_id: videoId, job_id: jobId, status_url: `/api/v1/jobs/${jobId}` } };
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  app.get("/api/v1/videos/:video_id", async (req) => {
    const { video_id } = req.params as { video_id: string };
    const v = await getVideo(pool, video_id);
    if (!v) throw new ApiError("VIDEO_NOT_FOUND", `video ${video_id} does not exist`);
    return {
      video_id: v.id, status: v.status, sha256: v.sha256, filename: v.filename, size_bytes: v.size_bytes === null ? null : Number(v.size_bytes),
      probe: v.probe, warnings: v.warnings,
      download_url: v.storage_key ? await presignGet(d.s3Public, cfg.S3_BUCKET, v.storage_key, 3600) : null,
    };
  });

  // ---- sessions --------------------------------------------------------------------------------------------------
  const sessionView = async (sessionId: string) => {
    const rt = await runtimes.get(pool, sessionId);
    const tl = currentTimeline(rt.ctx, rt.state);
    return { session_id: sessionId, video_id: rt.videoId, duration_s: tl.durationUs / 1e6, timeline_hash: timelineHash(tl), warnings: rt.video.warnings };
  };

  app.post("/api/v1/sessions", async (req, reply) => {
    const body = parseBody(CreateSession, req.body);
    return idem(req, reply, "POST /api/v1/sessions", requestHash(body), async () => {
      const v = await getVideo(pool, body.video_id);
      if (!v) throw new ApiError("VIDEO_NOT_FOUND", `video ${body.video_id} does not exist`);
      if (v.status !== "ready" || !v.probe || !v.sha256) throw new ApiError("VIDEO_NOT_READY", `video ${v.id} is ${v.status}; wait for its job to succeed.`);
      const probe = v.probe as { duration_us: number; fps: { num: number; den: number } | null; has_audio: boolean; has_video: boolean; variable_frame_rate: boolean };
      const sessionId = await createSession(pool, v.id, v.sha256, {
        sha256: v.sha256, durationUs: probe.duration_us, fps: probe.fps, hasAudio: probe.has_audio, hasVideo: probe.has_video, variableFrameRate: probe.variable_frame_rate,
      });
      return { status: 201, body: await sessionView(sessionId) };
    });
  });

  app.get("/api/v1/sessions/:session_id", async (req) => sessionView((req.params as { session_id: string }).session_id));

  app.post("/api/v1/sessions/:session_id/instructions", async (req, reply) => {
    const { session_id } = req.params as { session_id: string };
    const body = parseBody(InstructionBody, req.body);
    if (!(await getSession(pool, session_id))) throw new ApiError("SESSION_NOT_FOUND", `session ${session_id} does not exist`);
    return idem(req, reply, `POST /api/v1/sessions/${session_id}/instructions`, requestHash(body), async () => {
      // Needs I/O, so it runs BEFORE the transaction and the per-session lock: the meaning-search hits of the instruction's topic.
      const side: SideData = {};
      let semantic: { model: string; ms: number; hits: number; passages: string; query: string } | null = null;
      const topic = body.answer === undefined && body.say ? topicRequest(body.say) : null;
      if (topic) {
        const rt0 = await runtimes.get(pool, session_id);
        if (!d.semantic) side.semanticNote = "Meaning search is off (EMBED_PROVIDER=none); only exact words were searched.";
        else {
          try {
            const r = await d.semantic.search(rt0.video.transcript_key!, rt0.ctx.index.atoms, topic);
            side.semantic = { topic: r.topic, hits: r.hits.map((h) => ({ startUs: h.startUs, endUs: h.endUs, text: h.text, scorePermille: h.scorePermille, speaker: h.speaker })) };
            semantic = { model: r.modelId, ms: r.timings.ms, hits: r.hits.length, passages: r.timings.passages, query: r.timings.query };
          } catch (e) {
            d.log.warn({ err: (e as Error).message }, "meaning search unavailable");
            side.semanticNote = "Meaning search is unavailable (the embedding service did not answer); only exact words were searched.";
          }
        }
      }
      const result = await tx(pool, async (c) => {
        // One instruction at a time per session, across processes; the state is re-read under the lock.
        await lockSession(c, session_id);
        const rt = await runtimes.get(c, session_id);
        const t0 = performance.now();
        const cpu0 = process.cpuUsage();
        const text = body.say ?? String(body.answer);
        const input = { text, side: { ...side, possibleFillers: rt.possibleFillers }, ...(body.answer === undefined ? {} : { answer: body.answer }) };
        let parsed = d.parser.parse({ ctx: rt.ctx, state: rt.state, ...input });
        let llmCall: CallInfo | null = null;
        let llmOffNote: string | null = null;
        if (parsed.kind === "reject" && parsed.unparsed && body.answer === undefined) {
          if (d.llm) {
            const r = await d.llm.translate(rt.ctx, rt.state, text);
            parsed = r.parsed;
            llmCall = r.call;
          } else if (cfg.LLM_PROVIDER === "gemini") {
            llmOffNote = "GEMINI_API_KEY is empty";
            parsed = { ...parsed, reason: `${parsed.reason} The language-model fallback is off (GEMINI_API_KEY is empty), so only the built-in instructions work.` };
          }
        }
        const turn = applyParsed(rt.ctx, rt.state, text, parsed);
        await appendTurn(c, session_id, rt.state, turn.state);
        const cpu = process.cpuUsage(cpu0);
        const ms = performance.now() - t0;
        runtimes.set({ ...rt, state: turn.state, counts: { log: turn.state.log.length, conversation: turn.state.conversation.length } });
        const manifest = instructionManifest({
          parser: d.parser, llmProvider: cfg.LLM_PROVIDER, maxSpeed: cfg.MAX_SPEED, timePolicy: turn.answer.timePolicy, instructionMs: ms,
          cpuSeconds: (cpu.user + cpu.system) / 1e6, warnings: turn.answer.warnings, rights: rt.video.rights, aiGenerated: rt.video.ai_generated, semantic, llm: llmCall, llmOffNote,
        });
        d.log.info({ session_id, status: turn.answer.status, instruction_ms: Math.round(ms) }, "instruction answered");
        return answerView(turn.answer, { turn: turn.state.conversation.length, manifest });
      }).catch((e) => {
        runtimes.invalidate(session_id); // the cached state may be ahead of the rolled-back database
        throw e;
      });
      return { status: 200, body: result };
    });
  });

  app.get("/api/v1/sessions/:session_id/timeline", async (req) => {
    const { session_id } = req.params as { session_id: string };
    const rt = await runtimes.get(pool, session_id);
    const tl = materialize(rt.ctx, rt.state.log);
    const effects = tl.effects.map((e: Effect) => {
      const disp = effectDisplay(rt.ctx, tl, e);
      return {
        id: e.id, kind: e.params.kind, text: "text" in e.params ? e.params.text : null, state: e.state, partial: e.partial, fragmented: e.fragmented,
        start_s: disp ? disp.startUs / 1e6 : null, end_s: disp ? disp.endUs / 1e6 : null, start: disp ? formatTime(disp.startUs) : null,
      };
    });
    return { session_id, timeline: tl, timeline_hash: timelineHash(tl), duration_s: tl.durationUs / 1e6, effects };
  });

  // Export the CURRENT timeline as OpenTimelineIO. Synchronous: building the file is milliseconds (no media is read).
  // Body = the .otio file; the same bytes are stored in S3 under the timeline hash and the presigned link is in a header.
  app.get("/api/v1/sessions/:session_id/export/otio", async (req, reply) => {
    const { session_id } = req.params as { session_id: string };
    const rt = await runtimes.get(pool, session_id);
    const tl = materialize(rt.ctx, rt.state.log);
    const hash = timelineHash(tl);
    const name = (rt.video.filename ?? "original.mp4").replace(/[^\w.\- ]/g, "_");
    const payload = buildOtioPayload(rt.ctx, tl, {
      name: `session ${session_id}`, sourceName: name, aiGenerated: rt.video.ai_generated,
      extra: { session_id, rights: rt.video.rights ?? null, otio_provider: d.otio.provider },
    });
    const text = await d.otio.export(payload);
    // Keyed by the hash: the same timeline always lands on the same object.
    const key = `exports/${session_id}/${hash}.otio`;
    await putText(d.s3, cfg.S3_BUCKET, key, text, "application/json");
    const link = await presignGet(d.s3Public, cfg.S3_BUCKET, key, 3600);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${session_id}.otio"`)
      .header("X-IncuBrix-Timeline-Hash", hash)
      .header("X-IncuBrix-Export-Provider", d.otio.provider)
      .header("X-IncuBrix-Export-Url", link)
      .send(text);
  });

  app.get("/api/v1/sessions/:session_id/history", async (req) => {
    const { session_id } = req.params as { session_id: string };
    if (!(await getSession(pool, session_id))) throw new ApiError("SESSION_NOT_FOUND", `session ${session_id} does not exist`);
    const { rows } = await pool.query("select seq, group_no, kind, op from operation_log where session_id=$1 order by seq", [session_id]);
    return { session_id, entries: rows.map((r) => ({ seq: r.seq, kind: r.kind, group: r.group_no, op: r.group_no === 0 ? null : r.op })) };
  });

  app.get("/api/v1/sessions/:session_id/conversation", async (req) => {
    const { session_id } = req.params as { session_id: string };
    if (!(await getSession(pool, session_id))) throw new ApiError("SESSION_NOT_FOUND", `session ${session_id} does not exist`);
    const { rows } = await pool.query("select turn, instruction, status, answer, pending_question from conversation_log where session_id=$1 order by turn", [session_id]);
    return {
      session_id,
      turns: rows.map((r) => ({
        turn: r.turn, say: r.instruction, status: r.status, applied_group: r.answer.appliedGroup,
        answer: answerView(r.answer.answer), pending_question: r.pending_question,
      })),
    };
  });

  // Render = a background job over a SNAPSHOT of the timeline taken now (edits made later do not change it).
  app.post("/api/v1/sessions/:session_id/render", async (req, reply) => {
    const { session_id } = req.params as { session_id: string };
    const body = parseBody(RenderBody, req.body ?? {});
    if (!(await getSession(pool, session_id))) throw new ApiError("SESSION_NOT_FOUND", `session ${session_id} does not exist`);
    if (body.callback_url) await assertUrlAllowed(body.callback_url, cfg.URL_ALLOW_PRIVATE);
    return idem(req, reply, `POST /api/v1/sessions/${session_id}/render`, requestHash({ session_id, ...body }), async () => {
      const rt = await runtimes.get(pool, session_id);
      const tl = currentTimeline(rt.ctx, rt.state);
      const hash = timelineHash(tl);
      const jobId = await createJob(pool, { type: "render", sessionId: session_id, callbackUrl: body.callback_url ?? null, request: { session_id, timeline: tl, timeline_hash: hash } });
      return { status: 202, body: { job_id: jobId, session_id, timeline_hash: hash, duration_s: tl.durationUs / 1e6, status_url: `/api/v1/jobs/${jobId}` } };
    });
  });

  // ---- jobs ------------------------------------------------------------------------------------------------------
  app.get("/api/v1/jobs/:job_id", async (req) => {
    const { job_id } = req.params as { job_id: string };
    const j = await getJob(pool, job_id);
    if (!j) throw new ApiError("JOB_NOT_FOUND", `job ${job_id} does not exist`);
    const view = jobView(j);
    // Download links expire, so they are signed again on every read from the stored object keys.
    const outputs = (j.result as { outputs?: { video: string; manifest: string } } | null)?.outputs;
    if ((j.result as { expired?: boolean } | null)?.expired) view.links = {}; // deleted by retention: no link to a missing object
    else if (j.status === "succeeded" && outputs) {
      view.links = { video: await presignGet(d.s3Public, cfg.S3_BUCKET, outputs.video, 3600), manifest: await presignGet(d.s3Public, cfg.S3_BUCKET, outputs.manifest, 3600) };
    }
    return view;
  });

  return app;
}

export { createReadStream, stat };
