// Exercise the real validator/transport using only loopback HTTP.
// Run after build, with --import ./server/scripts/offline-network-guard.mjs.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { once, getEventListeners } from "node:events";
import { API_KEY_VALIDATION_DEADLINE_MS, API_KEY_VALIDATION_URL,
  API_KEY_VALIDATION_MAX_RESPONSE_BYTES } from "@storyboards/shared";

if (!globalThis.__package1Outbound) throw new Error("offline guard was not preloaded");
const originalRequest = https.request;
const originalError = console.error;
const originalWarn = console.warn;
const logs = [];
const key = "fixture-secret-sentinel";
const scenarios = [];
let requests = 0;
let phase = "setup";
let cancelled = 0;
const closed = [];
const calls = [];
const gcTimer = typeof globalThis.gc === "function" ? setInterval(() => globalThis.gc(), 100) : undefined;
const server = http.createServer((request, response) => {
  const requestChunks = [];
  request.on("data", (chunk) => requestChunks.push(chunk));
  request.on("end", () => assert.equal(Buffer.concat(requestChunks).length, 0, "metadata request must not generate"));
  requests += 1;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/v1beta/models?pageSize=1");
  assert.equal(request.headers["x-goog-api-key"], key);
  const scenario = scenarios.shift();
  assert.ok(scenario, "unexpected retry/request");
  if (scenario.stall || scenario.oversized) {
    response.once("close", () => { cancelled += 1; });
    closed.push(once(response, "close"));
    if (scenario.stall === "headers") return;
    response.writeHead(scenario.status, { "Content-Type": "application/json" });
    response.write(scenario.oversized ? "x".repeat(API_KEY_VALIDATION_MAX_RESPONSE_BYTES + 1) : "{");
    return;
  }
  response.writeHead(scenario.status, { "Content-Type": "application/json", ...scenario.headers });
  response.end(scenario.raw ?? JSON.stringify(scenario.body));
});
const watchdog = setTimeout(() => {
  throw new Error(`key17 transport fixture exceeded 30 seconds: phase=${phase}, requests=${requests}, cancelled=${cancelled}`);
}, 30_000);
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Replace only the destination/protocol. Native HTTP streams and signal
  // handling stay intact, and the socket guard rejects any remote connection.
  https.request = (url, init, callback) => {
    assert.equal(url, API_KEY_VALIDATION_URL);
    assert.equal(init.method, "GET");
    const call = { signal: init.signal, requestClosed: false };
    calls.push(call);
    const request = http.request(`${origin}/v1beta/models?pageSize=1`, init, callback);
    request.on("socket", (socket) => { call.socket = socket; });
    request.once("close", () => { call.requestClosed = true; });
    return request;
  };
  syncBuiltinESMExports();
  console.error = (...args) => logs.push(args.map(String).join(" "));
  console.warn = (...args) => logs.push(args.map(String).join(" "));
  const { validateApiKey } = await import("../dist/services/gemini.js");
  const { requestKeyValidation } = await import("../dist/services/keyValidationTransport.js");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(requestKeyValidation(key, alreadyAborted.signal), { name: "AbortError" });
  assert.equal(calls.length, 0, "an already-aborted request must not open a connection");
  const call = async (scenario) => {
    scenarios.push(scenario);
    try { return await validateApiKey(key); }
    catch (error) {
      assert.equal(String(error).includes(key), false, "key leaked in validation error");
      return { status: error.status, code: error.code };
    }
  };
  const errorBody = (status, reason) => ({ error: { code: status, message: key,
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }],
  } });
  phase = "error/success matrix";
  for (const [status, reason, expected] of [
    [400, "API_KEY_INVALID", false],
    [401, "UNAUTHENTICATED", false],
    [403, "API_KEY_INVALID", false],
    [400, "OTHER", { status: 502, code: "upstream_error" }],
    [403, "PERMISSION_DENIED", { status: 422, code: "api_key_access_denied" }],
    [429, "RESOURCE_EXHAUSTED", { status: 503, code: "upstream_error" }],
    [503, "UNAVAILABLE", { status: 503, code: "upstream_error" }],
    [504, "DEADLINE_EXCEEDED", { status: 504, code: "timeout" }],
  ]) {
    assert.deepEqual(await call({ status, body: errorBody(status, reason) }), expected);
  }
  assert.equal(await call({ status: 200, body: { models: [{ name: "models/fixture" }] } }), true);
  assert.equal(await call({ status: 200, body: {} }), true);
  for (const scenario of [
    { status: 200, raw: "{malformed" },
    { status: 200, raw: "" },
    { status: 200, body: { models: "bad" } },
    { status: 200, oversized: true },
    { status: 302, headers: { Location: `${origin}/must-not-follow` }, raw: "" },
  ]) {
    assert.deepEqual(await call(scenario), { status: 502, code: "upstream_error" });
  }

  // Concurrent stalls share no state except the fixture queue. Each uses the
  // unchanged production 20s timeout. Direct transport calls below also prove
  // settling without the application Promise.race; GC exposes lost references.
  const began = performance.now();
  phase = "timeout matrix";
  const appResults = Promise.all([
    call({ stall: "headers", status: 200 }),
    call({ stall: "body", status: 200 }),
    call({ stall: "body", status: 400 }),
  ]);
  const directResults = [];
  for (const scenario of [
    { stall: "headers", status: 200 }, { stall: "body", status: 200 }, { stall: "body", status: 400 },
  ]) {
    scenarios.push(scenario);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_KEY_VALIDATION_DEADLINE_MS);
    directResults.push(assert.rejects(requestKeyValidation(key, controller.signal), { name: "AbortError" })
      .finally(() => clearTimeout(timer)));
  }
  const results = await appResults;
  await Promise.all(directResults);
  assert.deepEqual(results, Array(3).fill({ status: 504, code: "timeout" }));
  const deadlineLogs = logs.filter((line) => line.includes("key validation deadline"));
  assert.equal(deadlineLogs.length, 3);
  assert.equal(deadlineLogs.filter((line) => line.includes("stage=request_finished")).length, 1);
  assert.equal(deadlineLogs.filter((line) => line.includes("stage=headers_received")).length, 2);
  phase = "socket cancellation";
  await Promise.all(closed);
  assert.equal(cancelled, 7); // Six active stalls plus the oversized body.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.slice(-6).every((call) => call.signal.aborted && call.requestClosed));
  assert.ok(calls.every((call) => getEventListeners(call.signal, "abort").length === 0), "abort listener leak");
  for (const call of calls) {
    for (const event of ["lookup", "connect", "secureConnect"]) {
      assert.equal(getEventListeners(call.socket, event).length, 0, `${event} listener leak`);
    }
  }
  const elapsedMs = performance.now() - began;
  assert.ok(elapsedMs >= API_KEY_VALIDATION_DEADLINE_MS - 1000 &&
    elapsedMs < API_KEY_VALIDATION_DEADLINE_MS + 5000, "validation deadline exceeded");
  assert.equal(requests, 21, "one request per validation; no retries or redirects");
  assert.equal(scenarios.length, 0);
  assert.equal(logs.some((line) => line.includes(key)), false, "key leaked in validation logs");
  assert.equal(globalThis.__package1Outbound.blocked, 0);
  console.log(`key17 transport: 21 loopback metadata requests; errors, byte cap, redirect rejection, redaction, 20s deadlines, direct transport settlement and 7 active-response cancellations passed; forced GC=${Boolean(gcTimer)}; real outbound=0`);
} finally {
  clearTimeout(watchdog);
  clearInterval(gcTimer);
  https.request = originalRequest;
  syncBuiltinESMExports();
  console.error = originalError;
  console.warn = originalWarn;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
