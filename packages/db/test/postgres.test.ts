import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, readMigrations } from "../src/index.js";

// Integration: needs a real Postgres. `docker compose run tests` sets TEST_DATABASE_URL;
// without it these tests are SKIPPED (vitest reports them as skipped, never as passed).
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("migrations against Postgres", () => {
  const dbName = `mig_test_${process.pid}_${Date.now()}`;
  let admin: pg.Client;
  let dbUrl: string;
  let c: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    c = new pg.Client({ connectionString: dbUrl });
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
    await admin.query(`drop database ${dbName}`);
    await admin.end();
  });

  it("applies everything once and is a no-op the second time", async () => {
    const first = await migrate(dbUrl);
    expect(first.applied.length).toBe(readMigrations().length);
    const second = await migrate(dbUrl);
    expect(second.applied).toEqual([]);
    const { rows } = await c.query("select count(*)::int n from schema_migrations");
    expect(rows[0].n).toBe(readMigrations().length);
  });

  it("creates the seven required tables", async () => {
    const { rows } = await c.query("select table_name from information_schema.tables where table_schema='public'");
    const names = rows.map((r) => r.table_name);
    for (const t of ["sessions", "source_assets", "operation_log", "conversation_log", "idempotency_keys", "jobs", "llm_cache"]) expect(names).toContain(t);
  });

  it("operation_log is append-only (UPDATE and DELETE are rejected)", async () => {
    await c.query("insert into sessions(id, source_sha256) values ('s1', repeat('a',64))");
    await c.query(`insert into operation_log(session_id, seq, group_no, kind, op) values ('s1', 1, 1, 'cut', '{}')`);
    await expect(c.query("update operation_log set kind='x' where session_id='s1'")).rejects.toThrow(/append-only/);
    await expect(c.query("delete from operation_log where session_id='s1'")).rejects.toThrow(/append-only/);
  });

  it("idempotency key is unique per (scope, key)", async () => {
    const ins = "insert into idempotency_keys(scope, key, request_hash) values ('POST /sessions','k1','h')";
    await c.query(ins);
    await expect(c.query(ins)).rejects.toThrow(/duplicate key/);
  });

  it("jobs reject a bad status and out-of-range progress", async () => {
    await expect(c.query("insert into jobs(id, type, status) values ('j1','ingest','weird')")).rejects.toThrow();
    await expect(c.query("insert into jobs(id, type, status, progress) values ('j2','ingest','queued',101)")).rejects.toThrow();
  });

  it("refuses to run when an applied migration file was edited", async () => {
    await c.query("update schema_migrations set checksum = repeat('0',64) where version = 1");
    await expect(migrate(dbUrl)).rejects.toThrow(/checksum/i);
  });
});
