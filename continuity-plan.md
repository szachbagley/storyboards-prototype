# Explicit Frame Continuity Plan

**Status:** implementation planning; independent review incorporated; retention recommendation requires review
**Written:** 2026-10-20
**Baseline:** `a6abd515f24db30123fcaa4164c1557cce333ae4`
**Planning branch:** `feat/explicit-frame-continuity-plan`
**Depends on:** existing identity, compiler, asynchronous generation, S3, and editor flows
**Authority:** user-approved continuity defaults; this document authorizes no application implementation, paid calls, migration, merge, or deployment

---

## 1. Outcome, scope, and decisions

A frame may explicitly reference one other frame in its story. At generation start the server resolves that source frame's **selected succeeded generation**, freezes its image, and uses it as one visual reference alongside the target's concepts. New scene instructions override source details; unspecified details continue from the source. Existing outputs remain selectable. Changing a source never silently regenerates another frame.

The implementation remains this prototype: React state and fetch, routes → services → parameterized PostgreSQL queries, one server process firing an asynchronous call, and private S3 objects. No Atelier continuity graph, asset registry, workflow engine, queue, Redis, worker, automatic propagation, or `previous_interaction_id` chaining.

### 1.1 Approved behavior

| Decision | Contract |
|---|---|
| Source resolution | Resolve the selected image at this attempt's start; changing selection later never changes its input. |
| Precedence | Explicit target scene instructions override source details; source preserves unspecified scene/visual details. The concept/source precedence recommendation is specified in §5. |
| Eligibility | Any other frame in the same story, including later frames. Exactly one source image; never recursively follow its own source. |
| Deletion | Warn before deleting a referenced source and explain consequences. Historical retention was **not** approved. See recommendation below. |
| Missing image | Reject before Gemini if no usable selected image; distinguish missing objects from storage outages. |
| Budget | Count attachments, including imageless concepts: at most nine concepts with continuity, ten without; character cap remains four. |
| Regeneration | Manual only; indicate when a historical generation used a different source selection than current configuration. |

### 1.2 Concrete planning recommendations requiring review

**Recommended retention policy: preserve one private, attempt-owned continuity image copy until its consuming target frame/story is deleted.** Source deletion clears live references and deletes the source's own output objects as today. It does not delete copies owned by surviving target generations. Keep copies for failed accepted generations too, because their inputs are diagnostic provenance. Do not copy references recursively or retain deleted target outputs globally.

This adds one small JPEG per accepted continuity attempt and makes source deletion safe after preflight. The deletion warning must explicitly say that existing outputs and their copied continuity inputs survive with the target. This is a new retention recommendation needing maintainer/user review before implementation reaches Ready, **not an approved user default**. If rejected, revise §§2, 4, 6 and 10 together; do not quietly ship metadata-only history under this contract. All other decisions below are implementation recommendations within the approved behavior; they still receive ordinary implementation review.

Recommended duplicate-request protection: nullable request UUID on generation rows, unique within a target frame, plus one pending generation per frame. New client sends UUIDs; legacy bodyless clients remain supported with a stated weaker guarantee (§4.4).

### 1.3 Required, prerequisite, and deferred work

**Required:** live source pointer, same-story/ownership checks, exact attempt snapshot, typed errors, compiler changes, immutable continuity input, budget display, source picker, deletion confirmation, historical mismatch indication, manual regeneration, compatibility and nonpaid verification.

**Prerequisite fixes:** serialize pending admission and enforce it in SQL; avoid terminal-state resurrection after sweep; preserve `invalid_api_key`; separate draft state from refreshed frame DTOs; fence navigation/poll responses; serialize editor saves.

**Deferred:** reproducible full historical replay, immutable/versioned concept upload keys and their cleanup policy, copying every concept image into every attempt, storage garbage-collection service, S3 bucket versioning rollout, distributed dispatch/recovery, billing guarantees, generation cancellation, per-frame optimistic revision/CAS across browser tabs, graph cycle validation, arbitrary uploaded continuity images, multiple continuity sources, model/style controls, prompt rewriting, automatic downstream invalidation/regeneration, and live visual tuning. A cycle A→B→A is legal: each request reads only the directly selected output and terminates.

## 2. Exact data model, migration, and compatibility

### 2.1 Live configuration and admission indexes

Use the next available migration, currently `server/migrations/003_frame_continuity.sql`. Do not edit `001_init.sql` or `002_identity.sql`. The runner wraps each file in a transaction; use ordinary indexes, not `CREATE INDEX CONCURRENTLY` inside that transaction.

```sql
-- Precondition: generation ingress is stopped and active work has drained.
-- Abort on duplicates. Never fail arbitrary pending rows to make this pass.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM generations WHERE status = 'pending'
    GROUP BY frame_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate pending generations; drain and investigate before migration';
  END IF;
END;
$$;

ALTER TABLE frames ADD COLUMN continuity_source_frame_id UUID;
ALTER TABLE frames ADD CONSTRAINT frames_continuity_not_self
  CHECK (continuity_source_frame_id IS NULL OR continuity_source_frame_id <> id);
ALTER TABLE frames ADD CONSTRAINT frames_continuity_source_fk
  FOREIGN KEY (continuity_source_frame_id) REFERENCES frames(id) ON DELETE SET NULL;
CREATE INDEX frames_continuity_source_idx ON frames (continuity_source_frame_id)
  WHERE continuity_source_frame_id IS NOT NULL;

ALTER TABLE generations ADD COLUMN request_id UUID;
CREATE UNIQUE INDEX generations_frame_request_uidx
  ON generations (frame_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX generations_one_pending_per_frame_uidx
  ON generations (frame_id) WHERE status = 'pending';
```

Keep the existing `generations_pending_idx(created_at)` for the sweeper. The new unique index serves admission, not its age predicate. No new enum values or foreign keys inside historical snapshots. `request_id` is server protocol metadata; never a credential.

Same-story ownership is a service/SQL boundary check, not claimed to follow from the single-column FK. Frames cannot move between stories in the existing API. Validate a source using a query joining target and source on `story_id` and owner, **inside the same short transaction as updating the pointer**, taking `FOR KEY SHARE` on the source through commit. Acquire the owned story row lock first, then the owned target (`FOR UPDATE`), then source `FOR KEY SHARE`; reject self explicitly before SQL. All related mutations follow the common lock protocol in §4.3 so legal cycles never invert source/target lock order. A foreign/missing/other-story source returns the same `422 invalid_continuity_source`; do not reveal where it exists. The target itself returns `404` when unowned/missing. If a source deletion races the FK, map that named FK violation to the same 422 and let the user refresh. Do not catch all constraint errors as that error.

Adding only a nullable pointer keeps all old frames unchanged. PATCH omitted field preserves value; explicit `null` clears; UUID replaces. No automatic previous-frame backfill. Existing generation snapshots remain byte-for-byte unchanged. Old `request_id` values remain null. No data wipe, concept relinking, image backfill, or invented source attribution.

### 2.2 Snapshot V2 (server-only provenance)

Replace new writes typed as `unknown` with an explicit server-side `GenerationInputSnapshotV2` interface. Parse historical JSON at a narrow read boundary; do not cast every old row into V2. No snapshot JSON, original S3 keys, copied S3 keys, base64, or API key is returned in ordinary DTOs.

```ts
interface GenerationInputSnapshotV2 {
  schemaVersion: 2;
  compilerVersion: "explicit-continuity-v1";
  capturedAt: string; // server timestamp for the atomic metadata read
  frameDescription: string; // authored, untrimmed
  aspectRatio: "16:9";
  imageSize: "1K";
  concepts: Array<{
    id: string; ord: number; name: string; type: ConceptType;
    description: string; imageKey: string | null;
    imageMime: string | null;
    imageSha256: string | null; // hash of actual bytes sent
  }>;
  continuity: null | {
    sourceFrameId: string;
    sourceGenerationId: string;
    sourcePosition: number; // context at capture, never a stable frame number
    sourceImageKey: string; // original source output, for diagnosis
    sourceImageSha256: string; // downloaded original bytes
    imageKey: string; // generations/{attemptId}/continuity.jpg
    imageMime: "image/jpeg";
    imageSha256: string; // actual preprocessed bytes supplied to compiler
  };
}
```

`generations.model` and `compiled_prompt` already store model and final text. `request_id` lives in its column, not duplicated in JSON. All hashes are SHA-256 hex; never log image bytes. Hashes prove which downloaded input was sent, not that S3 can always retrieve it later. Continuity copies retain actual input bytes under the recommendation; concepts are still metadata-only historical references after concept deletion. This is provenance, **not** an exact replay endpoint.

Legacy classification: absent `schemaVersion` means `legacy` with unknown continuity provenance. V2 `continuity: null` means known no-continuity. An unrecognized future version or malformed legacy record becomes `unknown`, without crashing the frame view. Do not interpret missing fields as proof that old output matched current settings.

### 2.3 Immutable keys and ownership

Existing generation output keys remain `generations/{generationId}.jpg` and are written once by one admitted runner. New continuity inputs use `generations/{generationId}/continuity.jpg`, also written once. Generate the candidate generation UUID before preflight; allow `insertPending` to accept it explicitly. Concurrent candidates always have distinct UUIDs, even when sharing a request UUID. A losing candidate may delete only its own preflight copy.

Concept upload behavior remains unchanged: `concepts/{conceptId}/reference.jpg` is overwritten in place, and concept deletion removes its current object. Capture/hash the actual concept buffers sent in each attempt; never describe their snapshot key as an immutable historical image. A concurrent replacement after metadata capture but before GET may supply replacement bytes under that key, while the captured description remains the earlier value. This existing concept-image/metadata coherence limitation is explicit; resolving it would require separately scoped versioned uploads/retention. Once buffers are loaded, later changes cannot alter the admitted attempt. The new continuity reference is stronger: selected generation outputs are append-only, frozen to an exact generation UUID and retained independently. Full replay for all concepts is deferred. Failed cleanup and crash-before-insert continuity copies can orphan objects; see §6.4.

### 2.4 Migration/backout procedure

Before applying: back up DB, record object prefixes without copying private contents into public evidence, stop generation ingress on the single server, drain admitted requests, and inspect the duplicate query above. A duplicate is a blocker requiring investigation/drain, not permission to discard live work. Check no paid work remains active before using the existing stale-sweep recovery for genuinely abandoned rows. Rehearse on a disposable database first. This plan does not run the migration.

Rollout order: additive DB → server with compatibility paths → client → documentation/acceptance evidence. No mixed old/new generation writers during migration/rollout. Old code can read additional columns, but cannot honor continuity or clean copies; therefore rollback generation ingress must remain paused until either the new server is restored or all live source pointers have been explicitly cleared and retained-object policy reconciled. Never serve a UI claiming continuity while old server ignores it. Prefer leaving additive columns/indexes and V2 snapshots in place during application rollback. A later separately reviewed down migration can drop the new indexes, constraints, and columns only after export/approval; it cannot reconstruct overwritten metadata or deleted S3 bytes. Do not decrement migration tracking rows as an improvised rollback.

## 3. API, ownership, and error contracts

### 3.1 Request and DTO changes

Extend shared `UpdateFrameSchema` with `continuitySourceFrameId: z.uuid().nullable().optional()`. Keep Zod malformed-body handling at the existing `400 invalid_input` boundary; semantic source validation is 422. Attachments remain uncapped on save; generation performs caps. No source field on create is needed: create starts with null, PATCH configures it.

`POST /frames/:id/generate` accepts an absent body or `{ requestId?: UUID, expectedContinuitySourceFrameId?: UUID | null }`, normalized with a shared `GenerateFrameSchema`. New client always sends a request UUID and its saved intended source UUID/null. Reject malformed UUIDs with 400. Successful first admission **and idempotent replay** return `202 { generationId }`; replay may identify an already terminal generation, which polling handles immediately. Return an existing owned generation for the same `(frameId,requestId)` before checking source expectations, resolving keys/images, or current caps. Add read-only `GET /frames/:id/generation-requests/:requestId`: validate both UUIDs, verify owned target, look up its request row, and return `200 { generationId }` or ordinary 404 without any preflight, key resolution, row insertion, or dispatch. This endpoint enables safe automatic recovery; GET never creates work. Editing inputs and reusing an accepted request UUID never creates new work.

The optional expected source is a narrow continuity-choice precondition, not a general frame revision/CAS system. At the atomic metadata capture, compare the configured source UUID/null to the provided expectation; mismatch returns `409 continuity_configuration_changed` before S3 or pending insertion. In particular, deleting source A between the final editor PATCH and capture must not silently turn a requested A-continuity attempt into a billed no-source attempt. Do not compare the source's selected generation to the thumbnail seen in the UI: the selected image is intentionally resolved fresh at capture. After successful capture, later source/link changes follow the frozen-input contract. Omitted expectation preserves legacy behavior and lacks this stale-choice protection; explicit null means the caller intends no continuity.

Add these additive safe fields:

```ts
// FrameSummaryDto/FrameDto, populated through owned story joins
continuitySourceFrameId: string | null;
continuitySourceSelectedGenerationId: string | null;
continuityReferencedByCount: number; // live incoming source pointers
selectedImageState: "ready" | "none" | "pending" | "failed" | "invalid";
// Server projects own selected generation membership/status/image-key readiness.
// "ready" does not assert S3 existence; preflight GET remains authoritative.

// GenerationSummaryDto, populated identically by frame history and polling
continuity: { provenance: "known"; source: null | {
  frameId: string; generationId: string; sourceFrameDeleted: boolean;
}} | { provenance: "legacy" | "unknown" };
```

The selected-generation field is nullable even when a source pointer exists. Candidate frames expose `selectedImageState`: none for no selection; pending/failed for that selected status; invalid for missing/cross-frame selected row or succeeded without image key; ready only for a succeeded selection belonging to that frame with a key. The UI can explain metadata readiness without claiming a fresh S3 existence check. List frame candidates using the already-owned story frame endpoint; show thumbnail, current derived “Frame N”, description excerpt, and “later frame” when appropriate. Exclude self. Show unusable candidates disabled with a reason but keep an already-selected newly unusable source visible. Server remains authoritative if UI state is stale.

Historical DTO projection uses only snapshot IDs plus an owned existence check scoped through the target story. Never fetch another user's frame just because its UUID appears in legacy JSON. Deleted labels say “Deleted source frame”; present frame numbers derive from current sorted story frames, never stored numbers. Prefer stable-ID fallback over inventing old ordinals. Add a `(position,id)` deterministic tie-breaker consistently to frame lists and source position labels because positions may tie.

### 3.2 Error table

All errors keep `{ error: { code, message, details? } }`; no raw S3/SDK errors or storage keys. Preflight errors create no pending row and make zero Gemini calls.

| Status/code | Meaning and recovery |
|---|---|
| 404 `not_found` | Target/generation not visible to this account. Existing ownership behavior. |
| 400 `invalid_input` | Invalid body/UUID per existing boundary conventions. |
| 422 `invalid_continuity_source` | Source missing, foreign, other story, or self; choose another source. Same public response for all inaccessible source cases. |
| 422 `continuity_source_unusable` | Visible configured source has no selected succeeded generation belonging to that source, or has no image key; generate/select a source image first. |
| 422 `continuity_image_missing` | GET of selected source returns authoritative `NoSuchKey`/404; choose/regenerate source. Do not silently fall back to no continuity. |
| 422 `continuity_image_invalid` | Object empty/unreadable; choose/regenerate source. Catch `preprocessReferenceImage`'s upload-oriented 400 and map locally. |
| 503 `reference_storage_unavailable` | S3 timeout, transport failure, 5xx, AccessDenied/403, or ambiguous failure; retry later. A 403 is not evidence of a missing image. |
| 422 existing cap/description errors | `too_many_characters`, `too_many_concepts`, `empty_frame_description`; give actual attachment count and effective allowance. |
| 409 `generation_in_progress` | A different request already has pending work; safe details `{ generationId }` of this owned target allow resume. |
| 409 `continuity_configuration_changed` | Configured source UUID/null differs from the submitted expectation at capture; refresh/review the choice, save, and submit explicitly. No pending row or paid call; do not automatically regenerate. |
| 409 `continuity_source_in_use` | Delete confirmation required; details `{ referencedByCount, referenceSetToken }`, no foreign IDs; exact dependent-set confirmation in §6. |

For concept reference GET failures, use 422 `reference_image_missing` vs 503 `reference_storage_unavailable`; imageless concepts (`image_key IS NULL`) remain legal text-only. Only authoritative absence maps to missing. Add a small S3 error discriminator in `s3.ts`; never classify storage errors through `classifyGeminiError`. A copied-image PUT failure is 503 and preflight cleanup, not a generation failure.

After admission, keep existing terminal generation error taxonomy and shared `GENERATION_ERROR_CODES` as one source of truth. Fix the local allowlist in `generation.ts`: `invalid_api_key` already exists in shared types and the classifier but is currently downgraded to `upstream_error`. No new storage preflight codes belong in terminal generation codes. Output S3 failure after billing remains `upstream_error` with server diagnostic and a clear saved-image failure message, never a promise that retry is unbilled.

## 4. Generation start, concurrency, and immutable inputs

### 4.1 Exact timing and capture

“Generation start” is **the successful single SQL statement that captures owned target metadata, ordered attached concept metadata, configured source, and its selected generation**. It occurs after a same-request replay lookup and before S3 reads. Use one statement/CTE with ordered JSON aggregation or a short `REPEATABLE READ` read transaction; prefer the single statement. Do not do independent default-isolation reads for target, concepts, source, and selection. Capture DB timestamp with that read. No transaction spans S3, image processing, or Gemini.

Source selection eligibility is stricter than the existing selected-generation FK: join selected `g.id = source.selected_generation_id AND g.frame_id = source.id AND g.status = 'succeeded' AND g.image_key IS NOT NULL`; source story equals target story and story owner equals caller. A corrupted selection pointing to a different frame is unusable; do not follow it. Snapshot the source's exact selected generation UUID/key once. Do not re-resolve it after I/O, after pending insertion, on retry, or in the runner. Do not send the source's description, concepts, compiled prompt, or interaction ID; its one image supplies the continuity context.

The target itself can be edited during preflight. This attempt uses the already captured description, attachments and source selection. Later accepted saves affect the next request. The UI labels any resulting historical/current mismatch; this is expected snapshot behavior. There is no claim of cross-tab compare-and-swap.

### 4.2 Admission/dispatch pseudocode

```ts
async function startGeneration(frameId, user, requestIdOrNull, expectedSourceOrUndefined) {
  await assertOwnedFrame(frameId, user.id); // 404 isolation
  const replay = await lookupOwnedRequest(frameId, requestIdOrNull, user.id);
  if (replay) return replay.id; // terminal too; no credential check or S3
  const apiKey = resolveUserApiKey(user); // no paid validation call
  const captured = await captureInputsInOneOwnedQuery(frameId, user.id);
  assertExpectedSourceMatches(captured.sourceFrameId, expectedSourceOrUndefined);
  // undefined skips legacy precondition; null requires no configured source
  validateSourceMetadata(captured); // exactly one, same story, not self
  validateCapsAndDescription(captured); // attachments + source slot
  await rejectIfOtherPending(frameId, user.id); // fast path, not authority
  const candidateId = randomUUID();
  let copiedKey = null;
  try {
    const conceptBytes = await readFrozenConceptKeys(captured.concepts);
    let continuityBytes = null;
    if (captured.source) {
      const original = await readSelectedKeyExactlyOnce(captured.source.imageKey);
      continuityBytes = await preprocessReferenceImage(original);
      copiedKey = continuityInputKey(candidateId);
      await putObject(copiedKey, continuityBytes, IMAGE_MIME_TYPE);
      // retain original hash + transformed hash; send transformed bytes
    }
    const { prompt, parts } = compileFramePrompt(frozenCompilerInputs);
    const snapshot = buildSnapshotV2(captured, conceptBytes, continuityBytes, copiedKey);
    const admitted = await withTransaction(async client => {
      await lockOwnedStoryForUpdate(client, captured.storyId, user.id); // common first lock
      await lockOwnedTargetForUpdate(client, frameId, user.id); // 404 if deleted
      const replayNow = await lookupOwnedRequest(client, frameId, requestIdOrNull, user.id);
      if (replayNow) return { inserted: false, id: replayNow.id };
      if (await hasPendingForFrame(client, frameId, user.id)) throw ownedPending409;
      await insertPending(client, candidateId, requestIdOrNull, prompt, snapshot);
      return { inserted: true, id: candidateId };
    });
    if (!admitted.inserted) { await cleanupOwnCandidate(copiedKey); return admitted.id; }
    // Only this inserting request dispatches. COMMIT must be known successful.
    void runGeneration(candidateId, frameId, apiKey, parts);
    return candidateId;
  } catch (err) {
    // On an uncertain COMMIT outcome query candidateId before deleting a copy.
    // If row exists, preserve it; do not dispatch a second task here.
    await cleanupOnlyIfCandidateKnownNotCommitted(candidateId, copiedKey);
    throw mapKnownAdmissionOrStorageFailure(err);
  }
}
```

An ownership-scoped story-first/target lock serializes final admission across processes and lets subsequent statements see a committed first insert at READ COMMITTED. The unique partial indexes are a final defense even if another writer omits the lock. If `23505` occurs, roll back first, then query owned same-request row before checking owned pending row; return that generation/409 respectively. Never continue using an aborted transaction. Map only the two named admission indexes, not all uniqueness errors.

Do not hold a source lock through preflight: the frozen bytes/copy handle source lifecycle. A deleted source between capture and original GET gives missing-image preflight failure; deletion after GET cannot change the in-memory bytes/copy. A deleted target before final insert gives 404 and removes its candidate copy. Once committed, the request is accepted; deletion immediately afterward may still be billed. Explain this existing non-cancellation boundary in confirmation copy.

### 4.3 Terminal updates and sweeper races

**Common short lock protocol:** for each existing story, lock its owned `stories` row `FOR UPDATE` before locking/updating frames or generations. Apply this to source/description/concept-attachment PATCH, selection changes, final generation admission, generation completion/failure and auto-selection, frame deletion, and story deletion. Source/target always share this story, so A→B and B→A never invert two frame locks across transactions. Concept-library mutation does not acquire story locks; atomic metadata capture and frozen downloaded buffers define the existing concept boundary, with the overwrite limitation in §2.3. Metadata capture is a single read and does not hold locks across I/O. A terminal runner carries its captured story ID internally; lock that row first, and treat a deleted story/generation as no transition. A stale-sweep batch locks affected stories in sorted UUID order before its conditional updates, or processes one story per short transaction in that order; never lock generation rows first and then request a story lock. Existing create/append may use the same story-first convention as a small coordinated helper change. Do not add any S3/Gemini operation within these transactions.

Output PUT remains outside SQL. Finalization takes the story lock, performs conditional pending→succeeded, and `selectIfUnset` within **one short transaction**. Deletion takes the same story lock, collects keys, deletes, and commits; S3 cleanup follows. Thus success before deletion is collected; deletion before success makes conditional finalization fail and the runner removes its just-written output. This fixes the existing collect-before-delete race without a worker/asset table.

Change `markSucceeded` and `markFailed` to update only `WHERE id = $1 AND status = 'pending'`. Return whether the transition applied. If success cannot transition because the row was deleted or already swept terminal, remove this runner's output object only after confirming that it is not referenced by a succeeded row; never resurrect an abandoned row or auto-select that output. Keep its recorded continuity copy if the target row survives. `selectIfUnset` must additionally require that the owned-by-frame generation still exists and is succeeded; otherwise deletion can race success and leave an invalid selection. Check output keys cleanup best-effort as today.

An uncertain finalization COMMIT needs the same care as uncertain admission. On a fresh connection, an already-succeeded generation pointing at this runner's output key means finalization succeeded: preserve its object and treat that result idempotently. A confirmed absent, failed, or abandoned generation permits cleanup of this runner's own output key. If the DB remains unavailable or the row still says pending, preserve the object until the outcome is resolved; a DB-only retry may use the same bytes/key and story lock, never another Gemini call. Never blindly delete after a lost COMMIT acknowledgement. Add both successful-but-unacknowledged and rolled-back finalization cases to the nonpaid lifecycle matrix.

Keep the existing 90s Gemini total deadline, explicit SDK `maxRetries: 0`, two retries for explicit rate limits, and five-minute stale threshold. Do not reset budget per retry or auto-replay abandoned rows. Preflight adds latency before a pending row exists: give reference reads/PUTs a bounded shared preflight deadline (recommend 30s total in shared config) and SDK abort signals, clear timers, map expiry to 503, and prevent uncontrolled reference-read fanout beyond at most ten attachments. Polling begins after admission, so its existing budget still covers Gemini. Do not turn the full preflight plus Gemini duration into a synchronous browser request.

### 4.4 Duplicate-paid-call prevention boundary

| Situation | Guarantee |
|---|---|
| Same frame, different request UUIDs whose final admission overlaps a pending row | At most one pending row/runner at a time; later admission receives 409. A slow preflight can admit after the first completes, becoming a distinct paid attempt. |
| Same request UUID concurrently, including both doing preflight | Both may read/copy S3; one row/runner; loser cleans only its candidate. |
| Lost 202, retry same UUID during or after completion | Return original generation; no recompile, new source resolution, or second Gemini task. |
| Fresh UUID after terminal failure/success | Deliberate new manual attempt; may bill. |
| Bodyless legacy POST after prior attempt terminal | New attempt; no durable replay guarantee. Pending overlap still blocked. |
| Crash after commit but before dispatch / during call | Pending survives then becomes abandoned. No automatic resend; Google may have billed. |
| Ambiguous COMMIT acknowledgement | Inspect DB; preserve any committed copy/row; do not launch on uncertainty. A lost dispatch may become abandoned. |
| SDK rate-limit retry | Existing explicit 429 retry policy only; no exactly-once billing claim. |
| Deleted target removes request row | UUID deduplication ends with target lifetime; deleted target cannot be regenerated through API. |

Distinct request UUIDs are distinct intentions: simultaneous clicks from separate clients are not durably coalesced once the first attempt is terminal. Test a staggered preflight that admits after completion; it must be documented as a second admitted attempt, not reported as prevented. This is durable same-request deduplication and single pending admission, not upstream exactly-once execution. No queue/outbox is introduced. New browser clients retain a request UUID until its response/outcome is known; never automatically mint a replacement on a transport timeout. A manual new attempt after an ambiguous abandoned call is a conscious billed retry.

## 5. Pure compiler, ordering, precedence, and budgets

### 5.1 Input and reference order

Add optional `continuity?: { imageBase64: string; imageMimeType: string } | null` to `CompilerInput`. DB identity and snapshot construction stay outside this module. Omitted and null continuity must preserve the exact old prompt and parts bytes.

Order: one text part; imaged concepts in unchanged `frame_concepts.ord` order; then exactly one continuity image part. Imageless concepts retain text and consume no image index. Append the continuity label using the same index increment/push branch used for concepts, so it is `Reference image K+1` where K is the number of actual concept image parts, **not** number of attached concepts. No special unnumbered image and no source-first renumbering.

The original `FORMAT_PREAMBLE` and `OUTPUT_CONSTRAINTS` remain byte-identical. The explicit rule making target Scene instructions override conflicting concept references is a **planning precedence recommendation**, extending the approved Scene-over-source default and consistent with frame descriptions owning scene direction. Review it with the exact prompt text before implementation. Concepts otherwise establish identity ahead of source details. Add these exact continuity constants to the compiler skill's Constants section and mechanically checked compiler exports. Include continuity rules immediately before the unchanged `Scene:` section, so authored scene remains the final variable instruction.

```text
CONTINUITY_REFERENCE_TEMPLATE:
Reference image {N} — Continuity source frame: use this image as the visual starting point for this scene.
```

```text
CONTINUITY_RULES:
Preserve visual details from the continuity source frame unless the Scene explicitly changes them.
Follow explicit Scene instructions over conflicting details in the continuity source or concept references.
Use the concept references to establish subject identity; use the continuity source for otherwise unspecified visual details.
Do not copy panel divisions, borders, captions, or text overlays from the continuity source.
```

Prompt structure with continuity: preamble → concept lines → continuity reference line → continuity rules → `Scene: ${frameDescription}` → output constraints, each section separated by two LF characters. Concept lines stay a single LF-joined block. Source frame ID/position/description never enters prompt text; “source frame” describes the image role. Update skill debug guidance about explicit appearance changes: previous general advice against conflicting appearance remains useful, but this feature intentionally honors explicit target instructions over references. No automatic stripping of concept text or target text.

Literal fixture (one imaged concept A, one imageless concept B, continuity C):

```text
<existing FORMAT_PREAMBLE bytes>

Reference image 1 — A (character): A description
B (prop): B description

Reference image 2 — Continuity source frame: use this image as the visual starting point for this scene.

Preserve visual details from the continuity source frame unless the Scene explicitly changes them.
Follow explicit Scene instructions over conflicting details in the continuity source or concept references.
Use the concept references to establish subject identity; use the continuity source for otherwise unspecified visual details.
Do not copy panel divisions, borders, captions, or text overlays from the continuity source.

Scene:   A wears a red coat.\n\nKeep the room unchanged.\u0020\u0020

<existing OUTPUT_CONSTRAINTS bytes>
```

In the test the `\n` and `\u0020` sequences above mean actual authored newline and space characters; compare against an explicitly authored full string, not a snapshot generated by the same formatting helper. Parts must equal text, A sentinel, C sentinel. Use strict equality for every new constant, spacing, index and section order. Exact text proves the server's contract, not Gemini's ability to obey every visual instruction.

### 5.2 Budget algorithm and examples

Keep `MAX_TOTAL_CONCEPTS = 10` and `MAX_CHARACTER_CONCEPTS = 4`. Add `CONTINUITY_REFERENCE_SLOTS = 1` in shared config, with helper `effectiveConceptLimit(hasContinuity) = MAX_TOTAL_CONCEPTS - (hasContinuity ? CONTINUITY_REFERENCE_SLOTS : 0)` used by client and server; no scattered 9s. Count configured continuity before fetching bytes; unusable continuity never frees its slot or disappears silently.

| Inputs | Result |
|---|---|
| 10 attached concepts, no continuity | Accept if ≤4 characters. |
| 9 concepts + continuity, including imageless concepts | Accept if ≤4 characters. |
| 10 concepts + continuity | 422 too_many_concepts; remove one attachment or clear source. |
| 4 characters + 5 others + continuity | Accept; continuity does not add a fifth character concept. |
| 5 characters + continuity | 422 too_many_characters. |
| 0 concepts + continuity + nonempty scene | Accept; continuity is Reference image 1. |
| 9 imageless concepts + continuity | Accept; one image part but ten reserved slots. |
| Empty/whitespace-only scene with any source | 422 empty_frame_description; authored nonempty text stays untrimmed. |

The unchanged four-character cap governs explicit character attachments, not a promise about the number of people visible in the source. Do not inspect/count faces or infer concepts from source. Explain quality limits without claiming continuity bypasses them. Saving an over-budget draft remains allowed; display effective allowance and disable Generate with actionable guidance, while server validation remains mandatory.

## 6. Source deletion, references, and S3 lifecycle

### 6.1 Warning and confirmed deletion

Add `DELETE /frames/:id?confirmContinuity=true&referenceSetToken=<token>`, with shared Zod query schema accepting only absent or literal `true` and a 64-character lowercase hex token. Existing bodyless delete remains unchanged when incoming count is zero. When references exist and confirmation is absent, return `409 continuity_source_in_use` with count, a server-computed `referenceSetToken`, and this consequence text:

> This frame is a continuity source for N other frames. Deleting it clears those source selections. Existing outputs and their saved continuity inputs remain with those frames. You will need to choose another source before generating with continuity again. Already accepted generation work may still finish or be billed.

The server token is SHA-256 of the sorted dependent-frame UUIDs joined with LF (empty set has its own hash). It identifies a set, not authorization or a new credential. First confirmation can use DTO count, but the server's 409 is authoritative. The second explicit action sends `confirmContinuity=true` and the returned token. Under the deletion lock, recompute and compare; if the set differs (even if count is equal), return another 409 with the fresh count/token and require a new user confirmation. A submitted token that no longer matches also re-prompts if the set has become empty. With zero dependents and no supplied token, existing delete behavior succeeds. Reject `confirmContinuity=true` without the token whenever dependents exist. Only disclose the count/hash, not dependent identifiers from untrusted input. `ConfirmButton` currently has no consequence body, so extend it with small optional message text or use an inline confirmation in FrameEditor; no modal library.

Implement short deletion transaction: verify owner and lock its story first, then source frame `FOR UPDATE`; read current incoming pointers scoped by owned same story; validate confirmation against the dependent-set fingerprint as above; collect its output image keys **and own attempt continuity copy keys from validated V2 snapshots** (derive the expected `generations/{row.id}/continuity.jpg` key and require equality; never delete an arbitrary key extracted from malformed historical JSON); explicitly clear incoming pointers and update their `updated_at`; delete frame and commit. FK `ON DELETE SET NULL` remains safety fallback. The common story-first protocol serializes PATCH attachment/clear operations with the count and delete; source `FOR KEY SHARE` additionally keeps the FK target stable until PATCH commits. A blocked PATCH resumes and rejects a deleted source. Never perform S3 deletion inside the transaction. PostgreSQL deadlock/serialization errors abort the mutation safely; do not retry paid work as their recovery.

Historical snapshot UUIDs are plain data and survive deletion; mark source deleted in DTO without joining unowned rows. In-progress consumers already carry immutable bytes. After deletion, next starts have no source because live pointers clear; existing generations show “Used deleted source frame” and a mismatch against current no-source configuration. No automatic generation occurs.

Story deletion already warns that all frames go away. Extend consequence text to say selected source links and retained continuity inputs in that story also go away. No external-story consumers can exist under the same-story rule. Collect output and copied-input keys for every generation before cascading rows. Use the same story-first/collect-within-transaction protocol for story deletion. Add the copy cleanup to both frame and story deletion; do not delete a copy by source UUID.

### 6.2 Race table

| Interleaving | Expected outcome |
|---|---|
| Source selection changes before atomic capture | New selected generation is captured. |
| Selection changes after capture | Original selected generation/bytes used; history can show current mismatch. |
| Configured source clears/changes between editor save and capture | New client's source-choice precondition rejects with 409 before paid work; an existing-request replay still returns its original attempt. |
| Source disappears before metadata capture | Cleared pointer/no continuity if deletion committed first; no stale hidden lookup. |
| Source deleted after capture before GET | GET may return authoritative missing; reject preflight. |
| Source deleted after GET before copy/commit | Captured bytes produce independent copy; accepted attempt remains valid. |
| Source object unavailable temporarily | 503; no fallback and no paid call. |
| Two preflights same request | Separate candidate keys; loser deletes only its own copy. |
| Target deleted before pending insert | Final target lock fails; cleanup candidate copy; 404. |
| Target deleted after pending insert before/during Gemini | Accepted call may bill; cascade removes row/copy; completion writes then removes unowned output. |
| Target deleted between output PUT and success update | Conditional update returns false; remove output. |
| Sweep marks abandoned before late output | Pending-only success refuses resurrection; remove output. |
| Delete cleanup fails | DB delete succeeds; private orphan remains; log safe key/IDs server-side. |

### 6.3 Stale live and historical references

Pointer FK clears deleted sources. Do not clear merely because a source temporarily lacks a usable selected image; preserve the choice and show the failure. Reorder/description changes do not alter UUID identity. Deleting/recreating a similar-looking frame creates a different UUID and does not repair references automatically. The server reads only one source, so legal cycles have no traversal or invalidation work.

History mismatch is derived from frozen `(sourceFrameId,sourceGenerationId)` versus current configured `(continuitySourceFrameId,continuitySourceSelectedGenerationId)`. Different source or selected generation means “Current source selection differs; regenerate manually to use it.” Known no-source vs current source is a mismatch and vice versa. Same pair means “Used current source selection”, not “Everything is up to date”; concept/description edits are outside this narrow indication. Legacy/unknown means “Source provenance unavailable”, never a false match. Show the selected output's indication and accessible history-item metadata, not only a tooltip hidden on mobile. Refresh frame and story candidates on focus/manual refresh and after relevant mutations; this is a view of latest fetched state, not real-time cross-tab synchronization.

### 6.4 Retention limits and operational debt

No automatic S3 prefix-expiration rule may apply to retained continuity copies while their target exists. Review existing bucket lifecycle settings before enabling the feature; private URLs expire but objects do not. Deleting target owns cleanup of both output and its copied input; deleting source owns its output only. A candidate copy written before a crash/failed commit can orphan; an output PUT followed by DB outage can orphan as today. Best-effort cleanup is acceptable prototype behavior, but record this limitation and use a separately approved manual inventory/reconciliation for accumulated orphans. Do not claim a hash, presigned URL, or SQL cascade deletes S3 objects. No new lifecycle deletion policy or bulk object operation is authorized by this plan.

## 7. Editor drafts, navigation, save order, and polling

The current `FrameEditor` resets `description` whenever any frame DTO arrives; `useApi` retains prior resource data on dependency changes; `generationId` is not keyed to navigation. Simply adding a source dropdown would preserve those races. Address them with local React state, no global state library.

1. Key the mounted editor's state by `frameId` (small route wrapper rendering an inner component with `key={frameId}`), and require `frame.id === frameId && frame.storyId === storyId` before rendering actions. With `useApi` remounted, old resource data cannot flash under a new URL. If changing the hook generally, distinguish identity changes from same-resource reloads; clearing data on every reload is not required.
2. Keep a `draftDescription` and `draftSourceFrameId`, corresponding last-acknowledged saved values, dirty flags, and local edit sequence. Initialize only on the first matching DTO. Merge later same-frame DTOs into server history, selected output, concepts and readiness; update draft fields only when clean. Never set the textarea from every poll-triggered reload. Preserve dirty fields on attach/reorder/select-generation and a failed save. Dirty checks alone do not prevent an old GET arriving after a successful save from overwriting a now-clean field. Maintain a per-editor read/save epoch: increment when a mutation starts and when it acknowledges; stamp every frame/candidate read with its issue epoch. Merge its response only if the stamp equals the current epoch and no relevant mutation is pending; otherwise discard it and schedule a fresh read after the save barrier. PATCH acknowledgements update saved values only for their captured edit sequence. This also prevents an older response from regressing source readiness/history after a newer mutation.
3. Use one editor mutation Promise chain for blur saves, source PATCHes, concept mutations and Generate's save barrier. Capture values and edit sequence when enqueuing. At execution, skip unchanged values; do not let an old acknowledgement mark a newer edit clean. A source change may save immediately, but on blur plus click Generate, await the existing save then enqueue any newer draft. Reject Generate if any preceding required save failed; keep actionable error and drafts. Recover the chain after rejection so later explicit retry can save.
4. Generate handler captures description and source intended by this click, flushes them in one PATCH, awaits acknowledgement, then sends Generate with `expectedContinuitySourceFrameId` set to that saved source UUID/null. The final PATCH reasserts the intended source even if it matches the local last-acknowledged value; a source already deleted on the server must fail validation rather than be skipped as locally clean. The generation precondition covers deletion/change after that PATCH but before atomic capture. A 409 preserves the intended source and scene drafts for review, even if they had been marked clean; refresh server context without silently clearing the choice or retrying. A new submission requires explicit choice/save, never automatic paid retry. Disable editing/mutating controls during this short save/admission boundary to avoid showing draft B while knowingly dispatching captured draft A. Re-enable description editing after 202 while image work runs; later edits do not change admitted snapshot. Keep attachments/display actions from racing the boundary through the same queue. `busy` updates alone are asynchronous: use a synchronous in-flight ref to suppress same-tick double-clicks.
5. Create one request UUID for the intended generation only after successful saves. Persist outstanding request UUID under an account+frame-scoped `sessionStorage` key before POST so a reload can look up the same request after a lost 202 without creating work. Store no key/prompt/image in browser persistence. On transport ambiguity, keep it and offer “Check request” using the lookup-only GET; do not auto-generate a fresh request. Once ID is known, store it for resume; clear token when outcome is known or an explicit new-attempt action is chosen. If storage is unavailable, keep in memory and disclose that reload cannot resolve an unknown submission; never silently auto-retry with a new UUID. Sign-out clears account-scoped pending metadata.
6. Poll by current `{frameId,generationId}` only. Ignore stale polling responses after cleanup; use a monotonically increasing poll request sequence or non-overlapping recursive timeout so an older pending response cannot overwrite a newer succeeded one. Terminal refresh runs once per generation ID/status transition, not only status string, so a second success refreshes too. A completion updates server history without erasing dirty draft fields. Navigating away stops client polling only; server task continues.
7. On load find any pending generation in history (not only newest), resume it, and resolve a persisted unknown request UUID if needed through lookup-only GET. An absent row may mean the original request never arrived or is still in preflight: automatic POST recovery is forbidden because it can create paid work. Show “Request not accepted yet; no saved attempt found” and offer an explicit resubmit after the save barrier, explaining that current saved inputs/source will be used if no earlier request wins. Reuse the outstanding request UUID for this explicit resubmit to protect against a late original request; never mint a new token merely because lookup returned 404. Concurrent original/resubmit preflights may capture different inputs: the first **admitted** snapshot wins, not necessarily the first request sent. Show the resulting recorded source selection/outcome and do not promise that newer saved inputs displaced an already-admitted request. Only replay of an existing row guarantees no new capture. A found row is resumed through polling without POST. A 409 details generation ID resumes existing work. Poll ceiling means “may still finish, refresh/check”; it is not a server failure or permission to silently fire again. Retry for a known terminal failure explicitly creates a new UUID. Back/forward navigation and account change must not reuse another frame's generation ID.
8. Picker includes “None” and every other story frame, with clear earlier/later labels. Show selected source thumbnail and readiness, explain override precedence, and display `Concepts n / effectiveLimit · Characters c / 4 · Continuity 1 slot` when selected. Never detach concepts automatically when selecting a source over budget. Source changes refresh historical indication only; selection/generation is always manual.

Cross-tab simultaneous edits remain last-write-wins. SessionStorage is tab-local; cross-tab distinct UUIDs are protected while pending, but a deliberate second action after completion is a new generation. No full draft persistence across unmount is required; ordinary navigation can discard unsaved edits after the existing blur-save policy, but delayed old-frame saves may only affect their captured frame ID and may never update new-frame UI.

## 8. Sequential, issue-sized implementation packages

These are proposed work items, **not created GitHub issues**. Each must later use the repository Work item form with outcome, exclusions, acceptance, verification, dependency and rollout notes. Do not start implementation before retention review. Keep commits independently reviewable; do not deploy intermediate server/client states claiming a complete feature.

### Package 1 — Admission and snapshot/schema contracts

**Files:** new `server/migrations/003_frame_continuity.sql`; `shared/src/types.ts`, `shared/src/schemas.ts`, `shared/src/config.ts`; `server/src/db/{frames,generations,stories}.ts`; `server/src/services/{frames,stories,sweep}.ts` for common story-first locking; `server/src/services/generation.ts`; new narrow server snapshot types/parser module if needed (e.g. `server/src/services/generationSnapshot.ts`).

**Outcome:** additive nullable pointer/request ID, unique indexes, typed V2 contract/legacy parser, pending-only terminal transitions, shared error-code allowlist, deterministic frame tie ordering. Keep continuity UI unavailable until downstream packages land. Add owned single-query capture and short target-lock admission helpers here or in Package 4, but never ship a writer that bypasses the new indexes unhandled.

**Acceptance/evidence:** disposable migration rehearsal covers existing rows unchanged, null backfill, duplicate-pending abort/rollback, unique pending/request constraints, self FK/check, source deletion nulling, old JSON untouched. DB script, not CRUD unit tests, verifies ownership and SQL transitions. Pure snapshot parser cases can join compiler/provenance tests only if needed to prevent silent historical misclassification; otherwise scripted fixtures. `npm run typecheck`, `npm test`.

### Package 2 — Attempt-owned continuity storage and bounded preflight

**Files:** `server/src/services/{s3,imagePreprocess}.ts`; `shared/src/config.ts`; storage documentation in `TECH_SPEC.md` prepared for final integration.

**Outcome:** attempt continuity key helper, SHA-256 metadata, missing-vs-unavailable discriminator, bounded storage reads/writes, reuse existing 1024px JPEG preprocessing. Continuity copies never overwrite another attempt's keys. Existing concept overwrite behavior stays unchanged and full replay remains deferred. No bucket-policy change or asset service.

**Acceptance/evidence:** stubbed storage/manual scripted checks show existing concept-key reads unchanged, unique per-attempt continuity keys, 404→missing, 403/5xx/timeout→unavailable, malformed/empty source bytes rejected, failed candidate cleanup, abort timer cleanup. No Gemini invocation. Record staging-copy orphan debt and the existing concept-key replay limitation. Typecheck/build; app upload behavior through fixture/stub storage as appropriate.

### Package 3 — Pure continuity compiler and reference budget

**Files:** `server/src/services/promptCompiler.ts`; `server/test/promptCompiler.test.ts`; `shared/src/config.ts` and shared helper export via `shared/src/index.ts` if used; `.agents/skills/storyboard-prompt-compiler/SKILL.md`; relevant `AGENTS.md` invariant wording.

**Outcome:** exact additional label/rules, concept-first reference ordering and optional final continuity part, nine-attachment allowance with continuity, unchanged four-character cap and old outputs. Update skill and code together so tests have one documented canonical text.

**Acceptance/evidence:** full-string fixture, all old compiler tests unchanged/passing, new skill-fidelity extraction with nonvacuity guards, reference sentinels with no/interleaved/all-imageless concepts, zero concepts, verbatim authored whitespace/unicode/newlines, precedence text before Scene, budget table cases, source omitted/null identical to old output. `npm test`, `npm run typecheck`; no network/DB/API needed.

### Package 4 — End-to-end server source configuration/admission/provenance

**Depends on:** 1–3.
**Files:** `server/src/routes/frames.ts`; `server/src/services/{frames,generation}.ts`; `server/src/db/{frames,generations}.ts`; snapshot projection helper from Package 1; `shared/src/{types,schemas}.ts`; `server/src/routes/generations.ts` only if its existing generic response path needs adjustment.

**Outcome:** scoped source PATCH and DTOs, one atomic capture, one source read/copy, final locked idempotent admission, dispatch only after known insert commit, replay compatibility, source mismatch projection, correct storage/Gemini error boundary. No paid probes.

**Acceptance/evidence:** hard-stub Gemini dispatch counter with disposable DB/S3 verifies nonpaid race matrix (§9), owned/unowned/absent GET request lookup with zero dispatch, same-request replay after selection change and terminal completion, foreign-source non-disclosure, known no-source vs legacy history. Prove one runner for concurrent same-request POSTs and at most one pending runner for different requests, including the documented staggered-preflight limit; no runner on every preflight/admission failure. Capture count, not real model output. Existing generation and ownership scripts adapted; no CRUD handler unit suite.

### Package 5 — Confirmed source deletion and complete owned-object cleanup

**Depends on:** 1, 2, 4; final retention decision.
**Files:** `server/src/routes/frames.ts`; `server/src/services/{frames,stories}.ts`; `server/src/db/{frames,generations}.ts`; `shared/src/schemas.ts` for query; cleanup SQL includes V2 copied-input keys only.

**Outcome:** authoritative dependent-set fingerprint confirmation and re-prompt on set changes, FK-safe clear/delete transaction, target/story cleanup of own copied inputs, old generation deletion unchanged, guarded mid-flight completion cleanup. Source delete never removes surviving consumers' copies.

**Acceptance/evidence:** scripted deletion/attachment interleavings and S3-key inventory, denied/no-confirm deletion changes nothing, equal-count/different-set requires re-confirmation, confirm clears count/pointers and preserves target copies, story cascade removes its copies, legacy JSON safe, mid-flight delete and late success cleanup, cleanup failure leaves only documented private orphan. A live DB ownership matrix includes DELETE query variants. No real paid work.

### Package 6 — Editor state integrity and submission lifecycle

**Depends on:** API shape in 4; can land before user-facing picker if behavior stays compatible.
**Files:** `client/src/routes/FrameEditor.tsx`; `client/src/hooks.ts`; `client/src/api.ts`; `client/src/auth.tsx` if clearing pending metadata on sign-out; `client/src/main.tsx` only if route wrapper placement requires it.

**Outcome:** keyed editor, dirty-aware draft merge, ordered saves/mutations, request UUID and lost-response resume, navigation-safe non-overlapping polling, per-generation terminal refresh. Include precise caught-save feedback; do not let reload clobber edits.

**Acceptance/evidence:** throttled mocked-network/manual app cases: type then click Generate without blur; blur+Generate; change source then Generate; save rejection; double-click same tick; stale reload arrives while typing; pre-save GET arrives after PATCH ack after dirty state cleared and is discarded by epoch; navigate A→B with old A response/poll pending; generate twice with two successes; reload after lost202; original POST never reached server then automatic recovery remains GET-only/no dispatch; poll timeout and explicit check; sign-out/account switch. Each outcome must show expected server-captured description/source, dispatch count and surviving draft. No new React test framework required by this prototype policy.

### Package 7 — Source picker, history indication, warnings, and integration docs

**Depends on:** 4–6.
**Files:** `client/src/routes/{FrameEditor,StoryDetail}.tsx`; `client/src/components/ConfirmButton.tsx` if extended; `client/src/api.ts`; `client/src/index.css`; `TECH_SPEC.md`; `AGENTS.md`; `.agents/skills/storyboard-prompt-compiler/SKILL.md`; update this plan's execution status only once evidence exists.

**Outcome:** every-other-frame picker and clear-source choice, readiness/slot counts, explicit precedence help, selected/history source indication, source deletion confirmation and story deletion consequence text. Revise TECH_SPEC §§3, 5/5.1, 6–9, 12 and testing/build-order references. Explicit image-based continuity becomes in scope; interaction chaining stays out of scope. Document limitations instead of importing Atelier terminology.

**Acceptance/evidence:** keyboard/mobile flow, earlier/later source labels, over-budget drafts, unavailable source and temporary storage errors, deleted/legacy history, source selection changes without automatic generation, source reorder labels, end-to-end fixture ownership matrix. `npm run typecheck`, `npm test`, `npm run build`; screenshots/sanitized recorded outcomes for UI review. Only separately approved visual experiments in §9.4 can use paid Gemini.

## 9. Verification strategy and evidence requirements

### 9.1 Repository policy

Follow [AGENTS.md](AGENTS.md#testing): focused pure compiler/validation tests; existing credential/meta-prompt/position tests remain unchanged; ownership through a scripted two-account matrix against a disposable/live test DB; other CRUD and UI behavior exercised through the app. Do not introduce a generic service/CRUD unit framework. Add a small explicit validation fixture file (e.g. `shared/test/continuityValidation.test.ts`) only for meaningful new shared boundary logic, not to mirror Zod definitions. Keep orchestration/concurrency/deletion evidence in a bounded repeatable script/manual matrix under an agreed test-support location rather than claiming unit tests establish DB behavior.

### 9.2 Hard zero-paid-call boundary

All ordinary automated and manual acceptance runs must use a stub image generator and stub S3 or isolated test bucket, with outbound connections to `generativelanguage.googleapis.com` blocked by the harness/environment. Use fixture accounts inserted with test hashes and encrypted dummy key material; do not call registration, key update/validation, `/describe`, or any endpoint that validates a real key. Mocking `generateImage` alone does not block registration's `validateApiKey`. Install the transport guard before app import/start, fail loudly on any Gemini SDK network attempt, and record counter `0` plus stub dispatch counts. No production keys, session tokens, screenshots with private data, or bucket contents in public work items. This planning task itself makes no Gemini calls.

### 9.3 Required nonpaid matrix

| Area | Cases / decisive evidence |
|---|---|
| Migration | Clean DB and old fixtures; duplicate pending abort leaves no partial DDL; unique-index races; no destructive backfill. |
| Isolation | Accounts A/B: read/update/generate/delete source/target/history; same owner other story; lookup-only GET recovery for owned known/absent requests, foreign frame and foreign request UUID; malformed/unknown IDs; no inaccessible labels, keys or counts. |
| Source resolution | No selection; pending/failed selection; cross-frame selected ID corruption; missing image key; later-frame source; cycles; selection changes before/after capture; expected source UUID/null mismatch after editor save returns 409 with zero dispatch; omitted legacy expectation; replay bypasses changed expectation. |
| Storage preflight | Object missing vs 403/timeout/5xx; corrupt/empty image; copy PUT failure; deadline; no pending row or model dispatch on failure. |
| Concurrency | Concurrent same/different tokens and legacy POSTs; 409 resumes existing ID; terminal replay same token; lost response replay after completion; lookup-only recovery when POST never arrived causes no work; staggered different-token preflight can admit after first completes; uncertain COMMIT/restart cannot dispatch twice. |
| Immutability | Change description/concepts/source after capture; concept upload replacement illustrates documented existing coherence limit; actual dispatched hashes equal snapshot; source copy remains byte-identical after source deletion. |
| Lifecycle | Source delete before GET/after GET; target delete before insert/after insert/after output PUT; add pointer during delete; equal-count/different-dependent-set confirmation race; sweeper before late success; finalization COMMIT acknowledged/lost/rolled back; no resurrection/dangling auto-selection or deletion of a committed selected image. |
| Provenance | V1, V2 null/source, deleted source, malformed/unknown schema; no false historical match; current-vs-historical selected image changes. |
| Budget/compiler | All §5 cases; exact text; image-order sentinels; old no-source bytes unchanged. |
| UI | All Package 6 save/navigation scenarios; picker every other frame; disabled/unusable current choice; changed dependent sets (including equal counts) during delete; manual-only regeneration. |
| Cleanup | Source removes own outputs only; target/story remove own copies; losers remove own candidate; no raw credentials/logged bytes; known private orphan cases recorded. |

Record exact commands, fixture IDs sanitized, stub call counts, actual SQL states, requested/actual object deletions and browser outcomes. Counterexamples matter: one unique index alone does not prove source timing, and a disabled button alone does not prove double-charge protection.

### 9.4 Separately gated visual experiments

No visual experiment is needed to complete this plan or ordinary nonpaid verification. Before any future paid trial, obtain explicit approval for named account/key owner, model/config, maximum calls and cost/budget exposure, prompts/reference assets and intended output review. Thinking can bill; timeouts and ambiguous upstream failures may bill; do not promise zero cost on failures. Do not register an account just to run a trial without including its key-validation call in that authorization.

Suggested small approved trial: identical target instructions with and without continuity, a later-frame source, explicit changed costume/camera/light, unchanged-room details, and four attached characters within budget. Inspect visual identity, requested overrides, unstated detail retention, copied unwanted text/panels, and order correspondence. This is empirical model-quality evidence, not proof of deterministic fidelity. Any prompt tuning changes skill constants and exact-text tests in the same reviewed patch; no model swap or tuning parameters.

## 10. Rollout, residual decisions, and planning evidence

Implementation readiness requires review of the copied-input retention recommendation, confirmation of bucket lifecycle compatibility, and independent risk review. After packages pass nonpaid acceptance, review migration/rollout/backout as one coherent change. Merging `master` can auto-deploy; obtain explicit maintainer approval before merge/deploy. Separate approval is needed before applying migrations or running paid experiments. Do not push this planning branch without existing applicable authorization. No issue creation is part of this request.

Before production release: verify DB backup/rehearsal; stop/drain generation ingress; inspect duplicate pending rows; migrate; deploy one compatible server writer; smoke old bodyless POST and new idempotent POST against stubs/test credentials; enable new client; verify live source deletion/lifecycle behavior without paid calls; only then resume generation ingress. No broad feature flag/config system is necessary. If smoke fails, pause ingress and use the application rollback restrictions in §2.4. Historical outputs and snapshots are never backfilled to pretend the feature existed.

### 10.1 Evidence from this planning pass

- Read current [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), [TECH_SPEC.md](TECH_SPEC.md), [compiler skill](.agents/skills/storyboard-prompt-compiler/SKILL.md), [Gemini skill](.agents/skills/gemini-nano-banana/SKILL.md), and existing root plan conventions.
- Reinspected migrations, shared config/types/Zod schemas, DB helpers, S3/image preprocessing, generation/frames/concepts/stories services and routes, compiler tests, editor/API/hooks, and deletion UI.
- Started local branch `feat/explicit-frame-continuity-plan` at `a6abd515f24db30123fcaa4164c1557cce333ae4`, preserving the clean original `work` branch. Fresh `git ls-remote origin HEAD refs/heads/master` checks on 2026-10-20 found both remote refs at that baseline: no intervening master changes since the gap analysis. The stale local `origin/master` tracking ref was not used as the baseline; no fetch, reset, merge, or push was needed.
- Confirmed current gaps in source: no continuity fields; pending check uses a transaction without a target lock/unique pending index; `inputSnapshot` is `unknown`; concept uploads overwrite `reference.jpg`; frame/story deletes remove source S3 objects; generation local error allowlist omits `invalid_api_key`; editor resets drafts on every frame reload and retains generation state across navigation; polling allows overlapping responses.
- Planning-only validation: reviewed the entire document and final diff; checked local Markdown link targets/line references and balanced fenced blocks; ran `git diff --cached --check` before the documentation-only commit. Only this new Markdown file is included. Application tests, migration rehearsal, browser matrix, stubs and visual experiments described above are **future acceptance work, not executed or reported passing**. Application test/build commands are not applicable to this documentation-only change under CONTRIBUTING.md. No application implementation, migration, paid call, issue, push, merge or deployment was performed.

Baseline evidence supporting the required changes (line links refer to the baseline, not hypothetical future code):

| Surface | Evidence |
|---|---|
| Existing frame/generation schema | [frame fields](server/migrations/001_init.sql#L30), [generation snapshot and pending index](server/migrations/001_init.sql#L55) |
| Shared contracts | [frame DTOs](shared/src/types.ts#L70), [PATCH schema](shared/src/schemas.ts#L80), [shared caps/timing](shared/src/config.ts#L24) |
| Source selection and provenance building blocks | [owned selected-image join](server/src/db/frames.ts#L41), [preflight and snapshot](server/src/services/generation.ts#L50), [explicit generation selection](server/src/services/generation.ts#L204) |
| Admission and terminal-state risks | [pending existence check](server/src/db/generations.ts#L50), [terminal writes](server/src/db/generations.ts#L89), [transaction helper](server/src/db/pool.ts#L38) |
| Image lifecycle | [S3 helpers and mutable concept keys](server/src/services/s3.ts#L12), [reference preprocessing](server/src/services/imagePreprocess.ts#L28), [frame deletion](server/src/services/frames.ts#L134), [story deletion](server/src/services/stories.ts#L42) |
| Client state and fidelity | [editor draft/reload behavior](client/src/routes/FrameEditor.tsx#L13), [polling hook](client/src/hooks.ts#L69), [compiler fidelity tests](server/test/promptCompiler.test.ts#L55), [pure compiler](server/src/services/promptCompiler.ts#L40) |

### 10.2 Independent review record

Sol authored the detailed plan; Astra performed an independent source and draft complexity/risk review. The reviewed findings were incorporated into the contracts and packages:

- Shared story-first lock order coordinates terminal finalization, sweeper, configuration, selection and delete; output keys/copy keys are collected under the deletion lock, with S3 outside SQL. Legal source cycles do not invert frame lock order.
- Dependent-set fingerprint confirms the exact reviewed deletion set; equal-count membership changes re-prompt.
- Distinct server attempt UUIDs protect staged-copy cleanup; uncertain COMMIT preserves objects until existence is known; same-request replay precedes source/key/preflight checks.
- Final review also extends uncertain-COMMIT protection to terminal finalization: preserve an already-committed succeeded output, and reconcile unavailable DB outcomes before object cleanup.
- Automatic lost-response recovery uses a read-only lookup. A POST retry can create work when the initial request never arrived, so resubmission requires explicit user action and the save barrier.
- A narrow expected-source UUID/null precondition catches source deletion/reconfiguration between final save and capture without pinning its selected generation or adding a general frame revision system.
- Different request UUIDs only serialize while pending; delayed preflight can admit after the first completes. Tests and guarantees state that boundary instead of promising global exactly-once billing.
- Picker metadata readiness is explicit; preflight GET remains authoritative for storage. Editor read/save epochs prevent pre-save reads from overwriting acknowledged drafts, in addition to dirty flags and navigation fencing.
- Immutable concept uploads/version retention were deferred after parent scope review; actual concept bytes are hashed and their existing overwrite/replay/coherence limits are explicit. Source retention stays a review-required recommendation.
- Legacy snapshots remain unknown provenance, rollout rollback cannot silently ignore configured continuity, transactional migrations avoid concurrent-index DDL, and hard outbound guards cover registration/key validation as well as image generation.

Residual limitations are intentional: no upstream exactly-once guarantee or automatic crash recovery, cross-tab edits remain last-write-wins, full concept replay is unavailable, and orphan cleanup is best-effort/manual. Astra's final reread reported the core corrections present with no architecture blocker for a documentation-only commit; its remaining draft notes on readiness/epochs/recovery wording and ownership coverage are incorporated above. Retention and expanded Scene-over-concept prompt precedence remain planning recommendations for review; this review does not authorize implementation or operational actions.
