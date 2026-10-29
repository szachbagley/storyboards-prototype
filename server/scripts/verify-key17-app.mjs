// Route-level offline check with an isolated loopback PostgreSQL database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (!globalThis.__package1Outbound) throw new Error("offline guard was not preloaded");
const dbUrl = new URL(process.env.KEY17_TEST_DATABASE_URL ?? "postgres://invalid@invalid/");
if (dbUrl.hostname !== "127.0.0.1" || dbUrl.port !== "55417" ||
    dbUrl.pathname !== "/storyboards_key17_test") {
  throw new Error("key17 fixture requires its disposable loopback database");
}
const watchdog = setTimeout(() => { throw new Error("key17 fixture exceeded 30 seconds"); }, 30_000);
const admin = new pg.Client({ connectionString: dbUrl.toString() });
let db;
let server;
let pool;
try {
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS key17_app CASCADE");
  await admin.query("CREATE SCHEMA key17_app");
  dbUrl.searchParams.set("options", "-c search_path=key17_app -c statement_timeout=5000");
  db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  for (const migration of ["001_init.sql", "002_identity.sql", "003_frame_continuity.sql"]) {
    const sql = await readFile(fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url)), "utf8");
    await db.query("BEGIN");
    try { await db.query(sql); await db.query("COMMIT"); }
    catch (error) { await db.query("ROLLBACK"); throw error; }
  }

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = dbUrl.toString();
  process.env.DATABASE_SSL = "false";
  process.env.AWS_ACCESS_KEY_ID = "fixture";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture";
  process.env.AWS_REGION = "us-east-1";
  process.env.S3_BUCKET = "fixture";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  globalThis.__key17Fixture = { keysSeen: [], calls: [], nextError: null, nextStatus: null, emptyResponse: false };
  const fixture = globalThis.__key17Fixture;
  const stubUrl = new URL("./key17-validation-stub.mjs", import.meta.url).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "./keyValidationTransport.js" && context.parentURL?.includes("/server/dist/services/gemini.js")) {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  const { createApp } = await import("../dist/app.js");
  ({ pool } = await import("../dist/db/pool.js"));
  const { decryptSecret } = await import("../dist/services/secretBox.js");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const oldKey = "fixture-old-key-1234", newKey = "fixture-new-key-5678";
  const send = async (method, path, body, token) => {
    const response = await fetch(`${origin}/api${path}`, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const registered = await send("POST", "/auth/register", {
    username: "key17fixture", password: "fixture-password-123", geminiApiKey: oldKey,
  });
  assert.equal(registered.status, 201);
  const token = registered.body.token;
  assert.ok(typeof token === "string");
  assert.equal(JSON.stringify(registered.body).includes(oldKey), false);
  const userId = registered.body.user.id;
  const currentRow = async () => (await db.query(
    "SELECT gemini_key_ciphertext, gemini_key_iv, gemini_key_tag, gemini_key_hint FROM users WHERE id = $1",
    [userId])).rows[0];
  const decryptRow = (row) => decryptSecret({
    ciphertext: row.gemini_key_ciphertext, iv: row.gemini_key_iv, tag: row.gemini_key_tag,
  });
  const first = await currentRow();
  assert.equal(decryptRow(first), oldKey);
  const checkPreserved = async (error, expectedStatus, expectedCode) => {
    fixture.nextError = error;
    const result = await send("PATCH", "/auth/me", { geminiApiKey: newKey }, token);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.body.error.code, expectedCode);
    assert.equal(JSON.stringify(result.body).includes(newKey), false);
    const row = await currentRow();
    assert.deepEqual(row.gemini_key_ciphertext, first.gemini_key_ciphertext);
    assert.deepEqual(row.gemini_key_iv, first.gemini_key_iv);
    assert.deepEqual(row.gemini_key_tag, first.gemini_key_tag);
    assert.equal(row.gemini_key_hint, first.gemini_key_hint);
  };
  const structured = (status, reason) => Object.assign(new Error(JSON.stringify({ error: {
    code: status, status: "INVALID_ARGUMENT", details: [{ reason }],
  } })), { name: "ApiError", status });
  await checkPreserved(structured(400, "API_KEY_INVALID"), 422, "invalid_api_key");
  await checkPreserved(structured(400, "OTHER"), 502, "upstream_error");
  await checkPreserved(structured(403, "PERMISSION_DENIED"), 422, "api_key_access_denied");
  await checkPreserved(structured(429, "RESOURCE_EXHAUSTED"), 503, "upstream_error");
  await checkPreserved(Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" }), 504, "timeout");
  await checkPreserved(new DOMException("timeout", "TimeoutError"), 504, "timeout");
  await checkPreserved(structured(503, "UNAVAILABLE"), 502, "upstream_error");
  fixture.nextStatus = "failed";
  const incomplete = await send("PATCH", "/auth/me", { geminiApiKey: newKey }, token);
  assert.equal(incomplete.status, 502);
  assert.equal(incomplete.body.error.code, "upstream_error");
  assert.deepEqual((await currentRow()).gemini_key_ciphertext, first.gemini_key_ciphertext);
  fixture.emptyResponse = true;
  const updated = await send("PATCH", "/auth/me", { geminiApiKey: newKey }, token);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.geminiKeyHint, newKey.slice(-4));
  assert.equal(JSON.stringify(updated.body).includes(newKey), false);
  const second = await currentRow();
  assert.equal(decryptRow(second), newKey);
  assert.notDeepEqual(second.gemini_key_ciphertext, first.gemini_key_ciphertext);
  assert.ok(fixture.calls.every((call) => call.hasSignal));
  assert.equal(fixture.calls.length, 10);
  assert.deepEqual(fixture.keysSeen, [oldKey, ...Array(9).fill(newKey)]);
  assert.equal(globalThis.__package1Outbound.blocked, 0);
  console.log("key17 route: registration, eight safe failures, empty-text success with encrypted replacement passed; validation stub calls=10; real outbound=0");
} finally {
  clearTimeout(watchdog);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (db) await db.end();
  await admin.end();
}
