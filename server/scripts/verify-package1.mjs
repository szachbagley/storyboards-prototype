// Disposable SQL matrix. Refuses every database except the explicitly named
// loopback fixture; it never imports app startup or the Gemini/S3 SDKs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = new URL(process.env.PACKAGE1_TEST_DATABASE_URL ?? "postgres://invalid@invalid/");
if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/storyboards_pkg1_test") {
  throw new Error("PACKAGE1_TEST_DATABASE_URL must target the loopback storyboards_pkg1_test database");
}
const schema = "pkg1_check";
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({ connectionString: url.toString(), max: 4,
  options: `-c search_path=${schema}` });
const sql = (await Promise.all(["001_init.sql", "002_identity.sql", "003_frame_continuity.sql"]
  .map((name) => readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8"))));

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rejectsConstraint(fn, name) {
  await assert.rejects(() => tx(fn), (error) =>
    error.code === (name.startsWith("frames_continuity_not_self") ? "23514" :
      name === "frames_continuity_source_fk" ? "23503" : "23505") &&
      error.constraint === name);
}

try {
  await tx((client) => client.query(sql[0]));
  await tx((client) => client.query(sql[1]));
  const fixture = await tx(async (client) => {
    const u = await client.query(
      "INSERT INTO users (username, password_hash) VALUES ('fixture_a', 'dummy'), ('fixture_b', 'dummy') RETURNING id");
    const s = await client.query(
      "INSERT INTO stories (user_id, title) VALUES ($1, 'one'), ($2, 'two') RETURNING id",
      [u.rows[0].id, u.rows[1].id]);
    const f = await client.query(
      "INSERT INTO frames (story_id, position, description) VALUES ($1, 1, 'scene'), ($1, 2, 'source'), ($2, 1, 'other') RETURNING id",
      [s.rows[0].id, s.rows[1].id]);
    const historical = { frameDescription: "scene", aspectRatio: "16:9", imageSize: "1K", concepts: [] };
    const g = await client.query(
      `INSERT INTO generations (frame_id, status, model, compiled_prompt, input_snapshot)
       VALUES ($1, 'pending', 'fixture', 'scene', $2),
              ($1, 'pending', 'fixture', 'scene', $2) RETURNING id`,
      [f.rows[0].id, historical]);
    return { users: u.rows, stories: s.rows, frames: f.rows, generations: g.rows, historical };
  });

  await assert.rejects(() => tx((client) => client.query(sql[2])),
    (error) => error.message.includes("duplicate pending generations"));
  const noColumn = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'frames' AND column_name = 'continuity_source_frame_id'",
    [schema]);
  assert.equal(noColumn.rowCount, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM generations")).rows[0].count, 2);
  console.log("migration: duplicate pending abort rolled back without data loss");

  // This is disposable fixture data, not a repair of any live pending work.
  await pool.query("UPDATE generations SET status = 'failed' WHERE id = $1", [fixture.generations[1].id]);
  await tx((client) => client.query(sql[2]));
  const after = await pool.query(
    "SELECT request_id, input_snapshot FROM generations WHERE id = $1", [fixture.generations[0].id]);
  assert.equal(after.rows[0].request_id, null);
  assert.deepEqual(after.rows[0].input_snapshot, fixture.historical);
  assert.equal((await pool.query("SELECT continuity_source_frame_id FROM frames WHERE id = $1",
    [fixture.frames[0].id])).rows[0].continuity_source_frame_id, null);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1 AND indexname = 'generations_pending_idx'",
    [schema])).rows[0].count, 1);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = $1 AND indexname = 'frames_continuity_source_idx'",
    [schema])).rows[0].count, 1);
  console.log("migration: old rows/JSON preserved; new fields null; sweeper index retained");

  await rejectsConstraint((client) => client.query(
    `INSERT INTO generations (frame_id, model, compiled_prompt, input_snapshot)
     VALUES ($1, 'fixture', 'scene', '{}')`, [fixture.frames[0].id]),
    "generations_one_pending_per_frame_uidx");
  const requestId = "a4e20979-9ccb-4b5e-8eb9-f703d230ab4b";
  await pool.query("UPDATE generations SET request_id = $1 WHERE id = $2",
    [requestId, fixture.generations[1].id]);
  await rejectsConstraint((client) => client.query(
    `INSERT INTO generations (frame_id, status, request_id, model, compiled_prompt, input_snapshot)
     VALUES ($1, 'failed', $2, 'fixture', 'scene', '{}')`, [fixture.frames[0].id, requestId]),
    "generations_frame_request_uidx");
  await rejectsConstraint((client) => client.query(
    "UPDATE frames SET continuity_source_frame_id = id WHERE id = $1", [fixture.frames[0].id]),
    "frames_continuity_not_self");
  await rejectsConstraint((client) => client.query(
    "UPDATE frames SET continuity_source_frame_id = $1 WHERE id = $2",
    ["ad448b15-4fd9-4e39-90ec-89855353549b", fixture.frames[0].id]),
    "frames_continuity_source_fk");
  await pool.query("UPDATE frames SET continuity_source_frame_id = $1 WHERE id = $2",
    [fixture.frames[1].id, fixture.frames[0].id]);
  await pool.query("DELETE FROM frames WHERE id = $1", [fixture.frames[1].id]);
  assert.equal((await pool.query("SELECT continuity_source_frame_id FROM frames WHERE id = $1",
    [fixture.frames[0].id])).rows[0].continuity_source_frame_id, null);
  console.log("constraints: pending/request uniqueness, self/FK rejection, source-delete nulling");

  // A second admission waits for the owner story lock, then observes the
  // committed first pending row. No network or SDK work occurs in this matrix.
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    await first.query("SELECT id FROM stories WHERE id = $1 FOR UPDATE", [fixture.stories[0].id]);
    await first.query("SELECT id FROM frames WHERE id = $1 FOR UPDATE", [fixture.frames[0].id]);
    let acquired = false;
    const waiting = second.query("SELECT id FROM stories WHERE id = $1 FOR UPDATE",
      [fixture.stories[0].id]).then(() => { acquired = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(acquired, false);
    await first.query("COMMIT");
    await waiting;
    assert.equal((await second.query(
      "SELECT count(*)::int AS count FROM generations WHERE frame_id = $1 AND status = 'pending'",
      [fixture.frames[0].id])).rows[0].count, 1);
    await second.query("COMMIT");
  } finally {
    first.release();
    second.release();
  }
  console.log("concurrency: second story-first admission waited and observed pending row");

  const terminal = await tx(async (client) => {
    await client.query("SELECT id FROM stories WHERE id = $1 FOR UPDATE", [fixture.stories[0].id]);
    const failed = await client.query(
      "UPDATE generations SET status = 'failed' WHERE id = $1 AND status = 'pending'",
      [fixture.generations[0].id]);
    const late = await client.query(
      "UPDATE generations SET status = 'succeeded', image_key = 'fixture.jpg' WHERE id = $1 AND status = 'pending'",
      [fixture.generations[0].id]);
    const select = await client.query(
      `UPDATE frames SET selected_generation_id = $1 WHERE id = $2 AND selected_generation_id IS NULL
       AND EXISTS (SELECT 1 FROM generations WHERE id = $1 AND frame_id = $2
         AND status = 'succeeded' AND image_key IS NOT NULL)`,
      [fixture.generations[0].id, fixture.frames[0].id]);
    return { failed: failed.rowCount, late: late.rowCount, select: select.rowCount };
  });
  assert.deepEqual(terminal, { failed: 1, late: 0, select: 0 });
  console.log("lifecycle: swept failure cannot be resurrected or auto-selected");

  // Ownership matrix through the same joins used by the app's reads.
  const foreign = await pool.query(
    `SELECT f.id FROM frames f JOIN stories st ON st.id = f.story_id
     WHERE f.id = $1 AND st.user_id = $2`, [fixture.frames[2].id, fixture.users[0].id]);
  assert.equal(foreign.rowCount, 0);
  console.log("ownership: foreign frame invisible through owned story join");
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
