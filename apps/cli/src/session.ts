import { basename, dirname, resolve } from "node:path";
import { loadSession } from "./format.ts";
import { runSession } from "./runner.ts";

/** npm run session -- <file.yaml> [--out <dir>] [--api <url>] [--token <t>] */
export function args(argv: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--resume") flags.resume = "1";
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else rest.push(a);
  }
  return { flags, rest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { flags, rest } = args(process.argv.slice(2));
  const file = rest[0];
  if (!file) {
    console.error("usage: npm run session -- <file.yaml> [--out <dir>] [--api <url>] [--token <token>]");
    process.exit(2);
  }
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const doc = loadSession(path);
  const name = doc.name ?? basename(path).replace(/\.ya?ml$/, "");
  const out = flags.out ? resolve(process.env.INIT_CWD ?? process.cwd(), flags.out) : resolve(process.env.INIT_CWD ?? process.cwd(), "session_out", name);
  const r = await runSession(doc, name, {
    api: flags.api ?? process.env.API_URL ?? "http://localhost:8080", token: flags.token ?? process.env.API_TOKEN, outDir: out,
    baseDir: process.env.INIT_CWD ?? dirname(path), log: (l) => console.log(`[${name}] ${l}`),
  });
  console.log(`${r.passed ? "PASS" : "FAIL"} ${name}  -> ${out}${r.error ? "  " + r.error : ""}`);
  process.exit(r.passed ? 0 : 1);
}
