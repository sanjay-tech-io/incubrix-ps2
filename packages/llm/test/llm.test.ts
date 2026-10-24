import { describe, expect, it } from "vitest";
import { createContext, currentTimeline, newSession, type SessionState } from "@incubrix/engine";
import { RulesParser, applyParsed } from "@incubrix/nlu";
import { makeFixture } from "../../engine/test/fixtures/transcript.ts";
import { Commands, LlmFallback, MockLlmProvider, cacheKeyOf, commandsToText, contextSummary, normalizeInstruction, type LlmCache } from "../src/index.ts";

const U = 1_000_000;
const rules = new RulesParser();

class MemoryCache implements LlmCache {
  rows = new Map<string, { provider: string; model: string; response: Record<string, unknown> }>();
  async get(key: string) { return this.rows.get(key) ?? null; }
  async put(key: string, row: { provider: string; model: string; response: Record<string, unknown> }) { this.rows.set(key, row); }
}

function setup(script: ConstructorParameters<typeof MockLlmProvider>[0] = {}, o: { timeoutMs?: number; delayMs?: number } = {}) {
  const { ctx } = makeFixture();
  const state: SessionState = newSession();
  const provider = new MockLlmProvider(script, o.delayMs ?? 0);
  const cache = new MemoryCache();
  const fb = new LlmFallback({ provider, cache, rules, timeoutMs: o.timeoutMs ?? 500, price: { inputPerM: 0.3, outputPerM: 2.5 } });
  return { ctx, state, provider, cache, fb };
}

describe("commands: the only thing the model may output", () => {
  it("accepts the documented shapes and rejects anything else (unknown op, extra field, bad range, too many)", () => {
    expect(Commands.safeParse({ commands: [{ op: "cut", start_s: 30, end_s: 40 }] }).success).toBe(true);
    expect(Commands.safeParse({ commands: [{ op: "cut", start_s: 30, end_s: 40, note: "x" }] }).success).toBe(false);
    expect(Commands.safeParse({ commands: [{ op: "format_disk" }] }).success).toBe(false);
    expect(Commands.safeParse({ commands: [{ op: "speed", start_s: 0, end_s: 5, rate: 99 }] }).success).toBe(false);
    expect(Commands.safeParse({ commands: [{ op: "cut", start_s: -1, end_s: 5 }] }).success).toBe(false);
    expect(Commands.safeParse({ commands: Array(6).fill({ op: "undo" }) }).success).toBe(false);
    expect(Commands.safeParse({ commands: [] }).success).toBe(false);
  });

  it("each command becomes a sentence the rules parser reads, so the engine does all the real work", () => {
    const { ctx } = makeFixture();
    const text = commandsToText([
      { op: "cut", start_s: 30, end_s: 40 },
      { op: "speed", start_s: 60, end_s: 90, rate: 2 },
      { op: "caption", text: "Hi", on_phrase: "welcome to the channel" },
    ]);
    expect(text).toBe('cut 0:30.000-0:40.000; speed up 1:00.000-1:30.000 by 2x; add a caption "Hi" on "welcome to the channel"');
    const t = applyParsed(ctx, newSession(), "x", rules.parse({ ctx, state: newSession(), text }));
    expect(t.answer.status).toBe("applied");
    expect(t.answer.operations.length).toBeGreaterThanOrEqual(3);
  });
});

describe("fallback: used only when the rules cannot parse, cached, validated", () => {
  const ok = { commands: [{ op: "cut", start_s: 30, end_s: 40 }] };

  it("is NOT called when the rules understand the instruction", async () => {
    const s = setup({ "*": ok });
    const r = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text: "cut 0:10-0:20" });
    expect(r).toBeNull();
    expect(s.provider.calls).toBe(0);
  });

  it("translates an instruction the rules do not know, applies it through the engine, reports tokens and cost, then replays from the cache with no call", async () => {
    const s = setup({ "*": { ...ok, usage: { inputTokens: 800, outputTokens: 40 } } });
    const text = "please make the awkward bit near the beginning disappear";
    const r1 = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text });
    expect(r1!.parsed.kind).toBe("plan");
    expect(r1!.call).toMatchObject({ cache: "miss", inputTokens: 800, outputTokens: 40 });
    expect(r1!.call.costUsd).toBeCloseTo((800 * 0.3 + 40 * 2.5) / 1e6, 9);
    const r2 = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text: "  Please make the awkward bit near the beginning disappear  " });
    expect(s.provider.calls).toBe(1);
    expect(r2!.call).toMatchObject({ cache: "hit", costUsd: 0 });
    expect(r2!.parsed).toEqual(r1!.parsed);
  });

  it("invalid model output (not JSON, wrong shape, unsupported) becomes a rejection with the reason, never an edit", async () => {
    for (const bad of ["this is not json", '{"commands":[{"op":"explode"}]}', '{"commands":[{"op":"unsupported","reason":"I cannot do that"}]}']) {
      const s = setup({ "*": { raw: bad } });
      const r = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text: "do something odd" });
      expect(r!.parsed.kind).toBe("reject");
      if (r!.parsed.kind === "reject") expect(r!.parsed.reason.length).toBeGreaterThan(10);
    }
  });

  it("a command the engine refuses (out of range, 10x) is rejected with the engine's reason", async () => {
    const s = setup({ "*": { commands: [{ op: "cut", start_s: 5000, end_s: 5010 }] } });
    const r = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text: "remove that bit near the very end of the world" });
    expect(r!.parsed.kind).toBe("reject");
  });

  it("a slow model: the answer is a rejection that says so, and the late reply is still cached for the next try", async () => {
    const s = setup({ "*": ok }, { timeoutMs: 20, delayMs: 120 });
    const r1 = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text: "trim a bit somewhere" });
    expect(r1!.parsed.kind).toBe("reject");
    if (r1!.parsed.kind === "reject") expect(r1!.parsed.reason).toMatch(/did not answer within/);
    expect(r1!.call.cache).toBe("timeout");
    await new Promise((r) => setTimeout(r, 250));
    const r2 = await s.fb.parseUnparsed({ ctx: s.ctx, state: s.state, text: "trim a bit somewhere" });
    expect(r2!.call.cache).toBe("hit");
    expect(r2!.parsed.kind).toBe("plan");
  });

  it("the cache key changes with provider, model, prompt version, the instruction and the timeline context", () => {
    const { ctx } = makeFixture();
    const c = contextSummary(ctx, currentTimeline(ctx, newSession()));
    const base = cacheKeyOf({ provider: "gemini", model: "m1", promptVersion: "1", instruction: "do x", context: c });
    expect(cacheKeyOf({ provider: "gemini", model: "m1", promptVersion: "1", instruction: "Do  X", context: c })).toBe(base);
    for (const alt of [{ provider: "groq" }, { model: "m2" }, { promptVersion: "2" }, { instruction: "do y" }, { context: { ...c, durationS: c.durationS + 1 } }]) {
      expect(cacheKeyOf({ provider: "gemini", model: "m1", promptVersion: "1", instruction: "do x", context: c, ...alt })).not.toBe(base);
    }
    expect(normalizeInstruction("  Do   X! ")).toBe("do x");
  });

  it("the context sent to the model has no transcript text and no media", () => {
    const { ctx } = makeFixture();
    const json = JSON.stringify(contextSummary(ctx, currentTimeline(ctx, newSession())));
    expect(json).not.toMatch(/pricing|welcome|Hello|thanks/i);
  });
});
