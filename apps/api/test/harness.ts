import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { S3Client } from "@aws-sdk/client-s3";
import { loadConfig, type Config } from "@incubrix/config";
import { createParser } from "@incubrix/nlu";
import { createSemantic } from "@incubrix/semantic";
import { ensureBucket, makeS3 } from "@incubrix/storage";
import { makeLogger } from "@incubrix/store";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { tempDb } from "../../../packages/store/test/db.ts";
import { DEFAULT_MOCK_WORDS, MockAsrClient, type AsrClient, type AsrWord } from "../../worker/src/asr.ts";
import { processOneJob } from "../../worker/src/worker.ts";
import { buildApp } from "../src/app.ts";

export const integration = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_S3);

export interface Stack {
  base: string;
  pool: pg.Pool;
  cfg: Config;
  s3: S3Client;
  asr: AsrClient;
  app: FastifyInstance & { routeTable: { method: string; url: string }[] };
  /** Run queued jobs until the queue is empty. */
  drain: () => Promise<number>;
  /** Send a request; JSON bodies are stringified. */
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  upload: (file: string, fields?: Record<string, string>, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  /** Stop the API and start a NEW one on the same database: what a restart does. */
  restartApi: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startStack(o: { asr?: AsrClient; words?: AsrWord[]; env?: Record<string, string>; logDest?: import("pino").DestinationStream } = {}): Promise<Stack> {
  const db = await tempDb();
  const cfg = loadConfig({
    ...process.env,
    DATABASE_URL: db.url, ASR_PROVIDER: "mock", DIARIZATION_PROVIDER: "mock", LLM_PROVIDER: "rules", EMBED_PROVIDER: "mock", URL_ALLOW_PRIVATE: "true",
    API_TOKEN: "", RATE_LIMIT_PER_MIN: "100000", WORKER_POLL_MS: "50", ...o.env,
  });
  const s3 = makeS3(cfg);
  // The shared compose bucket (created by init) is used on purpose: SeaweedFS answers 500 to the first write into a brand-new bucket.
  await ensureBucket(s3, cfg.S3_BUCKET);
  const asr = o.asr ?? new MockAsrClient(o.words ?? DEFAULT_MOCK_WORDS);
  const log = makeLogger("test", o.logDest ? "debug" : (process.env.TEST_LOG ?? "silent"), o.logDest);
  const parser = createParser(cfg.LLM_PROVIDER);

  let app!: Stack["app"];
  let base = "";
  const start = async () => {
    app = await buildApp({ pool: db.pool, s3, s3Public: s3, cfg, log, parser, semantic: createSemantic(cfg, db.pool) });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  };
  await start();

  const auth = (h: Record<string, string> = {}) => (cfg.API_TOKEN ? { authorization: `Bearer ${cfg.API_TOKEN}`, ...h } : h);
  const read = async (r: Response) => ({ status: r.status, headers: r.headers, body: (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : await r.text() });
  const stack: Stack = {
    get base() { return base; },
    pool: db.pool, cfg, s3, asr,
    get app() { return app; },
    drain: async () => {
      let n = 0;
      while (await processOneJob({ pool: db.pool, s3, cfg, asr, log, semantic: createSemantic(cfg, db.pool) })) n++;
      return n;
    },
    call: async (method, path, body, headers = {}) =>
      read(await fetch(base + path, { method, headers: auth({ ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })),
    upload: async (file, fields = {}, headers = {}) => {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(file)], { type: "video/mp4" }), file.split("/").pop()!);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return read(await fetch(`${base}/api/v1/videos`, { method: "POST", headers: auth(headers), body: form }));
    },
    restartApi: async () => {
      await app.close();
      await start();
    },
    stop: async () => {
      await app.close();
      await db.drop();
    },
  } as Stack;
  return stack;
}

/** Upload a clip, run the worker, return the ready video id. */
export async function ingest(s: Stack, file: string, fields: Record<string, string> = {}) {
  const up = await s.upload(file, fields);
  if (up.status !== 202) throw new Error(`upload failed: ${JSON.stringify(up.body)}`);
  await s.drain();
  const job = await s.call("GET", `/api/v1/jobs/${up.body.job_id}`);
  return { videoId: up.body.video_id as string, jobId: up.body.job_id as string, job: job.body };
}
