import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Same guard as packages/engine: the parser must stay pure, so the same session always gives the same timeline.
const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function messages(code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath: `${cwd}/src/_probe.ts` });
  return r!.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

describe("nlu purity lint rules", () => {
  it.each([
    ["Date", "export const a = Date.now();"],
    ["Math.random", "export const a = Math.random();"],
    ["process", "export const a = process.env.X;"],
    ["fetch", "export const a = fetch;"],
    ["node:fs import", 'import { readFileSync } from "node:fs"; export const a = readFileSync;'],
    ["http import", 'import http from "node:http"; export const a = http;'],
    ["node:crypto import", 'import { randomUUID } from "node:crypto"; export const a = randomUUID;'],
    ["setTimeout", "export const a = setTimeout;"],
  ])("forbids %s in packages/nlu/src", async (_n, code) => {
    expect((await messages(code)).length).toBeGreaterThan(0);
  });
  it("allows pure code", async () => {
    expect(await messages("export const add = (a: number, b: number): number => a + b;")).toEqual([]);
  });
});
