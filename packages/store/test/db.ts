import pg from "pg";
import { migrate } from "@incubrix/db";

// Integration helper: a throwaway migrated database on the compose Postgres (TEST_DATABASE_URL).
export async function tempDb(): Promise<{ pool: pg.Pool; url: string; drop: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL!;
  const name = `store_test_${process.pid}_${Date.now()}_${Math.floor(Math.abs(Math.sin(Date.now())) * 1e6)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  await migrate(u.toString());
  const pool = new pg.Pool({ connectionString: u.toString(), max: 8 });
  // `drop database ... with (force)` kills any connection still open; the pool reports that as an error event, which is expected here.
  pool.on("error", () => undefined);
  return {
    pool,
    url: u.toString(),
    drop: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
