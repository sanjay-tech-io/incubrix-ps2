import http from "node:http";
import pg from "pg";
import { loadConfig } from "@incubrix/config";
import { makeS3 } from "@incubrix/storage";
import { makeLogger } from "@incubrix/store";
import { DEFAULT_MOCK_WORDS, HttpAsrClient, MockAsrClient, type AsrClient } from "./asr.ts";
import { workerLoop } from "./worker.ts";

const cfg = loadConfig(process.env);
const log = makeLogger("worker", cfg.LOG_LEVEL);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const s3 = makeS3(cfg);

// ASR_PROVIDER=mock never calls the ASR service (tests); anything else goes over HTTP and the service runs its own engine.
const asr: AsrClient =
  cfg.ASR_PROVIDER === "mock"
    ? new MockAsrClient(DEFAULT_MOCK_WORDS, cfg.DIARIZATION_PROVIDER)
    : new HttpAsrClient({ url: cfg.ASR_URL, provider: cfg.ASR_PROVIDER, model: cfg.ASR_MODEL, diarizationProvider: cfg.DIARIZATION_PROVIDER, timeoutS: cfg.ASR_TIMEOUT_S });

const abort = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => abort.abort());

http
  .createServer(async (req, res) => {
    const send = (code: number, body: object) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
    if (req.url === "/health") return send(200, { status: "ok", service: "worker" });
    if (req.url === "/ready") {
      try {
        await pool.query("select 1");
        return send(200, { status: "ready", service: "worker" });
      } catch {
        return send(503, { status: "not_ready", service: "worker" });
      }
    }
    send(404, { error: { code: "NOT_FOUND", message: "no such route", retryable: false, details: {} } });
  })
  .listen(cfg.WORKER_PORT, () => log.info({ port: cfg.WORKER_PORT, asr: asr.provider, diarization: asr.diarizationProvider }, "worker listening"));

await workerLoop({ pool, s3, cfg, asr, log }, abort.signal);
await pool.end();
process.exit(0);
