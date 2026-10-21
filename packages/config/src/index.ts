import { z } from "zod";

// Why: every setting is read once, here, and validated at startup so a typo in
// .env stops the service immediately instead of failing later in a job.
// .env.example must list exactly the keys of this schema (a test checks it).

export class ConfigError extends Error {
  // Why not a parameter property: Node runs these files with type stripping, which rejects them.
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
    this.name = "ConfigError";
  }
}

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const base = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),

    DATABASE_URL: z.url(),

    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool.default(true),

    ASR_PROVIDER: z.enum(["mock", "faster-whisper"]).default("mock"),
    ASR_URL: z.url().default("http://asr:8000"),
    DIARIZATION_PROVIDER: z.enum(["sherpa", "mock", "none"]).default("mock"),
    LLM_PROVIDER: z.enum(["rules", "mock", "groq", "gemini"]).default("rules"),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(1500),
    GROQ_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),

    // Engine receives these as parameters (it cannot read env). Min speed is fixed at 0.25x.
    MAX_SPEED: z.coerce.number().min(1).max(16).default(4),
    CALLBACK_HMAC_SECRET: z.string().min(16).optional(),

    // --- M2: API / worker ---
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
    // Bearer token for everything except /health and /ready. Unset = open API (local development only).
    API_TOKEN: z.string().min(16).optional(),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(100000).default(120),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(20000).default(2048),
    // Only for tests: allow video URLs that point to loopback/private addresses.
    URL_ALLOW_PRIVATE: bool.default(false),
    // A running job with no progress update for this long belonged to a crashed worker and is re-queued.
    JOB_STALE_S: z.coerce.number().int().min(5).max(86400).default(300),
    WORKER_POLL_MS: z.coerce.number().int().min(50).max(60000).default(500),
    // Host:port clients can reach, used in presigned download links. Blank = S3_ENDPOINT.
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    ASR_MODEL: z.string().min(1).default("base.en"),
    ASR_TIMEOUT_S: z.coerce.number().int().min(10).max(86400).default(3600),
    // Silence detection and word clamping (the values are part of the transcript cache key).
    SILENCE_NOISE_DB: z.coerce.number().int().min(-90).max(-10).default(-35),
    SILENCE_MIN_MS: z.coerce.number().int().min(50).max(10000).default(300),
    CLAMP_MIN_WORD_MS: z.coerce.number().int().min(1).max(1000).default(20),
    LOW_CONFIDENCE_PERMILLE: z.coerce.number().int().min(0).max(1000).default(600),

    // --- M3: render ---
    RENDER_PRESET: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]).default("veryfast"),
    RENDER_CRF: z.coerce.number().int().min(0).max(51).default(20),
    // 0 = keep the source height. Otherwise the output is scaled down (never up) to at most this many lines.
    RENDER_MAX_HEIGHT: z.coerce.number().int().min(0).max(4320).default(0),
    // Where ffmpeg may write its temporary files (proxy, graph script, output).
    RENDER_TMP_DIR: z.string().min(1).default("/tmp"),
});

const schema = base.superRefine((c, ctx) => {
    if (c.LLM_PROVIDER === "groq" && !c.GROQ_API_KEY) ctx.addIssue({ code: "custom", path: ["GROQ_API_KEY"], message: "required when LLM_PROVIDER=groq" });
    if (c.LLM_PROVIDER === "gemini" && !c.GEMINI_API_KEY) ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "required when LLM_PROVIDER=gemini" });
  });

export type Config = z.infer<typeof schema>;
export const CONFIG_KEYS: string[] = Object.keys(base.shape);

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Why: a blank "KEY=" line in .env should mean "use the default", not "empty string".
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") cleaned[k] = v;
  const r = schema.safeParse(cleaned);
  if (r.success) return r.data;
  // Why only key + message: zod can echo the input value, which may be a secret (CLAUDE.md: no secrets in logs).
  throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
}
