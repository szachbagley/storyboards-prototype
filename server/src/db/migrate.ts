import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

// Resolves to server/migrations from both src/db/ and dist/db/, so the .sql
// files never need to be copied into the build output.
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

// Arbitrary but fixed. Two deploys migrating at the same time serialize on this
// lock instead of racing to apply the same file.
const ADVISORY_LOCK_KEY = 49_172_026;

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename    TEXT PRIMARY KEY,
          applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      const { rows } = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      const applied = new Set(rows.map((row) => row.filename));

      // Lexicographic sort, which is why filenames carry a zero-padded numeric
      // prefix -- 010_ must not sort before 002_.
      const files = (await readdir(MIGRATIONS_DIR))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const pending = files.filter((name) => !applied.has(name));

      if (pending.length === 0) {
        console.log("[migrate] no pending migrations");
        return;
      }

      for (const filename of pending) {
        const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${filename} failed`, { cause: err });
        }
        console.log(`[migrate] applied ${filename}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

try {
  await migrate();
} catch (err) {
  console.error("[migrate] failed:", err);
  await pool.end();
  process.exit(1);
}
await pool.end();
