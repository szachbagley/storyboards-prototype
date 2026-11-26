// Runs inside the loopback-only authenticated continuity app fixture.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const token = ids => createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
const confirm = ids => "?confirmContinuity=true&referenceSetToken=" + token(ids);
const output = id => `generations/${id}.jpg`;
const copy = id => `generations/${id}/continuity.jpg`;

export async function verifyDeletion({ db, state, request, a, b, call, frame, patch, generate,
  gate, waitFor, source, target, raceTarget, snapshot, accepted, failed, recorded, generationId,
  replacement, injectCommitFault }) {
  state.attemptedDeletes = [];
  const del = (f, query, code) => call("DELETE", "/frames/" + f.id + query, undefined, code);
  const checkWarning = (response, ids) => {
    const n = ids.length;
    assert.equal(response.error.code, "continuity_source_in_use");
    assert.deepEqual(response.error.details, { referencedByCount: n, referenceSetToken: token(ids) });
    assert.ok(response.error.message.includes("Already accepted generation work may still finish or be billed."));
  };
  const assertDeletes = (keys) => assert.deepEqual(state.attemptedDeletes.splice(0).sort(), keys.sort());
  const inventory = () => [...state.objects.entries()].sort(([a], [b]) => a.localeCompare(b));
  const pointer = async f => (await db.query(
    "SELECT continuity_source_frame_id, updated_at::text FROM frames WHERE id=$1", [f.id])).rows[0];

  const dependents = [target.id, raceTarget.id];
  const initialInventory = inventory();
  for (const query of ["", "?confirmContinuity=true", "?referenceSetToken=" + token(dependents),
    confirm(dependents)]) {
    const result = await request("DELETE", "/frames/" + source.id + query, b.token, undefined, 404);
    assert.equal(result.error.code, "not_found");
    assert.equal(result.error.details, undefined);
    await request("DELETE", "/frames/" + source.id + query, null, undefined, 401);
  }
  for (const query of ["?confirmContinuity=false", "?confirmContinuity=1",
    "?unexpected=ignored", "?confirmContinuity=true&confirmContinuity=true",
    "?referenceSetToken=short", "?referenceSetToken=" + "A".repeat(64)]) {
    assert.equal((await del(source, query, 400)).error.code, "invalid_input");
  }
  for (const query of ["", "?confirmContinuity=true", "?referenceSetToken=" + token(dependents),
    confirm([])]) checkWarning(await del(source, query, 409), dependents);
  assert.deepEqual(inventory(), initialInventory);
  assertDeletes([]);
  for (const f of [target, raceTarget]) assert.equal((await pointer(f)).continuity_source_frame_id, source.id);

  const swapped = await frame("swapped dependent");
  await patch(raceTarget, { continuitySourceFrameId: null });
  await patch(swapped, { continuitySourceFrameId: source.id });
  const updated = [target.id, swapped.id];
  checkWarning(await del(source, confirm(dependents), 409), updated);
  await patch(target, { continuitySourceFrameId: null });
  await patch(swapped, { continuitySourceFrameId: null });
  checkWarning(await del(source, confirm(updated), 409), []);
  assertDeletes([]);
  await patch(target, { continuitySourceFrameId: source.id });

  // Hold a real output after PUT while deleting the accepted consuming target.
  const late = await frame("deleted after output put");
  await patch(late, { continuitySourceFrameId: source.id });
  const barrier = gate();
  state.outputGate = barrier.promise;
  const { generationId: lateId } = await generate(late, { requestId: randomUUID() });
  try {
    await waitFor(() => state.objects.has(output(lateId)));
    await del(late, "", 204);
    assertDeletes([copy(lateId)]);
  } finally {
    state.outputGate = null;
    barrier.release();
  }
  await waitFor(() => !state.objects.has(output(lateId)));
  assertDeletes([output(lateId)]);
  assert.equal((await db.query("SELECT id FROM generations WHERE id=$1", [lateId])).rowCount, 0);

  // Queue the first HTTP request at an independently-held story row. Observe both
  // waiters in PostgreSQL before releasing it; no timing-based ordering guesses.
  async function ordered(first, second) {
    await db.query("BEGIN");
    const { rows: [{ pid }] } = await db.query("SELECT pg_backend_pid() AS pid");
    const storyId = (await db.query("SELECT story_id FROM frames WHERE id=$1", [target.id])).rows[0].story_id;
    await db.query("SELECT id FROM stories WHERE id=$1 FOR UPDATE", [storyId]);
    const waiters = async n => {
      await db.query("SELECT pg_stat_clear_snapshot()");
      const result = await db.query(`WITH RECURSIVE waiting(pid) AS (
        SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w
        ON w.pid = ANY(pg_blocking_pids(a.pid)) WHERE a.datname = current_database()
      ) SELECT count(*)::int AS n FROM waiting`, [pid]);
      return result.rows[0].n === n + 1;
    };
    const pending = [];
    try {
      pending.push(first());
      await waitFor(() => waiters(1));
      pending.push(second());
      await waitFor(() => waiters(2));
    } finally {
      await db.query("ROLLBACK");
      await Promise.allSettled(pending);
    }
    return Promise.all(pending);
  }
  const attachFirst = await frame("attach wins"), deleteFirst = await frame("delete wins");
  const [, denied] = await ordered(() => patch(swapped, { continuitySourceFrameId: attachFirst.id }),
    () => del(attachFirst, "", 409));
  checkWarning(denied, [swapped.id]);
  const [, invalid] = await ordered(() => del(deleteFirst, "", 204),
    () => patch(swapped, { continuitySourceFrameId: deleteFirst.id }, 422));
  assert.equal(invalid.error.code, "invalid_continuity_source");
  assert.equal((await pointer(swapped)).continuity_source_frame_id, attachFirst.id);
  assertDeletes([]);

  // Use the genuine accepted snapshot as a template for historical fixtures.
  async function seed(f, phase, makeSnapshot) {
    const id = randomUUID();
    const own = structuredClone(snapshot);
    own.continuity.imageKey = copy(id);
    await db.query(`INSERT INTO generations(id,frame_id,model,status,image_key,compiled_prompt,input_snapshot)
      VALUES($1,$2,'fixture',$3,$4,'',$5)`, [id, f.id, phase, phase === "succeeded" ? output(id) : null,
      makeSnapshot ? makeSnapshot(own) : own]);
    if (phase === "succeeded") state.objects.set(output(id), Buffer.from("fixture output"));
    return id;
  }
  // Source deletion during either side of the preflight GET has different outcomes.
  for (const alreadyRead of [false, true]) {
    const tempSource = await frame("source disappearing during preflight");
    const consumer = await frame("preflight consumer");
    const image = await seed(tempSource, "succeeded", () => ({}));
    state.objects.set(output(image), Buffer.from(state.objects.get(output(replacement))));
    await call("POST", "/frames/" + tempSource.id + "/select-generation", { generationId: image }, 200);
    await patch(consumer, { continuitySourceFrameId: tempSource.id });
    const hold = gate();
    const before = { ...state.calls };
    const gateName = alreadyRead ? "copyGate" : "getGate";
    state[gateName] = hold.promise;
    const pending = generate(consumer, { requestId: randomUUID() }, alreadyRead ? 202 : 422);
    try {
      await waitFor(() => alreadyRead ? state.calls.put > before.put : state.calls.get > before.get);
      await del(tempSource, confirm([consumer.id]), 204);
      assertDeletes([output(image)]);
    } finally {
      hold.release();
      state[gateName] = null;
    }
    const result = await pending;
    if (alreadyRead) {
      await waitFor(async () => (await db.query("SELECT status FROM generations WHERE id=$1",
        [result.generationId])).rows[0]?.status === "succeeded");
      assert.ok(state.objects.has(copy(result.generationId)));
      assert.equal(state.calls.generate, before.generate + 1);
    } else {
      assert.equal(result.error.code, "continuity_image_missing");
      assert.equal(state.calls.generate, before.generate);
      assert.equal((await db.query("SELECT id FROM generations WHERE frame_id=$1", [consumer.id])).rowCount, 0);
    }
  }
  const ownCopy = await seed(source, "failed");
  state.objects.set(copy(ownCopy), Buffer.from("source-owned copy"));
  const malicious = await seed(source, "succeeded", s => {
    s.continuity.imageKey = copy(accepted);
    return s;
  });
  const malformed = await seed(source, "failed", s => ({ ...s, compilerVersion: "bad" }));
  const legacy = await seed(source, "failed", s => ({ frameDescription: "legacy", aspectRatio: s.aspectRatio,
    imageSize: s.imageSize, concepts: [], continuity: s.continuity }));
  for (const id of [malformed, legacy]) state.objects.set(copy(id), Buffer.from("unattributable"));
  const prior = inventory();
  const ownKeys = [output(generationId), output(replacement), output(malicious), copy(ownCopy)];
  const beforeClear = await pointer(target);
  const dispatchCount = state.calls.generate;
  injectCommitFault("before");
  await del(source, confirm([target.id]), 500);
  assert.deepEqual(await pointer(target), beforeClear);
  assert.deepEqual(inventory(), prior);
  assertDeletes([]);
  await del(source, confirm([target.id]), 204);
  assertDeletes([...ownKeys]);
  assert.deepEqual(inventory(), prior.filter(([key]) => !ownKeys.includes(key)));
  const afterClear = await pointer(target);
  assert.equal(afterClear.continuity_source_frame_id, null);
  assert.notEqual(afterClear.updated_at, beforeClear.updated_at);
  assert.equal(state.calls.generate, dispatchCount);
  for (const id of [accepted, failed, recorded]) assert.ok(state.objects.has(copy(id)));

  const story = await call("POST", "/stories", { title: "retained input inventory" }, 201);
  const direct = await frame("delete frame", story), cascade = await frame("delete story", story);
  for (const [f, methodPath] of [[direct, "/frames/" + direct.id], [cascade, "/stories/" + story.id]]) {
    const keys = [];
    for (const phase of ["succeeded", "pending", "failed"]) {
      const id = await seed(f, phase);
      state.objects.set(copy(id), Buffer.from("retained input"));
      keys.push(copy(id));
      if (phase === "succeeded") keys.push(output(id));
    }
    const prior = inventory();
    const orphan = f === cascade ? keys.at(-1) : undefined;
    state.deleteFailureKey = orphan;
    await request("DELETE", methodPath, b.token, undefined, 404);
    assertDeletes([]);
    await call("DELETE", methodPath, undefined, 204);
    assertDeletes([...keys]);
    assert.deepEqual(inventory(), prior.filter(([key]) => !keys.includes(key) || key === orphan));
    assert.equal(await pointer(f), undefined);
    assert.equal((await db.query("SELECT id FROM generations WHERE frame_id=$1", [f.id])).rowCount, 0);
    state.deleteFailureKey = undefined;
  }
  console.log("deletion HTTP/SQL: both story-lock orders observed; changed/empty fingerprints re-prompted; confirmed pointer/timestamp and source/target/story object inventories verified, including one injected private orphan and late output cleanup");
}
