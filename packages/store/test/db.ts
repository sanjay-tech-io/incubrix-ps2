import pg from "pg";
import { migrate } from "@incubrix/db";

// Integration helper: a throwaway migrated database on the compose Postgres (TEST_DATABASE_URL).
export async function tempDb(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL!;
  const name = `store_test_${process.pid}_${Date.now()}_${Math.floor(Math.abs(Math.sin(Date.now())) * 1e6)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  await migrate(u.toString());
  const pool = new pg.Pool({ connectionString: u.toString(), max: 8 });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
