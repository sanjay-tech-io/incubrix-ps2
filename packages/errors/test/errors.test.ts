import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, ERRORS, ERROR_CODES, errorBody, renderReadme } from "../src/index.ts";

describe("error codes", () => {
  it("are all UPPER_SNAKE_CASE with a valid HTTP status", () => {
    for (const c of ERROR_CODES) {
      expect(c).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
      expect(ERRORS[c].status).toBeGreaterThanOrEqual(400);
      expect(ERRORS[c].status).toBeLessThan(600);
    }
  });

  it("body has exactly code, message, retryable, details", () => {
    const b = new ApiError("RATE_LIMITED", "slow down", { retry_after_s: 3 }).body();
    expect(b).toEqual({ error: { code: "RATE_LIMITED", message: "slow down", retryable: true, details: { retry_after_s: 3 } } });
    expect(Object.keys(errorBody("NOT_FOUND", "x").error).sort()).toEqual(["code", "details", "message", "retryable"]);
  });

  it("the README table is up to date (run: npm run docs:errors)", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    expect(renderReadme(readme)).toBe(readme);
  });
});
