import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the purity rules (CLAUDE.md architecture rule 5) actually fire, so deleting or weakening them fails `npm test`.
const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function messages(code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath: `${cwd}/src/_probe.ts` });
  return r!.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

describe("engine purity lint rules", () => {
  it.each([
    ["Date", "export const a = Date.now();"],
    ["new Date", "export const a = new Date();"],
    ["Math.random", "export const a = Math.random();"],
    ["process", "export const a = process.env.X;"],
    ["fetch", "export const a = fetch;"],
    ["node:fs import", 'import { readFileSync } from "node:fs"; export const a = readFileSync;'],
    ["fs import", 'import fs from "fs"; export const a = fs;'],
    ["http import", 'import http from "node:http"; export const a = http;'],
    ["node:crypto import", 'import { createHash } from "node:crypto"; export const a = createHash;'],
    ["crypto global", "export const a = crypto.randomUUID();"],
    ["setTimeout", "export const a = setTimeout;"],
  ])("forbids %s in packages/engine/src", async (_name, code) => {
    expect((await messages(code)).length).toBeGreaterThan(0);
  });

  it("allows pure code", async () => {
    expect(await messages("export const add = (a: number, b: number): number => a + b;")).toEqual([]);
  });
});
