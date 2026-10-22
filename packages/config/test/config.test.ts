import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/index.js";

const good = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  S3_ENDPOINT: "http://localhost:8333",
  S3_BUCKET: "incubrix",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
};

describe("loadConfig", () => {
  it("applies defaults and coerces numbers/booleans", () => {
    const c = loadConfig({ ...good, PORT: "9000", S3_FORCE_PATH_STYLE: "false" });
    expect(c.PORT).toBe(9000);
    expect(c.S3_FORCE_PATH_STYLE).toBe(false);
    expect(c.ASR_PROVIDER).toBe("mock");
    expect(c.LLM_PROVIDER).toBe("rules");
    expect(c.MAX_SPEED).toBe(4);
  });

  it("fails fast and names every bad variable at once", () => {
    try {
      loadConfig({ DATABASE_URL: "not a url", PORT: "abc" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      for (const k of ["DATABASE_URL", "PORT", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) expect(msg).toContain(k);
    }
  });

  it("rejects an unknown provider", () => {
    expect(() => loadConfig({ ...good, ASR_PROVIDER: "whispr" })).toThrow(/ASR_PROVIDER/);
  });

  it("groq needs its API key; gemini does NOT (M4: no key = the language-model fallback is off and answers say so)", () => {
    expect(() => loadConfig({ ...good, LLM_PROVIDER: "groq" })).toThrow(/GROQ_API_KEY/);
    expect(loadConfig({ ...good, LLM_PROVIDER: "groq", GROQ_API_KEY: "k" }).LLM_PROVIDER).toBe("groq");
    expect(loadConfig({ ...good, LLM_PROVIDER: "gemini" }).GEMINI_API_KEY).toBeUndefined();
  });

  it("enforces the documented speed range (min 0.25x, MAX_SPEED >= 1)", () => {
    expect(() => loadConfig({ ...good, MAX_SPEED: "0.1" })).toThrow(/MAX_SPEED/);
    expect(loadConfig({ ...good, MAX_SPEED: "2" }).MAX_SPEED).toBe(2);
  });

  it("never prints secret values in the error message", () => {
    try {
      loadConfig({ ...good, S3_SECRET_KEY: "", DATABASE_URL: "postgres://u:supersecret@h/%%%" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("supersecret");
    }
  });

  it("accepts sherpa as a diarization provider and rejects unknown ones", () => {
    expect(loadConfig({ ...good, DIARIZATION_PROVIDER: "sherpa" }).DIARIZATION_PROVIDER).toBe("sherpa");
    expect(() => loadConfig({ ...good, DIARIZATION_PROVIDER: "pyannote" })).toThrow();
  });

  it("production refuses to start without an API token (fail fast), development does not", () => {
    expect(() => loadConfig({ ...good, NODE_ENV: "production" })).toThrow(/API_TOKEN/);
    expect(() => loadConfig({ ...good, NODE_ENV: "production", API_TOKEN: "" })).toThrow(/API_TOKEN/);
    expect(loadConfig({ ...good, NODE_ENV: "production", API_TOKEN: "a-long-enough-token-0123" }).API_TOKEN).toBeDefined();
    expect(loadConfig({ ...good }).API_TOKEN).toBeUndefined();
  });

  it("limits default to: no duration cap, one ingest and one render job at a time, no proxy trust", () => {
    const c = loadConfig({ ...good });
    expect([c.MAX_VIDEO_DURATION_S, c.MAX_INGEST_JOBS, c.MAX_RENDER_JOBS, c.TRUST_PROXY]).toEqual([0, 1, 1, false]);
    expect(() => loadConfig({ ...good, MAX_RENDER_JOBS: "0" })).toThrow(/MAX_RENDER_JOBS/);
  });

  it("treats empty strings as unset (so a blank line in .env uses the default)", () => {
    expect(loadConfig({ ...good, PORT: "" }).PORT).toBe(8080);
  });
});

describe(".env.example", () => {
  it("lists every setting the loader knows, and nothing else", async () => {
    const { readFileSync } = await import("node:fs");
    const { CONFIG_KEYS } = await import("../src/index.js");
    const text = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const listed = [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    // Compose-only variables (not read by the Node config loader) are allowed extras.
    const extra = new Set(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "WHISPER_COMPUTE_TYPE", "WHISPER_INITIAL_PROMPT", "DIARIZATION_MODEL_DIR", "DIARIZATION_NUM_SPEAKERS", "DIARIZATION_CLUSTER_THRESHOLD", "DIARIZATION_UNCERTAIN_BELOW", "DIARIZATION_OVERLAP_MIN_FRACTION", "PUBLIC_HOST"]);
    expect(CONFIG_KEYS.filter((k) => !listed.includes(k))).toEqual([]);
    expect(listed.filter((k) => !CONFIG_KEYS.includes(k) && !extra.has(k))).toEqual([]);
  });
});
