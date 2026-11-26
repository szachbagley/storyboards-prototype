// Invoked by the guarded app fixture with --continuity. Every HTTP request uses
// the normal authenticated router. Direct SQL seeds otherwise unreachable states.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

export async function verifyContinuity({ db, state, request, a, b, storyA, other,
  gate, waitFor, status, injectCommitFault }) {
  const call = (method, path, body, code) => request(method, path, a.token, body, code);
  const frame = (description, story = storyA) =>
    call("POST", `/stories/${story.id}/frames`, { description }, 201);
  const patch = (f, body, code = 200) => call("PATCH", `/frames/${f.id}`, body, code);
  const generate = (f, body, code = 202) => call("POST", `/frames/${f.id}/generate`, body, code);
  const poll = (id) => call("GET", `/generations/${id}`, undefined, 200);
  const count = async (f) => (await db.query(
    "SELECT count(*)::int AS n FROM generations WHERE frame_id = $1", [f.id])).rows[0].n;
  const copyKey = (id) => `generations/${id}/continuity.jpg`;
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const copies = () => [...state.objects.keys()].filter(k => k.endsWith("/continuity.jpg"));
  const target = await frame("First scene");
  const source = await frame("Source text should never be sent");
  const ownOther = await frame("separate", await call("POST", "/stories", { title: "separate" }, 201));
  for (const id of [target.id.toUpperCase(), other.id, ownOther.id, randomUUID()]) {
    assert.deepEqual((await patch(target, { continuitySourceFrameId: id }, 422)).error,
      { code: "invalid_continuity_source", message: "Choose another frame in this story." });
  }
  await patch(source, { continuitySourceFrameId: target.id });
  await patch(target, { continuitySourceFrameId: source.id.toUpperCase() });
  assert.equal((await patch(source, { position: 3000 })).continuityReferencedByCount, 1);
  const expected = { expectedContinuitySourceFrameId: source.id.toUpperCase() };
  const generationId = randomUUID();
  const key = `generations/${generationId}.jpg`;
  const before = { ...state.calls };
  assert.equal((await generate(target, { expectedContinuitySourceFrameId: null }, 409)).error.code,
    "continuity_configuration_changed");
  assert.equal((await generate(target, expected, 422)).error.code, "continuity_source_unusable");
  await db.query(`INSERT INTO generations (id, frame_id, model, compiled_prompt, input_snapshot)
    VALUES ($1, $2, 'fixture', '', $3)`, [generationId, source.id,
    { frameDescription: "source", aspectRatio: "16:9", imageSize: "1K", concepts: [] }]);
  await db.query("UPDATE frames SET selected_generation_id = $2 WHERE id = $1", [source.id, generationId]);
  for (const [status, readiness] of [["pending","pending"],["failed","failed"],["succeeded","invalid"]]) {
    await db.query("UPDATE generations SET status = $2 WHERE id = $1", [generationId, status]);
    assert.equal((await call("GET", `/frames/${source.id}`, undefined, 200)).selectedImageState, readiness);
    assert.equal((await generate(target, expected, 422)).error.code, "continuity_source_unusable");
  }
  assert.deepEqual(state.calls, before);
  assert.deepEqual((await poll(generationId)).continuity, { provenance: "legacy" });
  await db.query("UPDATE generations SET input_snapshot = '{}', image_key = $2 WHERE id = $1", [generationId,key]);
  assert.deepEqual((await poll(generationId)).continuity, { provenance: "unknown" });
  assert.equal((await generate(target, expected, 422)).error.code, "continuity_image_missing");
  state.readError = Object.assign(new Error("fixture denied"), { $metadata: { httpStatusCode: 403 } });
  assert.equal((await generate(target, expected, 503)).error.code, "reference_storage_unavailable");
  state.readError = null;
  state.objects.set(key, Buffer.from("corrupt"));
  assert.equal((await generate(target, expected, 422)).error.code, "continuity_image_invalid");
  const original = await sharp({ create: { width: 1500, height: 800, channels: 3, background: "red" } }).png().toBuffer();
  state.objects.set(key, original);
  state.putError = new Error("fixture lost acknowledgement");
  const orphanCount = copies().length;
  assert.equal((await generate(target, expected, 503)).error.code, "reference_storage_unavailable");
  state.putError = null;
  assert.equal(copies().length, orphanCount + 1);
  assert.equal(await count(target), 0);
  assert.equal(state.calls.generate, before.generate);

  // Final admission must recheck the target after storage, with no story lock
  // held while the PUT waits. It can remove only the losing candidate's copy.
  const doomed = await frame("deleted during preflight");
  await patch(doomed, { continuitySourceFrameId: source.id });
  const deleteGate = gate();
  state.copyGate = deleteGate.promise;
  const priorCopies = copies().sort();
  const doomedRequest = generate(doomed, expected, 404);
  await waitFor(() => copies().length === priorCopies.length + 1);
  await call("DELETE", `/frames/${doomed.id}`, undefined, 204);
  deleteGate.release();
  state.copyGate = null;
  await doomedRequest;
  assert.deepEqual(copies().sort(), priorCopies);
  assert.equal(state.calls.generate, before.generate);

  // Distinct tokens both pass the unlocked pending check. Hold the first
  // candidate at PUT so the other can win, then let the loser see pending.
  const raceTarget = await frame("competing requests");
  await patch(raceTarget, { continuitySourceFrameId: source.id });
  const slowCopy = gate(), runner = gate();
  state.copyGate = slowCopy.promise;
  state.gate = runner.promise;
  const raced = generate(raceTarget, { ...expected, requestId: randomUUID() }, 409);
  await waitFor(() => copies().length === priorCopies.length + 1);
  state.copyGate = null;
  const winner = await generate(raceTarget, { ...expected, requestId: randomUUID() });
  slowCopy.release();
  assert.equal((await raced).error.details.generationId, winner.generationId);
  assert.equal(await count(raceTarget), 1);
  assert.equal(state.calls.generate, before.generate + 1);
  assert.deepEqual(copies().sort(), [...priorCopies, copyKey(winner.generationId)].sort());
  runner.release();
  state.gate = null;
  await waitFor(async () => (await status(winner.generationId)).status === "succeeded");

  const firstToken = randomUUID();
  const copyHold = gate(), dispatchHold = gate();
  state.copyGate = copyHold.promise;
  state.gate = dispatchHold.promise;
  const callsBeforeRace = { ...state.calls };
  const pending = generate(target, { ...expected, requestId: firstToken });
  await waitFor(() => state.calls.put === callsBeforeRace.put + 1);
  const same = generate(target, { ...expected, requestId: firstToken });
  await waitFor(() => state.calls.put === callsBeforeRace.put + 2);
  const replacement = randomUUID();
  await db.query(`INSERT INTO generations (id, frame_id, model, status, image_key, compiled_prompt, input_snapshot)
    VALUES ($1, $2, 'fixture', 'succeeded', $3, '', '{}')`,
    [replacement, source.id, `generations/${replacement}.jpg`]);
  state.objects.set(`generations/${replacement}.jpg`, original);
  const reselected = await call("POST", `/frames/${source.id}/select-generation`,
    { generationId: replacement }, 200);
  assert.equal(reselected.selectedGenerationId, replacement);
  await patch(target, { description: "Later scene", continuitySourceFrameId: null });
  copyHold.release();
  state.copyGate = null;
  const [{ generationId: accepted }, replay] = await Promise.all([pending, same]);
  assert.equal(replay.generationId, accepted);
  assert.equal(state.calls.generate, callsBeforeRace.generate + 1);
  assert.equal(state.calls.delete, callsBeforeRace.delete + 1);
  const snapshot = (await status(accepted)).input_snapshot;
  assert.equal(snapshot.frameDescription, "First scene");
  assert.equal(snapshot.continuity.sourceGenerationId, generationId);
  assert.equal(snapshot.continuity.imageKey, copyKey(accepted));
  assert.equal(snapshot.continuity.sourceImageSha256, hash(original));
  assert.equal(snapshot.continuity.imageSha256, hash(state.objects.get(copyKey(accepted))));
  assert.equal(state.lastParts.at(-1).data, state.objects.get(copyKey(accepted)).toString("base64"));
  assert.ok(!state.lastParts[0].text.includes(source.description));
  assert.equal((await generate(target, { requestId: randomUUID() }, 409)).error.details.generationId, accepted);
  dispatchHold.release();
  state.gate = null;
  await waitFor(async () => (await status(accepted)).status === "succeeded");
  const unchanged = { ...state.calls };
  const lookup = `/frames/${target.id}/generation-requests/`;
  await request("GET", lookup + firstToken, b.token, undefined, 404);
  await call("GET", lookup + randomUUID(), undefined, 404);
  assert.equal((await call("GET", lookup + firstToken, undefined, 200)).generationId, accepted);
  assert.equal((await generate(target, { ...expected, requestId: firstToken })).generationId, accepted);
  assert.deepEqual(unchanged, state.calls);
  await db.query("UPDATE frames SET selected_generation_id = $1 WHERE id = $2", [accepted, source.id]);
  assert.equal((await call("GET", `/frames/${source.id}`, undefined, 200)).selectedImageState, "invalid");
  await patch(target, { continuitySourceFrameId: source.id });
  const beforeCorrupt = { ...state.calls };
  assert.equal((await generate(target, expected, 422)).error.code, "continuity_source_unusable");
  assert.deepEqual(beforeCorrupt, state.calls);
  await call("POST", `/frames/${source.id}/select-generation`, { generationId: replacement }, 200);

  assert.equal(await count(target), 1);

  await patch(target, { continuitySourceFrameId: source.id });
  state.nextGenerationError = Object.assign(new Error("fixture failure"), { status: 401 });
  const { generationId: failed } = await generate(target, expected);
  await waitFor(async () => (await status(failed)).status === "failed");
  assert.ok(state.objects.has(copyKey(failed)));
  const dispatches = state.calls.generate;
  const beforeFaultRows = await count(target);
  for (const fault of ["before", "unresolved"]) {
    const prior = copies().sort();
    const { put, delete: deletes } = state.calls;
    injectCommitFault(fault);
    const response = await generate(target, { ...expected, requestId: randomUUID() }, 503);
    assert.equal(response.error.code, "admission_uncertain");
    assert.equal(await count(target), beforeFaultRows);
    assert.equal(state.calls.generate, dispatches);
    assert.equal(state.calls.put, put + 1);
    assert.equal(state.calls.delete, deletes + (fault === "before" ? 1 : 0));
    assert.deepEqual(copies().filter(k => prior.includes(k)).sort(), prior);
    assert.equal(copies().length, prior.length + (fault === "unresolved" ? 1 : 0));
  }
  injectCommitFault("after");
  const lostToken = randomUUID();
  const uncertain = await generate(target, { ...expected, requestId: lostToken }, 503);
  assert.equal(uncertain.error.code, "admission_uncertain");
  const recorded = uncertain.error.details.generationId;
  assert.equal((await status(recorded)).status, "pending");
  assert.ok(state.objects.has(copyKey(recorded)));
  assert.equal((await generate(target, { ...expected, requestId: lostToken })).generationId, recorded);
  assert.equal(state.calls.generate, dispatches);
  console.log("continuity admission: proven rollback cleaned only its candidate; unresolved and committed copies preserved; no dispatch on recovery/replay");
  const { verifyDeletion } = await import("./verify-deletion-cases.mjs");
  await verifyDeletion({ db, state, request, a, b, call, frame, patch, generate, gate, waitFor,
    source, target, raceTarget, snapshot, accepted, failed, recorded, generationId, replacement, injectCommitFault });
  const detail = await call("GET", `/frames/${target.id}`, undefined, 200);
  assert.equal(detail.continuitySourceFrameId, null);
  for (const id of [accepted, failed]) {
    assert.ok(state.objects.has(copyKey(id)));
    const provenance = { provenance: "known", source: { frameId: source.id,
      generationId: id === accepted ? generationId : replacement, sourceFrameDeleted: true } };
    assert.deepEqual((await poll(id)).continuity, provenance);
    assert.deepEqual(detail.generations.find(g => g.id === id).continuity, provenance);
  }
  console.log("continuity HTTP: ownership, eligibility, frozen source, races, uncertain commits, failed-attempt retention and deleted-source provenance passed");
}
