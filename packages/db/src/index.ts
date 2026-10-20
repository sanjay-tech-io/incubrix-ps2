import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

// Why plain SQL + this ~80-line runner instead of an ORM: the schema is small, reviewers can
// read every statement, and CLAUDE.md fixes "plain SQL migrations, pg". Files are NNNN_name.sql,
// applied in order, each in its own transaction, recorded with a sha256 so an edited
// (already applied) migration is detected instead of silently diverging.

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

const DEFAULT_DIR = new URL("../migrations/", import.meta.url);

export function readMigrations(dir: string | URL = DEFAULT_DIR): Migration[] {
  const base = typeof dir === "string" ? new URL(`file://${dir.endsWith("/") ? dir : dir + "/"}`) : dir;
  const out: Migration[] = [];
  for (const file of readdirSync(base).filter((f) => f.endsWith(".sql")).sort()) {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!m) throw new Error(`Bad migration file name "${file}": expected NNNN_snake_case_name.sql`);
    const sql = readFileSync(new URL(file, base), "utf8");
    out.push({ version: Number(m[1]), name: m[2]!, file, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  out.sort((a, b) => a.version - b.version);
  out.forEach((mig, i) => {
    if (i > 0 && mig.version === out[i - 1]!.version) throw new Error(`Duplicate migration version ${mig.version}`);
    if (mig.version !== i + 1) throw new Error(`Gap in migration versions: expected ${i + 1}, found ${mig.version} (${mig.file})`);
  });
  return out;
}

export async function migrate(databaseUrl: string, dir?: string | URL): Promise<{ applied: string[] }> {
  const migrations = readMigrations(dir);
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    // Why advisory lock: api and worker may both start and migrate; only one may run at a time.
    await c.query("select pg_advisory_lock(727001)");
    await c.query(`create table if not exists schema_migrations (
      version int primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
    const { rows } = await c.query<{ version: number; checksum: string }>("select version, checksum from schema_migrations");
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const have = done.get(m.version);
      if (have !== undefined) {
        if (have !== m.checksum) throw new Error(`Migration ${m.file} checksum differs from the one applied; never edit an applied migration, add a new one`);
        continue;
      }
      try {
        await c.query("begin");
        await c.query(m.sql);
        await c.query("insert into schema_migrations(version, name, checksum) values ($1,$2,$3)", [m.version, m.name, m.checksum]);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw new Error(`Migration ${m.file} failed: ${(e as Error).message}`);
      }
      applied.push(m.file);
    }
  } finally {
    await c.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    await c.end();
  }
  return { applied };
}
