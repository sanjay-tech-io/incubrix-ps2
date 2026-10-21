import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRender, loadSession } from "../src/format.ts";

const dir = join(__dirname, "../../../sessions");
const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();

describe("sessions/ (the scripted session pack)", () => {
  it("has at least 15 sessions, each valid, with unique names and an expected status on every step", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    const names = new Set<string>();
    for (const f of files) {
      const doc = loadSession(join(dir, f));
      expect(doc.name, f).toBe(f.replace(/\.yaml$/, ""));
      expect(names.has(doc.name!), `${f} duplicate name`).toBe(false);
      names.add(doc.name!);
      if (!doc.expect_intake_error) for (const [i, s] of doc.steps.entries()) expect(s.expect, `${f} step ${i + 1} has no expect`).toBeDefined();
      for (const s of doc.steps) if (isRender(s)) expect(s.expect ?? "succeeded").toMatch(/succeeded|failed/);
    }
  });

  it("the worked example is the brief's eight steps", () => {
    const doc = loadSession(join(dir, "01_worked_example.yaml"));
    expect(doc.steps.filter((s) => !isRender(s) && s.say !== undefined).length).toBe(8);
    expect(isRender(doc.steps.at(-1)!)).toBe(true);
  });
});
