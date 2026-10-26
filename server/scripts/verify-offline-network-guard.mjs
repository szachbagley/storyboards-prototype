// No real transport is available even if the guard regresses. Exercise the
// Node call shapes and the actual SDK entry points over these inert backstops.
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";

let socketsReached = 0;
let fetchesReached = 0;
net.Socket.prototype.connect = function () {
  socketsReached += 1;
  throw new Error("inert socket backstop");
};
globalThis.fetch = async () => {
  fetchesReached += 1;
  throw new Error("inert fetch backstop");
};
await import("./offline-network-guard.mjs");
const denied = /offline fixture blocked/;
const host = "generativelanguage.googleapis.com";
assert.throws(() => new net.Socket().connect({ host, port: 443 }), denied);
assert.throws(() => new net.Socket().connect(443, host), denied);
assert.throws(() => net.connect({ host, port: 443 }), denied);
assert.throws(() => net.connect(443, host), denied);
assert.throws(() => tls.connect({ host, port: 443 }), denied);
await assert.rejects(new Promise((resolve, reject) => {
  try {
    https.get(`https://${host}/`).on("error", reject).on("response", resolve);
  } catch (error) { reject(error); }
}), denied);
assert.throws(() => fetch(`https://${host}/`), denied);
assert.equal(socketsReached, 0);
assert.equal(fetchesReached, 0);

// These imports are intentionally not redirected to package1-stubs.mjs.
const { generateImage, describeImage, validateApiKey } = await import("../dist/services/gemini.js");
const errorsBefore = globalThis.__package1Outbound.blocked;
const originalError = console.error;
console.error = () => {}; // Expected SDK failure paths; print only counters.
try {
  await assert.rejects(() => validateApiKey("fixture-dummy-key"));
  await assert.rejects(() => describeImage({
    apiKey: "fixture-dummy-key", base64: "Zml4dHVyZQ==", mimeType: "image/jpeg", prompt: "fixture",
  }));
  await assert.rejects(() => generateImage("fixture-dummy-key", [{ type: "text", text: "fixture" }]));
} finally {
  console.error = originalError;
}
assert.equal(globalThis.__package1Outbound.blocked - errorsBefore, 3);
assert.equal(socketsReached, 0);
assert.equal(fetchesReached, 0);
// Loopback remains usable. The inert transport throws after the guard permits
// it, so these checks also need no server or database.
assert.throws(() => net.connect({ host: "127.0.0.1", port: 5432 }), /inert socket/);
assert.throws(() => net.connect(5432), /inert socket/);
await assert.rejects(() => fetch("http://127.0.0.1:3001/"), /inert fetch/);
console.log("guard: TCP/TLS/HTTPS/fetch denied external targets; validation/describe/generation intercepted; real transports=0");
