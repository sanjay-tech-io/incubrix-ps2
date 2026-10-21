import { describe, expect, it } from "vitest";
import { POLICY_TEXT, summaryText } from "../src/answer.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import { speedLimits } from "../src/runtime.ts";

describe("RateLimiter", () => {
  it("allows N per window, then says how long to wait, then resets", () => {
    let t = 0;
    const rl = new RateLimiter(2, 60_000, () => t);
    expect([rl.hit("a"), rl.hit("a")]).toEqual([0, 0]);
    expect(rl.hit("a")).toBe(60);
    expect(rl.hit("b")).toBe(0);
    t = 30_000;
    expect(rl.hit("a")).toBe(30);
    t = 60_000;
    expect(rl.hit("a")).toBe(0);
  });
});

describe("summary text states the time policy (every answer, every status)", () => {
  it.each(["applied", "needs_clarification", "rejected"] as const)("%s", (status) => {
    for (const timePolicy of ["current", "original"] as const) {
      expect(summaryText({ status, summary: status === "applied" ? "Length 3:20 -> 2:50." : null, timePolicy })).toContain(POLICY_TEXT[timePolicy]);
    }
  });
});

describe("speedLimits", () => {
  it("turns MAX_SPEED into exact rationals", () => {
    expect(speedLimits(4)).toEqual({ min: { num: 1, den: 4 }, max: { num: 4, den: 1 } });
    expect(speedLimits(2.5).max).toEqual({ num: 5, den: 2 });
  });
});
