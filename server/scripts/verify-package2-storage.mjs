// Run with the hard outbound guard preloaded. No app, DB, bucket or Gemini key.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { getEventListeners } from "node:events";
import { Readable } from "node:stream";
import sharp from "sharp";

if (!globalThis.__package1Outbound) throw new Error("offline network guard must be preloaded");
process.env.AWS_ACCESS_KEY_ID = "fixture";
process.env.AWS_SECRET_ACCESS_KEY = "fixture";
process.env.AWS_REGION = "us-east-1";
process.env.S3_BUCKET = "fixture";
process.env.DATABASE_URL = "postgres://fixture@127.0.0.1/fixture";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const objects = new Map();
const calls = [];
let fault = null;
let deleteFault = null;
let hangGet = false;
let hangPut = false;
let hangDelete = false;
let bodyMode = "normal";
let lastBody;
let expireOnPut;
globalThis.__package2S3 = {
  calls,
  async send(command, options) {
    const key = command.input.Key;
    if (fault?.kind === command.kind) {
      const current = fault;
      fault = null;
      if (current.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, current.delayMs);
      if (current.afterWrite) objects.set(key, Buffer.from(command.input.Body));
      throw current.error;
    }
    if (command.kind === "delete" && deleteFault) {
      const current = deleteFault;
      deleteFault = null;
      throw current;
    }
    if (command.kind === "delete" && hangDelete) {
      queueMicrotask(() => expireOnPut());
      return new Promise(() => {});
    }
    if (command.kind === "get") {
      if (hangGet) return new Promise(() => {});
      if (!objects.has(key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      if (bodyMode === "absent") return {};
      if (bodyMode === "stalled") {
        lastBody = new Readable({ read() {} });
        lastBody.transformToByteArray = async () => {
          const chunks = [];
          for await (const chunk of lastBody) chunks.push(chunk);
          return Buffer.concat(chunks);
        };
        return { Body: lastBody };
      }
      if (bodyMode === "failed") return { Body: { transformToByteArray: async () => {
        throw Object.assign(new Error("stream failed after headers"), { $metadata: { httpStatusCode: 404 } });
      } } };
      return { Body: { transformToByteArray: async () => objects.get(key) } };
    }
    if (command.kind === "put") {
      if (options?.abortSignal?.aborted) throw new Error("aborted");
      if (hangPut) {
        objects.set(key, Buffer.from(command.input.Body));
        queueMicrotask(() => expireOnPut());
        return new Promise(() => {});
      }
      if (command.input.IfNoneMatch === "*" && objects.has(key)) {
        throw Object.assign(new Error("already exists"), {
          name: "PreconditionFailed", $metadata: { httpStatusCode: 412 },
        });
      }
      objects.set(key, Buffer.from(command.input.Body));
      return {};
    }
    objects.delete(key);
    return {};
  },
};
const stubUrl = new URL("./package2-s3-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier === "@aws-sdk/client-s3" ||
         specifier === "@aws-sdk/s3-request-presigner") &&
        context.parentURL?.includes("/server/dist/services/s3.js")) {
      return { url: stubUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const s3 = await import("../dist/services/s3.js");
const preflight = await import("../dist/services/referencePreflight.js");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectCode = async (operation, code, status) => {
  await assert.rejects(operation, (error) => error.code === code && error.status === status);
};
const withBudget = (work) => preflight.withReferencePreflight(work);
const original = await sharp({ create: { width: 1400, height: 700, channels: 4,
  background: "#cc2211" } }).png().toBuffer();

// Existing mutable concept key/read/overwrite semantics stay intact.
const conceptKey = s3.conceptImageKey(randomUUID());
assert.match(conceptKey, /^concepts\/.+\/reference\.jpg$/);
await s3.putObject(conceptKey, Buffer.from("first"), "image/jpeg");
assert.equal((await s3.getObjectBytes(conceptKey)).toString(), "first");
await s3.putObject(conceptKey, Buffer.from("second"), "image/jpeg");
assert.equal((await s3.getObjectBytes(conceptKey)).toString(), "second");

const sourceKey = s3.generationImageKey(randomUUID());
objects.set(sourceKey, original);
const firstId = randomUUID(), secondId = randomUUID();
const first = await withBudget((budget) => preflight.stageContinuityCopy(firstId, sourceKey, budget));
const second = await withBudget((budget) => preflight.stageContinuityCopy(secondId, sourceKey, budget));
assert.equal(first.imageKey, s3.continuityImageKey(firstId));
assert.notEqual(first.imageKey, second.imageKey);
assert.equal(first.sourceImageSha256, digest(original));
assert.equal(first.imageSha256, digest(first.imageBytes));
assert.deepEqual(objects.get(first.imageKey), first.imageBytes);
assert.equal(first.imageMime, "image/jpeg");
assert.ok(calls.filter((call) => call.kind === "put" && call.key.includes("/continuity.jpg")).length === 2);
const metadata = await sharp(first.imageBytes).metadata();
assert.equal(metadata.format, "jpeg");
assert.equal(Math.max(metadata.width, metadata.height), 1024);
assert.equal(metadata.exif, undefined);
await expectCode(() => withBudget((budget) =>
  preflight.stageContinuityCopy(firstId, sourceKey, budget)), "reference_storage_unavailable", 503);
assert.deepEqual(objects.get(first.imageKey), first.imageBytes);
assert.ok(calls.filter((call) => call.kind === "get" && call.key === sourceKey)
  .every((call) => call.signal instanceof AbortSignal));
assert.ok(calls.filter((call) => call.kind === "put" && call.key.includes("/continuity.jpg"))
  .every((call) => call.signal instanceof AbortSignal));

for (const [error, code, status] of [
  [Object.assign(new Error("missing"), { name: "NoSuchKey" }), "continuity_image_missing", 422],
  [Object.assign(new Error("404"), { $metadata: { httpStatusCode: 404 } }), "continuity_image_missing", 422],
  [Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }), "reference_storage_unavailable", 503],
  [Object.assign(new Error("bucket"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } }), "reference_storage_unavailable", 503],
  [Object.assign(new Error("bucket"), { code: "NoSuchBucket", statusCode: 404 }), "reference_storage_unavailable", 503],
  [Object.assign(new Error("server"), { $metadata: { httpStatusCode: 503 } }), "reference_storage_unavailable", 503],
  [new Error("transport"), "reference_storage_unavailable", 503],
]) {
  fault = { kind: "get", error };
  await expectCode(() => withBudget((budget) =>
    preflight.stageContinuityCopy(randomUUID(), sourceKey, budget)), code, status);
}
fault = { kind: "get", error: Object.assign(new Error("404"), { $metadata: { httpStatusCode: 404 } }) };
await expectCode(() => withBudget((budget) =>
  preflight.readReferenceBytes(conceptKey, "concept", budget)), "reference_image_missing", 422);
fault = { kind: "get", error: Object.assign(new Error("403"), { $metadata: { httpStatusCode: 403 } }) };
await expectCode(() => withBudget((budget) =>
  preflight.readReferenceBytes(conceptKey, "concept", budget)), "reference_storage_unavailable", 503);
objects.set(sourceKey, Buffer.alloc(0));
await expectCode(() => withBudget((budget) =>
  preflight.stageContinuityCopy(randomUUID(), sourceKey, budget)), "continuity_image_invalid", 422);
objects.set(sourceKey, Buffer.from("corrupt source"));
await expectCode(() => withBudget((budget) =>
  preflight.stageContinuityCopy(randomUUID(), sourceKey, budget)), "continuity_image_invalid", 422);
objects.set(sourceKey, original);

// A PUT may write before returning failure, or fail before evaluating the
// condition against an existing copy. Neither outcome proves key ownership.
const failedId = randomUUID();
fault = { kind: "put", afterWrite: true, error: new Error("ambiguous PUT failure") };
await expectCode(() => withBudget((budget) =>
  preflight.stageContinuityCopy(failedId, sourceKey, budget)), "reference_storage_unavailable", 503);
assert.equal(objects.has(s3.continuityImageKey(failedId)), true);
assert.equal(objects.has(first.imageKey), true);
assert.equal(objects.has(second.imageKey), true);
assert.equal(objects.has(sourceKey), true);
fault = { kind: "put", error: Object.assign(new Error("service unavailable"), {
  $metadata: { httpStatusCode: 503 },
}) };
const deletesBeforeConflict = calls.filter((call) => call.kind === "delete").length;
await expectCode(() => withBudget((budget) =>
  preflight.stageContinuityCopy(secondId, sourceKey, budget)), "reference_storage_unavailable", 503);
assert.deepEqual(objects.get(second.imageKey), second.imageBytes);
assert.equal(calls.filter((call) => call.kind === "delete").length, deletesBeforeConflict);

// An acknowledged copy of a known-uncommitted candidate can be removed;
// cleanup failure leaves just that candidate's documented orphan.
deleteFault = new Error("failed cleanup");
await assert.rejects(() => preflight.cleanupKnownUncommittedContinuityCopy(firstId), /failed cleanup/);
assert.equal(objects.has(first.imageKey), true);
assert.equal(objects.has(second.imageKey), true);
await preflight.cleanupKnownUncommittedContinuityCopy(firstId);
assert.equal(objects.has(first.imageKey), false);
assert.equal(objects.has(second.imageKey), true);
await assert.rejects(() => preflight.cleanupKnownUncommittedContinuityCopy("../other"));

const beforeFanout = calls.length;
await expectCode(() => withBudget((budget) =>
  preflight.readConceptReferenceBytes(Array(11).fill(conceptKey), budget)), "too_many_concepts", 422);
assert.equal(calls.length, beforeFanout);
const ten = await withBudget((budget) =>
  preflight.readConceptReferenceBytes(Array(10).fill(conceptKey), budget));
assert.equal(ten.length, 10);
assert.ok(ten.every((bytes) => bytes.toString() === "second"));
const beforeNulls = calls.length;
assert.deepEqual(await withBudget((budget) => preflight.readConceptReferenceBytes([null, null], budget)), [null, null]);
assert.equal(calls.length, beforeNulls);
await expectCode(() => withBudget((budget) => Promise.all(Array.from({ length: 11 }, () =>
  preflight.readReferenceBytes(conceptKey, "concept", budget)))), "too_many_concepts", 422);
assert.equal(calls.length, beforeNulls + 10);
await withBudget(async (budget) => {
  await preflight.readConceptReferenceBytes(Array(9).fill(conceptKey), budget);
  await preflight.stageContinuityCopy(randomUUID(), sourceKey, budget);
});
await expectCode(() => withBudget(async (budget) => {
  await preflight.readConceptReferenceBytes(Array(10).fill(conceptKey), budget);
  await preflight.stageContinuityCopy(randomUUID(), sourceKey, budget);
}), "too_many_concepts", 422);

// The timer and abort listener must be removed after success and failure.
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const activeTimers = new Set();
globalThis.setTimeout = function (handler, delay, ...args) {
  expireOnPut = handler;
  const timer = originalSetTimeout(handler, delay, ...args);
  activeTimers.add(timer);
  return timer;
};
globalThis.clearTimeout = function (timer) {
  activeTimers.delete(timer);
  return originalClearTimeout(timer);
};
try {
  await preflight.withReferencePreflight(async () => "ok", 20);
  await expectCode(() => preflight.withReferencePreflight(() => new Promise(() => {}), 20),
    "reference_storage_unavailable", 503);
  hangGet = true;
  await expectCode(() => preflight.withReferencePreflight((budget) =>
    preflight.readReferenceBytes(sourceKey, "continuity", budget), 20),
  "reference_storage_unavailable", 503);
  hangGet = false;
  const timedOutId = randomUUID();
  hangPut = true;
  await expectCode(() => preflight.withReferencePreflight((budget) =>
    preflight.stageContinuityCopy(timedOutId, sourceKey, budget)),
  "reference_storage_unavailable", 503);
  hangPut = false;
  assert.equal(objects.has(s3.continuityImageKey(timedOutId)), true);
  hangDelete = true;
  await expectCode(() => preflight.cleanupKnownUncommittedContinuityCopy(secondId),
    "reference_storage_unavailable", 503);
  hangDelete = false;
  assert.equal(objects.has(second.imageKey), true);
  assert.equal(activeTimers.size, 0);
} finally {
  hangGet = false;
  hangPut = false;
  hangDelete = false;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
assert.equal(globalThis.__package1Outbound.blocked, 0);
// A blocked event loop must not let an expired budget start a storage read.
const beforeExpiredRead = calls.length;
await expectCode(() => preflight.withReferencePreflight(async (budget) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  return preflight.readReferenceBytes(sourceKey, "continuity", budget);
}, 10), "reference_storage_unavailable", 503);
assert.equal(calls.length, beforeExpiredRead);

// The same absolute deadline also applies after a successful earlier read.
const beforeSharedRead = calls.length;
await expectCode(() => preflight.withReferencePreflight(async (budget) => {
  await preflight.readReferenceBytes(sourceKey, "continuity", budget);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  return preflight.readReferenceBytes(sourceKey, "continuity", budget);
}, 10), "reference_storage_unavailable", 503);
assert.equal(calls.length, beforeSharedRead + 1);
fault = { kind: "get", delayMs: 40, error: Object.assign(new Error("late 404"), {
  $metadata: { httpStatusCode: 404 },
}) };
await expectCode(() => preflight.withReferencePreflight((budget) =>
  preflight.readReferenceBytes(sourceKey, "continuity", budget), 10), "reference_storage_unavailable", 503);

let closedBudget;
await withBudget(async (budget) => { closedBudget = budget; });
let startedAfterClose = false;
await expectCode(() => closedBudget.wait(() => {
  startedAfterClose = true;
  return Promise.reject(new Error("must not start"));
}), "reference_storage_unavailable", 503);
assert.equal(startedAfterClose, false);

bodyMode = "absent";
await expectCode(() => withBudget((budget) =>
  preflight.readReferenceBytes(sourceKey, "continuity", budget)), "continuity_image_invalid", 422);
bodyMode = "failed";
await expectCode(() => withBudget((budget) =>
  preflight.readReferenceBytes(sourceKey, "continuity", budget)), "reference_storage_unavailable", 503);
bodyMode = "stalled";
await expectCode(() => preflight.withReferencePreflight((budget) =>
  preflight.readReferenceBytes(sourceKey, "continuity", budget), 20), "reference_storage_unavailable", 503);
assert.equal(lastBody.destroyed, true);
bodyMode = "normal";
await new Promise((resolve) => setImmediate(resolve));
for (const signal of new Set(calls.map((call) => call.signal).filter(Boolean))) {
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(signal, "abort").length, 0);
}
assert.equal(globalThis.__package1Outbound.blocked, 0);
console.log(`package2 storage: concept overwrite, distinct copies/hashes/JPEG, missing/unavailable/invalid, candidate cleanup, ten-fanout, deadline/timers passed; real outbound=0; S3 stub calls=${calls.length}`);
