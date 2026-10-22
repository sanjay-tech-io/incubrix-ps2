import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBatch } from "../../cli/src/batch.ts";
import { loadSession, type SessionDoc } from "../../cli/src/format.ts";
import { runSession } from "../../cli/src/runner.ts";
import { makeFixture } from "../../../packages/engine/test/fixtures/transcript.ts";
import { makeClip } from "./clips.ts";
import { integration, startStack, type Stack } from "./harness.ts";

const words = makeFixture()
  .atoms.filter((a) => a.kind === "word")
  .map((a) => ({ text: a.text, start_us: a.startUs, end_us: a.endUs, confidence_permille: 950, speaker: "S1" }));

describe.skipIf(!integration)("session runner and batch runner (HTTP clients of the API, mock ASR)", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ words });
  }, 120_000);
  afterAll(async () => s?.stop());

  const WORKED: SessionDoc["steps"] = [
    { say: 'add a caption "Welcome!" on "welcome to the channel"', expect: "applied" },
    { say: "cut the first 30 seconds", expect: "applied", expect_duration_s: 170 },
    { say: "remove the part about pricing", expect: "needs_clarification" },
    { answer: "the second one", expect: "applied", expect_duration_s: 165 },
    { say: "speed up 1:00-1:30 by 2x", expect: "applied", expect_duration_s: 150 },
    { say: "put the intro back", expect: "applied", expect_duration_s: 180 },
    { say: "undo", expect: "applied", expect_duration_s: 150 },
    { say: "make that caption red", expect: "applied" },
    { render: true, expect: "succeeded" },
  ];

  it("determinism: the same session run 3 times through the runner gives the same timeline_hash at every step", async () => {
    const video = makeClip({ seconds: 200 });
    const hashes: (string | null)[][] = [];
    const finals: string[] = [];
    for (let run = 0; run < 3; run++) {
      const out = mkdtempSync(join(tmpdir(), "runner-det-"));
      const r = await runSession({ video, steps: WORKED }, "worked_example", { api: s.base, outDir: out, idle: async () => void (await s.drain()), pollMs: 20 });
      expect(r.error).toBeNull();
      expect(r.steps.filter((x) => !x.passed).map((x) => x.failure)).toEqual([]);
      expect(r.passed).toBe(true);
      hashes.push(r.steps.map((x) => x.timeline_hash));
      finals.push(r.final!.timeline_hash);
      // the folder has what the brief asks for
      for (const f of ["results.json", "timeline.json", "output.mp4"]) expect(existsSync(join(out, f)), f).toBe(true);
      const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
      expect(results.steps[2]).toMatchObject({ status: "needs_clarification", question: expect.any(String) });
      expect(results.steps[2].options).toHaveLength(3);
      expect(results.steps[0].operations.length).toBeGreaterThan(0);
      expect(results.steps[8].render).toMatchObject({ job_status: "succeeded", source_unchanged: true });
    }
    expect(hashes[1]).toEqual(hashes[0]);
    expect(hashes[2]).toEqual(hashes[0]);
    expect(finals[1]).toBe(finals[0]);
    expect(finals[2]).toBe(finals[0]);
    expect(hashes[0]!.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))).toBe(true);
  }, 300_000);

  it("a step that does not match its expectation fails the session, and the failure is kept in results.json", async () => {
    const video = makeClip({ seconds: 200 });
    const out = mkdtempSync(join(tmpdir(), "runner-fail-"));
    const r = await runSession({ video, steps: [{ say: "cut the first 30 seconds", expect: "rejected" }, { say: "undo", expect: "applied" }] }, "wrong_expectation", { api: s.base, outDir: out, idle: async () => void (await s.drain()), pollMs: 20 });
    expect(r.passed).toBe(false);
    expect(r.steps[0]).toMatchObject({ passed: false, status: "applied", failure: "expected rejected, got applied" });
    expect(r.steps[1]!.passed).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "results.json"), "utf8")).passed).toBe(false);
  }, 120_000);

  it("per-step expectations on the answer text: expect_warning, expect_no_warning, expect_text, expect_options (a mismatch fails the step and says what)", async () => {
    const video = makeClip({ seconds: 200 });
    const steps: SessionDoc["steps"] = [
      { say: 'add a caption "Welcome!" on "welcome to the channel"', expect: "applied", expect_no_warning: "." }, // no warning at all
      { say: "speed up 0:41-0:45 by 4x", expect: "applied", expect_warning: "0\\.7 s" }, // the caption would be shorter than 0.7 s
      { say: "remove everything after I say thanks", expect: "needs_clarification", expect_options: 4, expect_text: "thanks" },
      { answer: "the last one", expect: "applied", expect_no_warning: "swap" },
      { say: "cut 0:10-0:12", expect: "applied", expect_warning: "this text is not in any warning" },
      { say: "undo", expect: "applied", expect_options: 3 },
      { say: "undo", expect: "applied", expect_hash_unchanged: true }, // undo changes the timeline, so this must fail
    ];
    const r = await runSession({ video, steps }, "text_expectations", { api: s.base, idle: async () => void (await s.drain()), pollMs: 20 });
    expect(r.steps.map((x) => x.passed)).toEqual([true, true, true, true, false, false, false]);
    expect(r.steps[4]!.failure).toMatch(/expected a warning matching \/this text is not in any warning\//);
    expect(r.steps[5]!.failure).toMatch(/expected 3 option\(s\), got 0/);
    expect(r.steps[6]!.failure).toMatch(/expected the timeline_hash to stay the same as after step 6/);
  }, 120_000);

  it("a video without audio stops at intake with NO_AUDIO_TRACK and the session says so", async () => {
    const video = makeClip({ seconds: 20, audio: false });
    const r = await runSession({ video, expect_intake_error: "NO_AUDIO_TRACK", steps: [{ say: "undo" }] }, "no_audio", { api: s.base, idle: async () => void (await s.drain()), pollMs: 20 });
    expect(r.passed).toBe(true);
    expect(r.intake?.status).toBe("failed");
    expect(r.session_id).toBeNull();
  }, 120_000);

  it("batch: runs every file in a folder, one result folder each, summary.json lists pass and fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-in-"));
    const video = makeClip({ seconds: 200 });
    writeFileSync(join(dir, "a_ok.yaml"), stringify({ video, steps: [{ say: "cut the first 30 seconds", expect: "applied" }, { say: "undo", expect: "applied" }] }));
    writeFileSync(join(dir, "b_bad.yaml"), stringify({ video, steps: [{ say: "speed up 0:10-0:20 by 10x", expect: "applied" }] }));
    writeFileSync(join(dir, "not_a_session.txt"), "ignored");
    const out = mkdtempSync(join(tmpdir(), "batch-out-"));
    const sum = await runBatch(dir, out, { api: s.base, idle: async () => void (await s.drain()) });
    expect(sum).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(sum.sessions.map((x) => [x.name, x.passed])).toEqual([["a_ok", true], ["b_bad", false]]);
    expect(sum.sessions[1]!.failed_steps[0]!.failure).toMatch(/expected applied, got rejected/);
    expect(existsSync(join(out, "a_ok", "results.json"))).toBe(true);
    expect(existsSync(join(out, "b_bad", "results.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).failed).toBe(1);
  }, 180_000);
});

describe("session file format", () => {
  it("rejects a file with an unknown field or an empty step", () => {
    const dir = mkdtempSync(join(tmpdir(), "fmt-"));
    writeFileSync(join(dir, "x.yaml"), stringify({ video: "a.mp4", steps: [{ sayy: "x" }] }));
    expect(() => loadSession(join(dir, "x.yaml"))).toThrow();
    writeFileSync(join(dir, "y.yaml"), stringify({ video: "a.mp4", steps: [{ expect: "applied" }] }));
    expect(() => loadSession(join(dir, "y.yaml"))).toThrow(/needs say, answer or render/);
  });
});
