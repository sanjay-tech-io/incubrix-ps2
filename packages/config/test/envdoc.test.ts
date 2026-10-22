import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnvExample, renderSettings, settingsTable } from "../src/envdoc.ts";

describe("parseEnvExample", () => {
  const text = [
    "# header that belongs to nobody",
    "",
    "# Group comment line 1.",
    "# Line 2.",
    "A=1",
    "B=two words",
    "",
    "# About C",
    "C=",
    "# About D | with a pipe",
    "D=x=y",
    "",
  ].join("\n");

  it("takes key, default and the comment block directly above; keys that follow each other share it", () => {
    expect(parseEnvExample(text)).toEqual([
      { key: "A", value: "1", description: "Group comment line 1. Line 2." },
      { key: "B", value: "two words", description: "Group comment line 1. Line 2." },
      { key: "C", value: "", description: "About C" },
      { key: "D", value: "x=y", description: "About D | with a pipe" },
    ]);
  });

  it("the table escapes pipes, shows an empty default as (empty), and lists every key in file order", () => {
    const t = settingsTable(parseEnvExample(text));
    expect(t.split("\n")[0]).toBe("| Variable | Default | What it does |");
    expect(t).toContain("| `C` | (empty) | About C |");
    expect(t).toContain("About D \\| with a pipe");
    expect(t.split("\n").filter((l) => l.startsWith("| `")).map((l) => l.split("`")[1])).toEqual(["A", "B", "C", "D"]);
  });
});

describe("README settings table", () => {
  it("is generated from .env.example and up to date (run: npm run docs:settings)", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const env = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(renderSettings(readme, env)).toBe(readme);
  });

  it("lists every setting of .env.example, and the table has no setting that is not in the file", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const env = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const inFile = parseEnvExample(env).map((e) => e.key);
    const block = readme.slice(readme.indexOf("<!-- SETTINGS:START"), readme.indexOf("<!-- SETTINGS:END"));
    const inTable = [...block.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]);
    expect(inTable).toEqual(inFile);
    expect(inFile.length).toBeGreaterThan(60);
  });

  it("a stale table is detected (the check is not vacuous)", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const env = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(renderSettings(readme, env + "NEW_SETTING=1\n")).not.toBe(readme);
  });
});
