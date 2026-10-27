// Exercise the installed SDK and real validator using only loopback HTTP.
// Run after build, with --import ./server/scripts/offline-network-guard.mjs.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { GoogleGenAI } from "@google/genai";
import { API_KEY_VALIDATION_DEADLINE_MS } from "@storyboards/shared";

if (!globalThis.__package1Outbound) throw new Error("offline guard was not preloaded");
const interactionsPrototype = Object.getPrototypeOf(new GoogleGenAI({ apiKey: "fixture-sdk-setup", vertexai: false }).interactions);
const originalCreate = interactionsPrototype.create;
const originalError = console.error;
const logs = [];
const key = "fixture-secret-sentinel";
const scenarios = [];
let requests = 0;
let phase = "setup";
let cancelled = 0;
const closed = [];
const server = http.createServer((request, response) => {
  request.resume();
  requests += 1;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1beta/interactions");
  assert.equal(request.headers["x-goog-api-key"], key);
  const scenario = scenarios.shift();
  assert.ok(scenario, "unexpected SDK retry/request");
  if (scenario.stall) {
    response.once("close", () => { cancelled += 1; });
    closed.push(once(response, "close"));
    if (scenario.stall === "headers") return;
    response.writeHead(scenario.status, { "Content-Type": "application/json" });
    response.write("{");
    return;
  }
  response.writeHead(scenario.status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(scenario.body));
});
const watchdog = setTimeout(() => {
  throw new Error(`key17 SDK fixture exceeded 30 seconds: phase=${phase}, requests=${requests}, cancelled=${cancelled}`);
}, 30_000);
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Change only the SDK's destination using its supported request option.
  // Keep actual serialization, transport, errors, and abort handling intact;
  // the preloaded fetch/socket guard rejects any unintended remote call.
  interactionsPrototype.create = function (request, options) {
    assert.equal(options.timeout, API_KEY_VALIDATION_DEADLINE_MS);
    assert.equal(options.maxRetries, 0);
    return originalCreate.call(this, request, { ...options, defaultBaseURL: origin });
  };
  console.error = (...args) => logs.push(args.map(String).join(" "));
  const { validateApiKey } = await import("../dist/services/gemini.js");
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
    [503, "UNAVAILABLE", { status: 502, code: "upstream_error" }],
    [504, "DEADLINE_EXCEEDED", { status: 504, code: "timeout" }],
  ]) {
    assert.deepEqual(await call({ status, body: errorBody(status, reason) }), expected);
  }
  assert.equal(await call({ status: 200, body: { id: "fixture", status: "completed", steps: [] } }), true);
  assert.deepEqual(await call({ status: 200, body: { id: "fixture", status: "failed", steps: [] } }),
    { status: 502, code: "upstream_error" });

  // Concurrent stalls share no state except the fixture queue. Each uses the
  // unchanged production 20s timeout; no clock/SDK mock can mask cancellation.
  const began = performance.now();
  phase = "timeout matrix";
  const results = await Promise.all([
    call({ stall: "headers", status: 200 }),
    call({ stall: "body", status: 200 }),
    call({ stall: "body", status: 400 }),
  ]);
  assert.deepEqual(results, Array(3).fill({ status: 504, code: "timeout" }));
  phase = "socket cancellation";
  await Promise.all(closed);
  const elapsedMs = performance.now() - began;
  assert.ok(elapsedMs >= API_KEY_VALIDATION_DEADLINE_MS - 1000 &&
    elapsedMs < API_KEY_VALIDATION_DEADLINE_MS + 5000, "validation deadline exceeded");
  assert.equal(requests, 13, "one request per validation; no hidden retries");
  assert.equal(scenarios.length, 0);
  assert.equal(logs.some((line) => line.includes(key)), false, "key leaked in validation logs");
  assert.equal(globalThis.__package1Outbound.blocked, 0);
  console.log("key17 SDK: 13 loopback requests; structured errors, empty-text success, redaction, 20s header/body timeouts and socket cancellation passed; real outbound=0");
} finally {
  clearTimeout(watchdog);
  interactionsPrototype.create = originalCreate;
  console.error = originalError;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
