import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { SessionDoc } from "../../cli/src/format.ts";
import { runSession, type SessionResult } from "../../cli/src/runner.ts";
import { makeClip } from "./clips.ts";
import { integration, startStack, type Stack } from "./harness.ts";
import { FIXTURES } from "./scenario_fixtures.ts";

/**
 * The scripted scenarios (scenarios/*.yaml): every file is a session with an expected result for every step, run through the
 * same HTTP session runner a user runs, against the in-process API + worker with MOCK ASR (a fixed transcript, see scenario_fixtures.ts),
 * the rules parser and no network. `docker compose run --rm tests` runs them; CI runs that command.
 *
 * File format = the session format (apps/cli/src/format.ts) without `video`, plus:
 *   fixture:  which transcript + generated clip (scenario_fixtures.ts)
 *   brief:    the line of the brief this scenario answers (docs/REQUIREMENTS.md)
 *   known_failure: a scenario that is KNOWN to fail today; the suite then requires it to keep failing (so it cannot be forgotten) and lists it.
 */
const Scenario = SessionDoc.omit({ video: true }).extend({
  fixture: z.enum(Object.keys(FIXTURES) as [string, ...string[]]),
  brief: z.string().min(1),
  known_failure: z.string().optional(),
});
type Scenario = z.infer<typeof Scenario>;

const dir = new URL("../../../scenarios/", import.meta.url).pathname;
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : [];
const scenarios = files.map((f) => {
  const r = Scenario.safeParse(parse(readFileSync(join(dir, f), "utf8")));
  if (!r.success) throw new Error(`${f}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { file: f, name: f.replace(/\.yaml$/, ""), doc: r.data };
});

describe("the scenario pack", () => {
  it("has at least 40 scenarios, each with an expected status on every instruction step", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(40);
    for (const s of scenarios) {
      expect(new Set(scenarios.map((x) => x.name)).size).toBe(scenarios.length);
      if (s.doc.expect_intake_error) continue;
      for (const [i, st] of s.doc.steps.entries()) if (!("render" in st)) expect(st.expect, `${s.file} step ${i + 1} needs an expected status`).toBeDefined();
    }
  });
});

const outDir = process.env.SCENARIO_OUT; // when set, results.json of every scenario is written there (docs/raw)

describe.skipIf(!integration)("scenarios (mock ASR, rules parser, real API + worker + database + storage + ffmpeg)", () => {
  const stacks = new Map<string, Stack>();
  const results = new Map<string, SessionResult>();
  beforeAll(async () => {
    for (const f of new Set(scenarios.map((s) => s.doc.fixture))) {
      stacks.set(f, await startStack({ words: FIXTURES[f]!.words }));
    }
  }, 300_000);
  afterAll(async () => {
    for (const s of stacks.values()) await s.stop();
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      const summary = scenarios.map((s) => ({ scenario: s.name, fixture: s.doc.fixture, brief: s.doc.brief, passed: results.get(s.name)?.passed ?? null, known_failure: s.doc.known_failure ?? null, steps: results.get(s.name)?.steps.length ?? null }));
      writeFileSync(join(outDir, "summary.json"), JSON.stringify({ total: summary.length, passed: summary.filter((x) => x.passed).length, scenarios: summary }, null, 2));
    }
  });

  for (const sc of scenarios) {
    it(`${sc.name}: ${sc.doc.brief}`, async () => {
      const stack = stacks.get(sc.doc.fixture)!;
      const { fixture, brief: _brief, known_failure, ...rest } = sc.doc;
      const video = makeClip(FIXTURES[fixture]!.clip);
      const doc = { ...rest, video, num_speakers: rest.num_speakers ?? (fixture === "two_speakers" ? 2 : 1) };
      const r = await runSession(doc, sc.name, { api: stack.base, idle: async () => void (await stack.drain()), pollMs: 10, ...(outDir ? { outDir: join(outDir, sc.name) } : {}) });
      results.set(sc.name, r);
      if (known_failure) {
        expect(r.passed, `${sc.name} is marked as a known failure (${known_failure}) but now passes: remove known_failure`).toBe(false);
        return;
      }
      const failures = r.steps.filter((x) => !x.passed).map((x) => `step ${x.step} (${x.say ?? x.answer_sent ?? "render"}): ${x.failure}`);
      expect(r.error, "session error").toBeNull();
      expect(failures).toEqual([]);
      expect(r.passed).toBe(true);
    }, 300_000);
  }

  it("determinism: six scenarios run again twice give the same timeline_hash at every step", async () => {
    const pick = scenarios.filter((s) => !s.doc.expect_intake_error && !s.doc.known_failure && !s.doc.steps.some((st) => "render" in st)).slice(0, 6);
    expect(pick.length).toBe(6);
    for (const sc of pick) {
      const stack = stacks.get(sc.doc.fixture)!;
      const { fixture, brief: _b, known_failure: _k, ...rest } = sc.doc;
      const doc = { ...rest, video: makeClip(FIXTURES[fixture]!.clip) };
      const first = results.get(sc.name)!;
      for (let run = 0; run < 2; run++) {
        const again = await runSession(doc, sc.name, { api: stack.base, idle: async () => void (await stack.drain()), pollMs: 10 });
        expect(again.steps.map((x) => x.timeline_hash), `${sc.name} run ${run + 2}`).toEqual(first.steps.map((x) => x.timeline_hash));
      }
    }
  }, 600_000);
});
