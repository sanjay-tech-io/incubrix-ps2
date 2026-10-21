import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadSession } from "./format.ts";
import { runSession, type SessionResult } from "./runner.ts";
import { args } from "./session.ts";

export function sessionFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(target, f));
}

export interface BatchSummary {
  api: string;
  total: number;
  passed: number;
  failed: number;
  sessions: { name: string; file: string; passed: boolean; steps: number; failed_steps: { step: number; failure: string | null }[]; error: string | null; final_timeline_hash: string | null; folder: string }[];
}

/** Run every session file, write each one's results to <out>/<name>/ and one summary.json. Failures are kept, never hidden. */
export async function runBatch(target: string, outDir: string, o: { api: string; token?: string | undefined; baseDir?: string | undefined; log?: (l: string) => void; idle?: () => Promise<void> }): Promise<BatchSummary> {
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const summary: BatchSummary = { api: o.api, total: 0, passed: 0, failed: 0, sessions: [] };
  for (const file of sessionFiles(resolve(target))) {
    const name = basename(file).replace(/\.ya?ml$/, "");
    let r: SessionResult;
    try {
      const doc = loadSession(file);
      r = await runSession(doc, doc.name ?? name, { api: o.api, token: o.token, outDir: join(out, name), baseDir: o.baseDir, ...(o.log ? { log: (l: string) => o.log!(`[${name}] ${l}`) } : {}), ...(o.idle ? { idle: o.idle } : {}) });
    } catch (e) {
      r = { name, video: "", passed: false, video_id: null, session_id: null, intake: null, steps: [], final: null, error: (e as Error).message };
    }
    summary.total++;
    if (r.passed) summary.passed++;
    else summary.failed++;
    summary.sessions.push({
      name, file: basename(file), passed: r.passed, steps: r.steps.length,
      failed_steps: r.steps.filter((s) => !s.passed).map((s) => ({ step: s.step, failure: s.failure })), error: r.error, final_timeline_hash: r.final?.timeline_hash ?? null, folder: name,
    });
    o.log?.(`${r.passed ? "PASS" : "FAIL"} ${name}${r.error ? "  " + r.error : ""}`);
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { flags, rest } = args(process.argv.slice(2));
  const target = rest[0];
  if (!target || !flags.out) {
    console.error("usage: npm run batch -- <folder or file> --out <dir> [--api <url>] [--token <token>]");
    process.exit(2);
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const s = await runBatch(resolve(cwd, target), resolve(cwd, flags.out), {
    api: flags.api ?? process.env.API_URL ?? "http://localhost:8080", token: flags.token ?? process.env.API_TOKEN, baseDir: cwd, log: (l) => console.log(l),
  });
  console.log(`\n${s.passed}/${s.total} sessions passed, ${s.failed} failed -> ${resolve(cwd, flags.out, "summary.json")}`);
  process.exit(s.failed === 0 ? 0 : 1);
}
