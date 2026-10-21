import { copyFileSync, mkdirSync, openAsBlob, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isRender, type SessionDoc } from "./format.ts";

export interface RunOptions {
  /** API base, e.g. http://localhost:8080 */
  api: string;
  token?: string | undefined;
  /** Output folder; results.json, timeline.json and the rendered videos go here. Omit to run without writing files. */
  outDir?: string | undefined;
  /** Relative `video:` paths are resolved against this folder (default: the current directory). */
  baseDir?: string | undefined;
  pollMs?: number;
  timeoutS?: number;
  /** Called on every poll; tests use it to let an in-process worker run the queued jobs. */
  idle?: () => Promise<void>;
  log?: (line: string) => void;
}

export interface StepResult {
  step: number;
  kind: "say" | "render";
  say: string | null;
  answer_sent: string | number | null;
  expected: string | null;
  passed: boolean;
  http_status: number;
  status: string | null;
  operations: unknown[] | null;
  summary: string | null;
  question: string | null;
  options: unknown[] | null;
  reason: string | null;
  time_policy: string | null;
  warnings: string[] | null;
  timeline_hash: string | null;
  duration_s: number | null;
  ms: number;
  note: string | null;
  /** Manifest facts of an instruction answer: the language model call (if any) and the estimated cost. */
  llm: unknown;
  cost_usd: number | null;
  semantic_ms: number | null;
  /** Render steps only. */
  render?: {
    job_id: string;
    job_status: string;
    error: unknown;
    file: string | null;
    frames: number | null;
    duration_s: number | null;
    timeline_hash: string | null;
    render_seconds_per_output_minute: number | null;
    source_unchanged: boolean | null;
    manifest_file: string | null;
  };
  failure: string | null;
}

export interface SessionResult {
  name: string;
  video: string;
  passed: boolean;
  video_id: string | null;
  session_id: string | null;
  intake: { job_id: string | null; status: string; error: unknown; warnings: string[]; ms: number } | null;
  steps: StepResult[];
  final: { timeline_hash: string; duration_s: number } | null;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Http {
  private readonly base: string;
  private readonly token: string | undefined;
  constructor(base: string, token: string | undefined) {
    this.base = base;
    this.token = token;
  }
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const h: Record<string, string> = { ...headers };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    // 429 RATE_LIMITED is retryable by definition: wait Retry-After (default 5 s) and send the same request again.
    let r: Response;
    for (let attempt = 0; ; attempt++) {
      r = await fetch(this.base + path, { method, headers: h, ...(payload !== undefined ? { body: payload } : {}) });
      if (r.status !== 429 || attempt >= 20) break;
      await sleep(Number(r.headers.get("retry-after") ?? 5) * 1000 + 100);
    }
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: parsed };
  }
}

export async function runSession(doc: SessionDoc, name: string, o: RunOptions): Promise<SessionResult> {
  const log = o.log ?? (() => undefined);
  const http = new Http(o.api.replace(/\/$/, ""), o.token);
  const runId = Math.random().toString(36).slice(2, 10); // only used for Idempotency-Keys, never for anything hashed
  const out = o.outDir ? resolve(o.outDir) : null;
  if (out) mkdirSync(out, { recursive: true });
  const result: SessionResult = { name, video: doc.video, passed: false, video_id: null, session_id: null, intake: null, steps: [], final: null, error: null };

  const waitJob = async (jobId: string): Promise<any> => {
    const deadline = Date.now() + (o.timeoutS ?? 3600) * 1000;
    for (;;) {
      if (o.idle) await o.idle();
      const j = await http.call("GET", `/api/v1/jobs/${jobId}`);
      if (j.status !== 200) throw new Error(`GET job ${jobId} -> ${j.status} ${JSON.stringify(j.body)}`);
      if (j.body.status === "succeeded" || j.body.status === "failed") return j.body;
      if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish within ${o.timeoutS ?? 3600} s (status ${j.body.status}, ${j.body.progress}%)`);
      await sleep(o.pollMs ?? 1000);
    }
  };

  try {
    // 1. the video: local path = upload, URL = the server downloads it
    const t0 = Date.now();
    let accepted;
    if (/^https?:\/\//i.test(doc.video)) {
      accepted = await http.call("POST", "/api/v1/videos", {
        url: doc.video, ...(doc.num_speakers ? { num_speakers: doc.num_speakers } : {}), ...(doc.rights ? { rights: doc.rights } : {}), ...(doc.ai_generated !== undefined ? { ai_generated: doc.ai_generated } : {}),
      }, { "Idempotency-Key": `${runId}-video` });
    } else {
      const path = isAbsolute(doc.video) ? doc.video : resolve(o.baseDir ?? process.cwd(), doc.video);
      const form = new FormData();
      form.append("file", await openAsBlob(path, { type: "video/mp4" }), basename(path));
      if (doc.num_speakers) form.append("num_speakers", String(doc.num_speakers));
      if (doc.rights) form.append("rights", doc.rights);
      if (doc.ai_generated !== undefined) form.append("ai_generated", String(doc.ai_generated));
      accepted = await http.call("POST", "/api/v1/videos", form, { "Idempotency-Key": `${runId}-video` });
    }
    if (accepted.status !== 202) throw new Error(`POST /videos -> ${accepted.status} ${JSON.stringify(accepted.body)}`);
    result.video_id = accepted.body.video_id;
    log(`video ${result.video_id}, job ${accepted.body.job_id}`);
    const intake = await waitJob(accepted.body.job_id);
    result.intake = { job_id: accepted.body.job_id, status: intake.status, error: intake.error, warnings: intake.result?.warnings ?? [], ms: Date.now() - t0 };
    if (intake.status !== "succeeded") {
      const code = intake.error?.error?.code ?? "UNKNOWN";
      if (doc.expect_intake_error === code) {
        result.passed = true;
        log(`intake failed with the expected ${code}`);
      } else {
        result.error = `video intake failed: ${code} ${intake.error?.error?.message ?? ""}`;
      }
      finish(result, out);
      return result;
    }
    if (doc.expect_intake_error) {
      result.error = `expected intake to fail with ${doc.expect_intake_error} but it succeeded`;
      finish(result, out);
      return result;
    }

    // 2. the session
    const ses = await http.call("POST", "/api/v1/sessions", { video_id: result.video_id }, { "Idempotency-Key": `${runId}-session` });
    if (ses.status !== 201) throw new Error(`POST /sessions -> ${ses.status} ${JSON.stringify(ses.body)}`);
    const sid: string = ses.body.session_id;
    result.session_id = sid;

    // 3. the steps
    let renders = 0;
    let lastRenderFile: string | null = null;
    for (const [i, step] of doc.steps.entries()) {
      const started = Date.now();
      const base = {
        step: i + 1, say: null as string | null, answer_sent: null as string | number | null, expected: step.expect ?? null, passed: true, http_status: 0, status: null as string | null,
        operations: null as unknown[] | null, summary: null as string | null, question: null as string | null, options: null as unknown[] | null, reason: null as string | null,
        llm: null as unknown, cost_usd: null as number | null, semantic_ms: null as number | null, time_policy: null as string | null, warnings: null as string[] | null, timeline_hash: null as string | null, duration_s: null as number | null, ms: 0, note: step.note ?? null,
        failure: null as string | null,
      };
      if (isRender(step)) {
        renders++;
        const r = await http.call("POST", `/api/v1/sessions/${sid}/render`, {}, { "Idempotency-Key": `${runId}-render-${i}` });
        const sr: StepResult = { ...base, kind: "render", http_status: r.status };
        if (r.status !== 202) {
          sr.passed = false;
          sr.failure = `POST render -> ${r.status} ${JSON.stringify(r.body)}`;
        } else {
          sr.timeline_hash = r.body.timeline_hash;
          sr.duration_s = r.body.duration_s;
          const job = await waitJob(r.body.job_id);
          const m = job.result?.manifest?.render;
          let file: string | null = null;
          let manifestFile: string | null = null;
          if (job.status === "succeeded" && out) {
            file = `render_${renders}.mp4`;
            const dl = await fetch(job.links.video);
            if (!dl.ok) throw new Error(`download of the render failed: ${dl.status}`);
            writeFileSync(join(out, file), Buffer.from(await dl.arrayBuffer()));
            manifestFile = `render_${renders}_manifest.json`;
            writeFileSync(join(out, manifestFile), JSON.stringify(job.result.manifest, null, 2));
            lastRenderFile = file;
          }
          sr.status = job.status;
          sr.render = {
            job_id: r.body.job_id, job_status: job.status, error: job.error, file, frames: job.result?.frames ?? null, duration_s: job.result?.duration_s ?? null,
            timeline_hash: job.result?.timeline_hash ?? null, render_seconds_per_output_minute: m?.render_seconds_per_output_minute ?? null,
            source_unchanged: m?.source?.unchanged ?? null, manifest_file: manifestFile,
          };
          const want = step.expect ?? "succeeded";
          if (job.status !== want) {
            sr.passed = false;
            sr.failure = `render job ${job.status}, expected ${want}${job.error ? `: ${JSON.stringify(job.error)}` : ""}`;
          } else if (want === "failed" && "expect_error" in step && step.expect_error && job.error?.error?.code !== step.expect_error) {
            sr.passed = false;
            sr.failure = `render failed with ${job.error?.error?.code}, expected ${step.expect_error}`;
          }
        }
        sr.ms = Date.now() - started;
        result.steps.push(sr);
        log(`step ${i + 1}: render ${sr.passed ? "ok" : "FAILED"} ${sr.failure ?? ""}`);
        continue;
      }
      const payload: Record<string, unknown> = {};
      if (step.say !== undefined) payload.say = step.say;
      if (step.answer !== undefined) payload.answer = step.answer;
      const r = await http.call("POST", `/api/v1/sessions/${sid}/instructions`, payload, { "Idempotency-Key": `${runId}-step-${i}` });
      const a = r.body ?? {};
      const sr: StepResult = {
        ...base, kind: "say", say: step.say ?? null, answer_sent: step.answer ?? null, http_status: r.status, status: a.status ?? null, operations: a.operations ?? null,
        summary: a.summary ?? null, question: a.question ?? null, options: a.options ?? null, reason: a.reason ?? null, time_policy: a.time_policy ?? null,
        warnings: a.warnings ?? null, timeline_hash: a.timeline_hash ?? null, duration_s: a.duration_s ?? null, ms: Date.now() - started,
        llm: a.manifest?.providers?.llm ?? null, cost_usd: a.manifest?.cost_estimate?.usd ?? null, semantic_ms: a.manifest?.timings?.semantic_ms ?? null,
      };
      if (r.status !== 200) {
        sr.passed = false;
        sr.failure = `HTTP ${r.status} ${JSON.stringify(r.body)}`;
      } else if (step.expect && a.status !== step.expect) {
        sr.passed = false;
        sr.failure = `expected ${step.expect}, got ${a.status}${a.reason ? `: ${a.reason}` : ""}`;
      } else if (step.expect_duration_s !== undefined && Math.abs(a.duration_s - step.expect_duration_s) > 0.01) {
        sr.passed = false;
        sr.failure = `expected duration ${step.expect_duration_s} s, got ${a.duration_s} s`;
      }
      result.steps.push(sr);
      log(`step ${i + 1}: ${sr.status ?? "?"} ${sr.passed ? "ok" : "FAILED " + sr.failure}`);
    }

    const tl = await http.call("GET", `/api/v1/sessions/${sid}/timeline`);
    if (tl.status === 200) {
      result.final = { timeline_hash: tl.body.timeline_hash, duration_s: tl.body.duration_s };
      if (out) writeFileSync(join(out, "timeline.json"), JSON.stringify(tl.body, null, 2));
    }
    if (out && lastRenderFile) copyFileSync(join(out, lastRenderFile), join(out, "output.mp4"));
    result.passed = result.steps.every((s) => s.passed);
  } catch (e) {
    result.error = (e as Error).message;
    result.passed = false;
  }
  finish(result, out);
  return result;
}

function finish(result: SessionResult, out: string | null): void {
  if (out) writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
}

export { dirname };
