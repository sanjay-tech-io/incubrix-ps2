/**
 * The settings table of the README is GENERATED from .env.example (the single list of every setting), so the two cannot drift.
 * `npm run docs:settings` rewrites the block; packages/config/test/envdoc.test.ts fails when it is stale.
 * Rule for descriptions: the comment lines directly above a key; keys that follow each other without a blank line or a new comment share them.
 */
export interface EnvEntry {
  key: string;
  value: string;
  description: string;
}

export function parseEnvExample(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  let block: string[] = [];
  let afterKey = false; // the previous line was a key: a following key keeps the same comment block
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      block = [];
      afterKey = false;
      continue;
    }
    if (line.startsWith("#")) {
      if (afterKey) block = [];
      afterKey = false;
      block.push(line.replace(/^#\s?/, "").trim());
      continue;
    }
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out.push({ key: m[1]!, value: m[2]!, description: block.join(" ") });
    afterKey = true;
  }
  return out;
}

const cell = (s: string): string => s.replaceAll("|", "\\|");

export function settingsTable(entries: readonly EnvEntry[]): string {
  const rows = entries.map((e) => `| \`${e.key}\` | ${e.value === "" ? "(empty)" : `\`${cell(e.value)}\``} | ${cell(e.description)} |`);
  return ["| Variable | Default | What it does |", "|---|---|---|", ...rows].join("\n");
}

const START = "<!-- SETTINGS:START (generated from .env.example by npm run docs:settings; do not edit) -->";
const END = "<!-- SETTINGS:END -->";

/** Replace the block between the markers with the table for `envText`. */
export function renderSettings(readme: string, envText: string): string {
  const a = readme.indexOf("<!-- SETTINGS:START");
  const b = readme.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error("README.md needs the SETTINGS:START / SETTINGS:END markers");
  return `${readme.slice(0, a)}${START}\n${settingsTable(parseEnvExample(envText))}\n${readme.slice(b)}`;
}
