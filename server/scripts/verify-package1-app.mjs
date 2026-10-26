// End-to-end offline fixture. Run only with offline-network-guard.mjs preloaded.
// No production data, bucket, Gemini endpoint, or stored user key is used.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (!globalThis.__package1Outbound) throw new Error("offline network guard was not preloaded");
const url = new URL(process.env.PACKAGE1_TEST_DATABASE_URL ?? "postgres://invalid@invalid/");
if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/storyboards_pkg1_test") {
  throw new Error("fixture must target the loopback storyboards_pkg1_test database");
}
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query("DROP SCHEMA IF EXISTS pkg1_app CASCADE");
await admin.query("CREATE SCHEMA pkg1_app");
url.searchParams.set("options", "-c search_path=pkg1_app");
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
for (const name of ["001_init.sql", "002_identity.sql", "003_frame_continuity.sql"]) {
  const sql = await readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");
  await db.query("BEGIN");
  try {
    await db.query(sql);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

// These are fixture values. Env is set before app modules load, and the
// preloaded guard denies every non-loopback transport even if a stub is missed.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = url.toString();
process.env.DATABASE_SSL = "false";
process.env.AWS_ACCESS_KEY_ID = "fixture";
process.env.AWS_SECRET_ACCESS_KEY = "fixture";
process.env.AWS_REGION = "us-east-1";
process.env.S3_BUCKET = "fixture";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
globalThis.__package1Harness = {
  calls: { validate: 0, describe: 0, generate: 0, get: 0, put: 0, delete: 0 },
  objects: new Map(), gate: null, getGate: null, nextGenerationError: null,
};
const state = globalThis.__package1Harness;
const stubUrl = new URL("./package1-stubs.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier === "./gemini.js" || specifier === "./s3.js") &&
        context.parentURL?.includes("/server/dist/services/")) {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createApp } = await import("../dist/app.js");
const { pool } = await import("../dist/db/pool.js");
const { sweepStale } = await import("../dist/db/generations.js");
let commitFault = null;
const originalPgQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  if (args[0] === "COMMIT" && commitFault) {
    const fault = commitFault;
    commitFault = null;
    if (fault === "before") return Promise.reject(new Error("fixture: COMMIT not sent"));
    return Promise.resolve(originalPgQuery.apply(this, args)).then(() => {
      throw new Error("fixture: COMMIT acknowledged late");
    });
  }
  return originalPgQuery.apply(this, args);
};
const server = createApp().listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const request = async (method, path, token, body, expected) => {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response.status === 204 ? null : response.json();
};
const gate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i += 1) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture condition did not settle");
};
const status = async (id) => (await db.query(
  "SELECT status, error_code, input_snapshot, image_key FROM generations WHERE id = $1", [id])).rows[0];

try {
  const a = await request("POST", "/auth/register", null,
    { username: "fixture_a", password: "fixture-password-a", geminiApiKey: "dummy-key-a" }, 201);
  const b = await request("POST", "/auth/register", null,
    { username: "fixture_b", password: "fixture-password-b", geminiApiKey: "dummy-key-b" }, 201);
  assert.equal(state.calls.validate, 2);
  const storyA = await request("POST", "/stories", a.token, { title: "fixture story" }, 201);
  const storyB = await request("POST", "/stories", b.token, { title: "other story" }, 201);
  const frame = await request("POST", `/stories/${storyA.id}/frames`, a.token,
    { description: "  Authored scene.  " }, 201);
  const other = await request("POST", `/stories/${storyB.id}/frames`, b.token,
    { description: "other" }, 201);
  await request("GET", `/frames/${other.id}`, a.token, undefined, 404);
  await request("PATCH", `/frames/${other.id}`, a.token, { description: "no" }, 404);
  await request("POST", `/frames/${other.id}/generate`, a.token, {}, 404);

  const concept = await request("POST", "/concepts", a.token,
    { name: "Fixture", type: "character" }, 201);
  const conceptKey = `concepts/${concept.id}/reference.jpg`;
  state.objects.set(conceptKey, Buffer.from("fixture-reference"));
  await db.query("UPDATE concepts SET image_key = $1, image_mime = 'image/jpeg' WHERE id = $2",
    [conceptKey, concept.id]);
  assert.equal((await request("POST", `/concepts/${concept.id}/describe`,
    a.token, {}, 200)).description, "Fixture description");
  await request("PATCH", `/frames/${frame.id}`, a.token, { conceptIds: [concept.id] }, 200);
  console.log("offline app: fixture registration/key validation, describe, and ownership passed");

  const idempotencyKey = "910c2ec7-6ee6-4826-9816-1f38b621324e";
  const hold = gate();
  state.gate = hold.promise;
  const started = await request("POST", `/frames/${frame.id}/generate`, a.token,
    { requestId: idempotencyKey }, 202);
  const replay = await request("POST", `/frames/${frame.id}/generate`, a.token,
    { requestId: idempotencyKey }, 202);
  assert.equal(started.generationId, replay.generationId);
  const conflict = await request("POST", `/frames/${frame.id}/generate`, a.token,
    { requestId: "df545638-2f2e-45d6-83a5-73bb7bf0f0be" }, 409);
  assert.equal(conflict.error.code, "generation_in_progress");
  assert.equal(conflict.error.details.generationId, started.generationId);
  assert.equal(state.calls.generate, 1);
  const detail = await request("GET", `/frames/${frame.id}`, a.token, undefined, 200);
  const poll = await request("GET", `/generations/${started.generationId}`, a.token, undefined, 200);
  for (const dto of [detail, poll]) {
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes("inputSnapshot"), false);
    assert.equal(serialized.includes("imageKey"), false);
    assert.equal(serialized.includes("dummy-key"), false);
  }
  await request("GET", `/generations/${started.generationId}`, b.token, undefined, 404);
  const before = await status(started.generationId);
  assert.equal(before.status, "pending");
  assert.equal(before.input_snapshot.schemaVersion, 2);
  assert.equal(before.input_snapshot.frameDescription, "  Authored scene.  ");
  assert.equal(before.input_snapshot.continuity, null);
  assert.match(before.input_snapshot.concepts[0].imageSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(before.input_snapshot).includes("dummy-key"), false);
  hold.release();
  state.gate = null;
  await waitFor(async () => (await status(started.generationId)).status === "succeeded");
  assert.equal((await db.query("SELECT selected_generation_id FROM frames WHERE id = $1",
    [frame.id])).rows[0].selected_generation_id, started.generationId);
  const terminalReplay = await request("POST", `/frames/${frame.id}/generate`, a.token,
    { requestId: idempotencyKey }, 202);
  assert.equal(terminalReplay.generationId, started.generationId);
  assert.equal(state.calls.generate, 1);
  console.log("offline app: same-request replay, pending conflict, V2 snapshot, atomic selection passed");

  const overlap = await request("POST", `/stories/${storyA.id}/frames`, a.token,
    { description: "overlap fixture" }, 201);
  await request("PATCH", `/frames/${overlap.id}`, a.token, { conceptIds: [concept.id] }, 200);
  const readsBefore = state.calls.get;
  const overlapGate = gate();
  const generationGate = gate();
  state.getGate = overlapGate.promise;
  state.gate = generationGate.promise;
  const overlapKey = "e5f703ed-0916-429b-9a9e-de26336bef93";
  const requestOne = request("POST", `/frames/${overlap.id}/generate`, a.token,
    { requestId: overlapKey }, 202);
  const requestTwo = request("POST", `/frames/${overlap.id}/generate`, a.token,
    { requestId: overlapKey }, 202);
  await waitFor(() => state.calls.get >= readsBefore + 2);
  overlapGate.release();
  state.getGate = null;
  const [firstOverlap, secondOverlap] = await Promise.all([requestOne, requestTwo]);
  assert.equal(firstOverlap.generationId, secondOverlap.generationId);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM generations WHERE frame_id = $1",
    [overlap.id])).rows[0].count, 1);
  generationGate.release();
  state.gate = null;
  await waitFor(async () => (await status(firstOverlap.generationId)).status === "succeeded");
  console.log("offline app: overlapping same-request preflights admitted one runner");

  const uncertainAdmissionFrame = await request("POST", `/stories/${storyA.id}/frames`, a.token,
    { description: "admission acknowledgement fixture" }, 201);
  const dispatchesBeforeAdmission = state.calls.generate;
  commitFault = "after";
  const uncertainAdmission = await request("POST",
    `/frames/${uncertainAdmissionFrame.id}/generate`, a.token,
    { requestId: "c1f6bd7d-bafa-4601-9667-dd2a96a734b4" }, 503);
  assert.equal(uncertainAdmission.error.code, "admission_uncertain");
  const admittedId = uncertainAdmission.error.details.generationId;
  assert.equal((await status(admittedId)).status, "pending");
  assert.equal(state.calls.generate, dispatchesBeforeAdmission);
  await db.query("UPDATE generations SET created_at = now() - interval '10 minutes' WHERE id = $1",
    [admittedId]);
  assert.equal(await sweepStale(5 * 60_000), 1);
  const replayUncertain = await request("POST",
    `/frames/${uncertainAdmissionFrame.id}/generate`, a.token,
    { requestId: "c1f6bd7d-bafa-4601-9667-dd2a96a734b4" }, 202);
  assert.equal(replayUncertain.generationId, admittedId);
  assert.equal(state.calls.generate, dispatchesBeforeAdmission);
  console.log("offline app: lost admission COMMIT ack preserved one row and launched no runner");

  const source = await request("POST", `/stories/${storyA.id}/frames`, a.token,
    { description: "source" }, 201);
  await request("PATCH", `/frames/${frame.id}`, a.token,
    { continuitySourceFrameId: source.id }, 422);
  await db.query("UPDATE frames SET continuity_source_frame_id = $1 WHERE id = $2",
    [source.id, frame.id]);
  const priorCalls = state.calls.generate;
  await request("POST", `/frames/${frame.id}/generate`, a.token,
    { requestId: "1240af5c-6bc8-4da8-9a76-cff787ece7b5" }, 422);
  assert.equal(state.calls.generate, priorCalls);
  await request("PATCH", `/frames/${frame.id}`, a.token,
    { continuitySourceFrameId: null }, 200);
  await request("PATCH", `/frames/${frame.id}`, a.token, { position: 500 }, 200);
  await request("PATCH", `/frames/${source.id}`, a.token, { position: 500 }, 200);
  const tied = (await request("GET", `/stories/${storyA.id}/frames`, a.token, undefined, 200))
    .filter((item) => item.position === 500).map((item) => item.id);
  assert.deepEqual(tied, [frame.id, source.id].sort());
  console.log("offline app: partial rollout refuses source configuration and dispatch");

  const invalid = new Error("fixture rejected");
  invalid.status = 401;
  state.nextGenerationError = invalid;
  const rejected = await request("POST", `/frames/${frame.id}/generate`, a.token,
    { requestId: "cc2ec291-45f4-47f2-b7c6-b0a2d0fe5c31" }, 202);
  await waitFor(async () => (await status(rejected.generationId)).status === "failed");
  assert.equal((await status(rejected.generationId)).error_code, "invalid_api_key");
  console.log("offline app: invalid_api_key retained in shared terminal taxonomy");

  for (const fault of ["after", "before"]) {
    const uncertainFrame = await request("POST", `/stories/${storyA.id}/frames`, a.token,
      { description: "uncertain commit fixture" }, 201);
    const uncertainHold = gate();
    state.gate = uncertainHold.promise;
    const uncertain = await request("POST", `/frames/${uncertainFrame.id}/generate`, a.token,
      { requestId: fault === "after"
        ? "29919f8c-079e-4e06-8456-7135cd8e0192"
        : "ca8d1063-6c65-458c-b83d-23aa70b20bd0" }, 202);
    const dispatches = state.calls.generate;
    commitFault = fault;
    uncertainHold.release();
    state.gate = null;
    await waitFor(async () => (await status(uncertain.generationId)).status === "succeeded");
    assert.equal(state.calls.generate, dispatches);
    assert.equal(state.objects.has(`generations/${uncertain.generationId}.jpg`), true);
    assert.equal((await db.query("SELECT selected_generation_id FROM frames WHERE id = $1",
      [uncertainFrame.id])).rows[0].selected_generation_id, uncertain.generationId);
  }
  console.log("offline app: lost and rolled-back finalization COMMIT kept one dispatch and saved output");

  const sweptFrame = await request("POST", `/stories/${storyA.id}/frames`, a.token,
    { description: "sweep fixture" }, 201);
  const sweptHold = gate();
  state.gate = sweptHold.promise;
  const swept = await request("POST", `/frames/${sweptFrame.id}/generate`, a.token,
    { requestId: "f01fcd1b-60a9-4d85-b275-6d2857ff5818" }, 202);
  await db.query("UPDATE generations SET created_at = now() - interval '10 minutes' WHERE id = $1",
    [swept.generationId]);
  assert.equal(await sweepStale(5 * 60_000), 1);
  sweptHold.release();
  state.gate = null;
  await waitFor(async () => state.calls.delete > 0);
  assert.equal((await status(swept.generationId)).error_code, "abandoned");
  assert.equal((await db.query("SELECT selected_generation_id FROM frames WHERE id = $1",
    [sweptFrame.id])).rows[0].selected_generation_id, null);
  assert.equal(state.objects.has(`generations/${swept.generationId}.jpg`), false);
  console.log("offline app: late output after sweep removed without resurrection");

  const deletedFrame = await request("POST", `/stories/${storyA.id}/frames`, a.token,
    { description: "delete fixture" }, 201);
  const deleteHold = gate();
  state.gate = deleteHold.promise;
  const deleting = await request("POST", `/frames/${deletedFrame.id}/generate`, a.token,
    { requestId: "372633ed-0490-4b11-884d-457886f9b12d" }, 202);
  const deletesBefore = state.calls.delete;
  await request("DELETE", `/frames/${deletedFrame.id}`, a.token, undefined, 204);
  deleteHold.release();
  state.gate = null;
  await waitFor(async () => state.calls.delete > deletesBefore);
  assert.equal((await status(deleting.generationId)), undefined);
  assert.equal(state.objects.has(`generations/${deleting.generationId}.jpg`), false);
  console.log("offline app: deletion and late finalization left no output object");

  const disposableStory = await request("POST", "/stories", a.token, { title: "delete story" }, 201);
  const disposableFrame = await request("POST", `/stories/${disposableStory.id}/frames`, a.token,
    { description: "stored output" }, 201);
  const stored = await request("POST", `/frames/${disposableFrame.id}/generate`, a.token,
    { requestId: "145889c7-ed2b-48db-97a7-3f7f47475b35" }, 202);
  await waitFor(async () => (await status(stored.generationId)).status === "succeeded");
  const storedKey = `generations/${stored.generationId}.jpg`;
  assert.equal(state.objects.has(storedKey), true);
  await request("DELETE", `/stories/${disposableStory.id}`, a.token, undefined, 204);
  assert.equal(state.objects.has(storedKey), false);
  console.log("offline app: story deletion collected committed output under the story lock");

  assert.equal(globalThis.__package1Outbound.blocked, 0);
  console.log(`offline app: stub dispatches generate=${state.calls.generate}, validate=${state.calls.validate}, describe=${state.calls.describe}; real outbound=0`);
} finally {
  pg.Client.prototype.query = originalPgQuery;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await db.end();
  await admin.query("DROP SCHEMA IF EXISTS pkg1_app CASCADE");
  await admin.end();
}
