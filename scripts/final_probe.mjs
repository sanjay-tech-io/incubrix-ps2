// Final-check probe: plain HTTP client for the live (or any) API. Not part of the product; it only sends what it is told and prints the full answers.
// Usage: node scripts/final_probe.mjs <video> <steps.json> <out.json> [num_speakers]
// steps.json: array of strings (instructions), or {"answer": "..."}, {"render": true, "save": "path.mp4"}, {"get": "timeline|history|conversation"}.
// API_URL and API_TOKEN come from the environment (the token is never printed).
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [video, stepsFile, outFile, speakers] = process.argv.slice(2);
const base = process.env.API_URL ?? "http://localhost:8080";
const headers = process.env.API_TOKEN ? { authorization: `Bearer ${process.env.API_TOKEN}` } : {};
const ANSWER_FIELDS = ["status", "operations", "summary", "question", "options", "reason", "time_policy", "warnings", "timeline_hash", "duration_s"];

const call = async (method, path, body, extra = {}) => {
  const res = await fetch(base + path, { method, headers: { ...headers, ...extra }, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { http: res.status, json };
};
const jsonPost = (path, obj, key) => call("POST", path, JSON.stringify(obj), { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) });
const poll = async (jobId, log = false) => {
  const t0 = Date.now(); let last = -1;
  for (;;) {
    const { json } = await call("GET", `/api/v1/jobs/${jobId}`);
    if (log && json.progress !== last) { last = json.progress; console.log(`  job ${jobId} ${json.status} progress ${json.progress} after ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
    if (json.status === "succeeded" || json.status === "failed") return json;
    await new Promise((r) => setTimeout(r, 1000));
  }
};

const out = { video, base, steps: [] };
const fd = new FormData();
fd.set("file", new Blob([readFileSync(video)]), basename(video));
if (speakers) fd.set("num_speakers", speakers);
const up = await call("POST", "/api/v1/videos", fd);
out.upload = { http: up.http, body: up.json };
if (up.http !== 202) { writeFileSync(outFile, JSON.stringify(out, null, 1)); console.log("upload failed", up.http, JSON.stringify(up.json)); process.exit(1); }
const ingest = await poll(up.json.job_id, true);
out.ingest = { status: ingest.status, error: ingest.error ?? null, result: ingest.result ?? null };
if (ingest.status !== "succeeded") { writeFileSync(outFile, JSON.stringify(out, null, 1)); console.log("ingest", ingest.status, JSON.stringify(ingest.error)); process.exit(0); }
const sess = await jsonPost("/api/v1/sessions", { video_id: up.json.video_id });
const sid = sess.json.session_id ?? sess.json.id;
out.session_id = sid;

for (const [i, s] of JSON.parse(readFileSync(stepsFile, "utf8")).entries()) {
  const t0 = Date.now();
  if (typeof s === "string" || s.answer !== undefined) {
    const body = typeof s === "string" ? { say: s } : { answer: s.answer };
    const r = await jsonPost(`/api/v1/sessions/${sid}/instructions`, body);
    const missing = ANSWER_FIELDS.filter((f) => !(f in (r.json ?? {})));
    out.steps.push({ n: i + 1, sent: s, http: r.http, ms: Date.now() - t0, missing_fields: missing, answer: r.json });
    console.log(`${i + 1}. ${JSON.stringify(s)} -> HTTP ${r.http} ${r.json?.status ?? r.json?.error?.code} ${missing.length ? "MISSING " + missing : ""}`);
  } else if (s.render) {
    const r = await jsonPost(`/api/v1/sessions/${sid}/render`, {});
    const job = r.http === 202 ? await poll(r.json.job_id) : r.json;
    out.steps.push({ n: i + 1, sent: s, http: r.http, ms: Date.now() - t0, job });
    const link = job?.result?.links?.video;
    if (link && s.save) { const v = await fetch(link); writeFileSync(s.save, Buffer.from(await v.arrayBuffer())); out.steps.at(-1).saved = s.save; } // download link is a presigned S3 URL: no token
    console.log(`${i + 1}. render -> ${r.http} ${job.status}`);
  } else if (s.get) {
    const r = await call("GET", `/api/v1/sessions/${sid}/${s.get}`);
    out.steps.push({ n: i + 1, sent: s, http: r.http, body: r.json });
    console.log(`${i + 1}. GET ${s.get} -> ${r.http}`);
  }
}
writeFileSync(outFile, JSON.stringify(out, null, 1));
