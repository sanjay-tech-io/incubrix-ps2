import pg from "pg";
import { loadConfig } from "@incubrix/config";
import { createParser } from "@incubrix/nlu";
import { makeS3, verifyBucketWritable } from "@incubrix/storage";
import { GeminiProvider, LlmFallback } from "@incubrix/llm";
import { createSemantic } from "@incubrix/semantic";
import { assertFreeDisk, getLlmCache, makeLogger, putLlmCache } from "@incubrix/store";
import { buildApp } from "./app.ts";

const cfg = loadConfig(process.env);
const log = makeLogger("api", cfg.LOG_LEVEL);
// Fails at startup (not at the first request) when LLM_PROVIDER names a provider that is not built yet.
const parser = createParser(cfg.LLM_PROVIDER);
if (!cfg.API_TOKEN) log.warn("API_TOKEN is not set: the API is open. Only acceptable for local development.");

const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
const s3 = makeS3(cfg);
log.info({ free_gb: Math.round((await assertFreeDisk(cfg.RENDER_TMP_DIR, cfg.MIN_FREE_DISK_GB)) * 10) / 10 }, "disk space ok"); // refuses to start when the disk is nearly full
await verifyBucketWritable(s3, cfg.S3_BUCKET); // fail at startup, not at the first upload
const s3Public = cfg.S3_PUBLIC_ENDPOINT ? makeS3({ ...cfg, S3_ENDPOINT: cfg.S3_PUBLIC_ENDPOINT }) : s3;
// The language model is only the FALLBACK for instructions the rules cannot read. No key = off (answers say so).
const llm =
  cfg.LLM_PROVIDER === "gemini" && cfg.GEMINI_API_KEY && cfg.GEMINI_MODEL
    ? new LlmFallback({
        provider: new GeminiProvider({ apiKey: cfg.GEMINI_API_KEY, model: cfg.GEMINI_MODEL }),
        cache: { get: (k) => getLlmCache(pool, k), put: (k, row) => putLlmCache(pool, { cache_key: k, ...row }) },
        rules: parser, timeoutMs: cfg.LLM_TIMEOUT_MS, price: { inputPerM: cfg.LLM_PRICE_INPUT_PER_M, outputPerM: cfg.LLM_PRICE_OUTPUT_PER_M },
      })
    : null;
if (cfg.LLM_PROVIDER === "gemini" && !llm) log.warn("LLM_PROVIDER=gemini but GEMINI_API_KEY or GEMINI_MODEL is empty: the language-model fallback is OFF");
const app = await buildApp({ pool, s3, s3Public, cfg, log, parser, semantic: createSemantic(cfg, pool, log), llm });

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void app.close().then(() => pool.end()).then(() => process.exit(0)));
await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
