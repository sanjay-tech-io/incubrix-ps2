import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMigrations } from "../src/index.js";

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "mig-"));
  for (const [n, s] of Object.entries(files)) writeFileSync(join(d, n), s);
  return d;
}

describe("readMigrations", () => {
  it("returns files in numeric order with a sha256 checksum", () => {
    const m = readMigrations(dirWith({ "0002_b.sql": "select 2;", "0001_a.sql": "select 1;", "notes.txt": "ignored" }));
    expect(m.map((x) => x.version)).toEqual([1, 2]);
    expect(m[0]!.name).toBe("a");
    expect(m[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses duplicate versions", () => {
    expect(() => readMigrations(dirWith({ "0001_a.sql": "x", "0001_b.sql": "y" }))).toThrow(/duplicate/i);
  });

  it("refuses gaps so a missing file is noticed", () => {
    expect(() => readMigrations(dirWith({ "0001_a.sql": "x", "0003_c.sql": "y" }))).toThrow(/gap/i);
  });

  it("refuses badly named .sql files", () => {
    expect(() => readMigrations(dirWith({ "init.sql": "x" }))).toThrow(/name/i);
  });

  it("the real migrations directory is valid", () => {
    expect(readMigrations().length).toBeGreaterThanOrEqual(1);
  });
});
