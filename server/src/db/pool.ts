// pg is CommonJS; a default import is the interop shape that works reliably
// under NodeNext ESM resolution.
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Railway's external connection string terminates TLS at a proxy whose
  // certificate does not validate against the public roots.
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Without this handler an error on an idle pooled client is an unhandled
// 'error' event, which takes the whole process down.
pool.on("error", (err) => {
  console.error("[db] idle client error", err);
});

export function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[] | undefined);
}

/**
 * Run a callback inside a single transaction, rolling back on any throw.
 *
 * Needed wherever a multi-statement invariant must hold: replacing a frame's
 * concept attachments (the DELETE must land before the INSERT, or reused `ord`
 * values collide with the unique index), and appending a frame (reading
 * max(position) and inserting must not interleave with another append).
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
