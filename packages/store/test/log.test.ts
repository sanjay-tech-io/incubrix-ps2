import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { makeLogger } from "../src/index.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const dest = new Writable({ write(chunk, _e, cb) { lines.push(JSON.parse(String(chunk))); cb(); } });
  return { lines, dest };
}

describe("logger", () => {
  it("writes JSON with timestamp, level, service, job_id and correlation_id", () => {
    const { lines, dest } = capture();
    makeLogger("worker", "info", dest).child({ job_id: "job_1", correlation_id: "c-1" }).info({ stage: "probe" }, "probing");
    expect(lines[0]).toMatchObject({ level: "info", service: "worker", job_id: "job_1", correlation_id: "c-1", stage: "probe", msg: "probing" });
    expect(String(lines[0]!.timestamp)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it("redacts tokens and authorization headers", () => {
    const { lines, dest } = capture();
    makeLogger("api", "info", dest).info({ req: { headers: { authorization: "Bearer SECRET123" } }, token: "SECRET123", cfg: { secret: "SECRET123" } }, "x");
    expect(JSON.stringify(lines[0])).not.toContain("SECRET123");
  });
});
