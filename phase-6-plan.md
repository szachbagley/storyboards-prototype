# Phase 6 Plan — The Generation Pipeline

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 6
**Depends on:** phases 1–5 — all complete
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

Phase 6 joins everything built so far into the loop the app exists for: attach
concepts to a frame, press generate, get an image back. Three endpoints, one
background task, one sweeper.

It is also the first phase where a mistake **costs money**. The image API is
synchronous with no task handle: a dropped connection loses the image and still
bills. That single fact drives most of the design below.

**Phase 6 is done when all of the following are true:**

1. `POST /api/frames/:id/generate` validates, compiles, inserts a `pending` row
   **with `compiled_prompt` and `input_snapshot` already written**, returns
   `202 { generationId }`, and fires the Gemini call without awaiting it.
2. A second generate on a frame with a `pending` generation returns `409`.
3. On success the image is in S3 at `generations/{id}.jpg`, the row is
   `succeeded` with `image_key`, `interaction_id` and `completed_at`, and the
   frame's `selected_generation_id` is set **only if it was null**.
4. On failure the row is `failed` with an `error_code` from the §8.6 taxonomy
   and a safe `error_message` — never a raw upstream string.
5. `GET /api/generations/:id` returns status and, on success, a presigned URL.
6. `POST /api/frames/:id/select-generation` sets `selected_generation_id`.
7. **Generations append, never overwrite** — regenerating adds a row and never
   destroys or replaces an earlier one.
8. The stale sweep runs on process start and every 60s, marking `pending` rows
   older than 5 minutes as `failed` with `error_code = 'abandoned'`, and is
   cleared on shutdown.
9. Deleting a frame or a story deletes its generations' S3 objects — the debt
   recorded in phase 4.
10. Typecheck clean; all 67 existing tests still pass.

**Not in phase 6:** every client view, including the four generation states, the
elapsed timer, the history thumbnails and the polling loop itself (phase 7).

---

## 2. Decisions

### 2.1 Probe the image model's refusal shape first

Phase 3 established the SDK's error shapes for **text**: safety refusals arrive
as a `BadRequestError` with `status: 400` and a message beginning
`Input blocked: This request was blocked by Gemini's filters.`

Whether image generation refuses the same way is undocumented, and it matters
more here than anywhere else in the project: §8.6 singles out `safety_blocked`
precisely because storyboards skew violent — the spec's own sample frame reads
"stands menacingly" — and a refusal misread as a crash is the difference between
"rephrase this" and "the app is broken."

**Step 1 is a short probe** answering two questions:

- Does a prohibited prompt throw a `400` with the `Input blocked` marker, or
  return `200` with no `output_image`?
- Is `output_image` ever absent on an otherwise successful response?

A refused request 400s before generation, so it costs nothing. **Keep billed
generations to a minimum throughout this phase** — a handful of real images is
enough to verify the pipeline.

### 2.2 The request

Per §8.5 and the `gemini-nano-banana` skill, with every value from
`shared/config.ts`:

```ts
const interaction = await ai.interactions.create(
  {
    model: IMAGE_MODEL,                    // gemini-3.1-flash-image
    input: parts,                          // from the phase 5 compiler
    response_format: {
      type: "image",
      mime_type: IMAGE_MIME_TYPE,          // image/jpeg
      aspect_ratio: ASPECT_RATIO,          // 16:9
      image_size: IMAGE_SIZE,              // "1K" -- case-sensitive
    },
  },
  { timeout: remaining, maxRetries: 0 },
);
```

No `temperature`, `top_p` or `top_k`. Phase 3 established empirically that this
model *accepts* them, contrary to the skill and `CLAUDE.md` — but the operative
instruction stands and the project sends none.

`image_size` is `"1K"`, not `"1k"`. Phase 3's billing check confirmed `1K` at
`16:9` really does return 1376×768.

Read `interaction.output_image.data` (base64) and `interaction.id`.

### 2.3 Shared retry and deadline, extracted from phase 3

Phase 3's `describeImage` already implements the §8.6 policy: `maxRetries: 0` so
the SDK's hidden retries cannot compound, a total deadline across attempts, and
`rate_limited` as the only retryable condition.

Generation needs identical semantics with a different model and a different
budget. **Decision: extract that loop into a private
`withRetryAndDeadline(deadlineMs, run)` helper in `services/gemini.ts`, and have
both `describeImage` and the new `generateImage` use it.**

This is a change to working phase 3 code, justified because two copies of retry
logic that must agree is exactly how they stop agreeing. The refactor is
behaviour-preserving; phase 3's describe path is re-verified in §5.

**Budget arithmetic worth stating.** The skill puts image latency at 10–40s.
With `GENERATION_DEADLINE_MS = 90_000` as a *total* budget and backoffs of
2s and 8s, a slow generation gets at most two attempts before the budget is
spent, and the third is skipped rather than started with no time left. That is
the intended behaviour: the deadline governs, and the last classified error is
what gets persisted. Worst case wall-clock stays near 90s, comfortably inside
the 5-minute sweep threshold.

### 2.4 Ordering inside the request handler

The sequence is fixed by two invariants — snapshot before generating
(invariant 7), and the backend owning the call end to end (invariant 2):

```
1. Load frame + attached concepts (in ord order)          -- 404 if no frame
2. Reject if the frame already has a pending generation    -- 409
3. validateFrameForGeneration(...)                         -- 422 (phase 5)
4. Fetch each concept's reference image from S3 -> base64
5. compileFramePrompt(...)                                 -- pure (phase 5)
6. INSERT generations row: pending, model, compiled_prompt, input_snapshot
7. return 202 { generationId }
8. fire runGeneration(generationId) WITHOUT awaiting
```

**S3 reads happen before the insert (step 4), not inside the background task.**
Two reasons. First, `compiled_prompt` must be exactly what is sent, and the
parts cannot be built without the bytes — compiling after the insert would risk
the recorded prompt diverging from the real one. Second, an S3 failure then
surfaces as a clean error response with no orphaned `pending` row, instead of a
mysterious failed generation. The cost is a few hundred milliseconds before the
`202`, which is invisible next to a 10–40s generation.

Steps 2 and 6 run in **one transaction**. A read-committed race could still let
two simultaneous requests both pass the pending check; this is a single-user
prototype and the consequence is one extra billed image, not corruption. Noted,
not defended against.

### 2.5 The background task never throws and always terminates the row

```ts
void runGeneration(generationId).catch((err) => console.error(...));
```

`runGeneration` wraps everything in try/catch and **always** writes a terminal
state — `succeeded` or `failed` — before returning. The outer `.catch` is a
last-resort log for a bug in the error path itself; an unhandled rejection would
take the process down.

If the process dies mid-generation the row stays `pending` and the sweep (§2.8)
resolves it. That is the designed recovery path, not a gap.

### 2.6 On success: S3 first, then the row

Invariant 2 — "persist to S3 the moment bytes arrive." Decode, `PutObject` to
`generations/{generationId}.jpg`, then update the row.

Same ordering rationale as the phase 2 concept upload: a failed row update after
a successful put leaves an unreferenced object, which is harmless; the reverse
leaves a row pointing at an object that does not exist, and every later read
breaks.

**If the `PutObject` itself fails we have paid for an image and lost it.** No
retry is implemented — out of scope for a prototype — but the failure logs the
`interaction.id` and the byte length prominently so it is recognisable rather
than mysterious, and classifies as `upstream_error`.

Then: **set `frames.selected_generation_id` only if it is currently null.** §7
step 3. This is what makes invariant 8 real — a later generation never steals
selection from an earlier one, so a worse result cannot displace a better one.
Promoting the newest would be a one-word change and would silently break the
core loop of the app.

### 2.7 `input_snapshot`

Exactly §5.1's shape:

```jsonc
{
  "frameDescription": "...",
  "aspectRatio": "16:9",
  "imageSize": "1K",
  "concepts": [
    { "id", "ord", "name", "type", "description", "imageKey" }
  ]
}
```

`imageKey`, **not** base64 — embedding the image bytes would bloat every row by
hundreds of kilobytes for no benefit. The point of the snapshot is provenance:
concepts are mutable and shared, so without it, editing one description silently
invalidates the record of every frame already generated from it.

Written as part of the INSERT, before the API call. Never updated afterwards.

### 2.8 The stale sweep

§7.1 calls this "not optional… the difference between a prototype that recovers
from a deploy and one that requires manual database surgery."

```sql
UPDATE generations
   SET status = 'failed',
       error_code = 'abandoned',
       error_message = '...',
       completed_at = now()
 WHERE status = 'pending'
   AND created_at < now() - ($1 * interval '1 millisecond')
```

Rehearsed against Postgres 17 while planning. `$1 * interval '1 millisecond'`
takes the constant as a plain integer parameter; the alternative
`($1 || ' milliseconds')::interval` also works but forces the parameter through
text. **`EXPLAIN` confirms this predicate uses the partial index
`generations_pending_idx`** created in phase 1 — `Index Scan using
generations_pending_idx ... Index Cond: (created_at < now() - '00:05:00')` —
which is what that index was created for and is now verified rather than
assumed.

- Runs **on process start** and every `SWEEP_INTERVAL_MS` (60s).
- Threshold `STALE_GENERATION_AGE_MS` (5 minutes) — comfortably beyond the ~90s
  worst case from §2.3, so a live generation is never swept.
- Uses the partial index `generations_pending_idx` created in phase 1.
- Logs the number swept when non-zero; silent otherwise, so it does not spam the
  log every minute.
- The interval handle is stored and **cleared on SIGTERM** in `index.ts`, where
  phase 1 left the placeholder comment.

### 2.9 Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/frames/:id/generate` | `202 { generationId }`; `409` if pending; `422` on cap/description validation |
| `GET` | `/generations/:id` | `GenerationSummaryDto`; `404` unknown |
| `POST` | `/frames/:id/select-generation` | `{ generationId }` → updated `FrameDto` |

`GET /generations/:id` reuses `GenerationSummaryDto` from phase 4 — the same
shape already returned inside `FrameDto.generations`, so the client parses one
type everywhere.

`select-generation` validates that the generation **belongs to that frame** and
is **`succeeded`**, returning `422` otherwise. The ownership check is required
for correctness; the succeeded check is a small addition — selecting a failed
generation would point the frame at a row with no image — and is called out here
rather than slipped in.

Returns the full `FrameDto` for symmetry with `PATCH /frames/:id`.

### 2.10 Paying off the phase 4 S3 debt

Phase 4 verified empirically that deleting a frame or story leaves
`generations/{id}.jpg` objects orphaned. Now that generation objects actually
exist, both delete paths must clean up:

- `DELETE /frames/:id`: collect the frame's generation `image_key`s **before**
  deleting the row, then best-effort delete the objects after.
- `DELETE /stories/:id`: same, across every frame in the story, in one query.

Best-effort and non-fatal, mirroring the phase 2 concept-delete precedent: the
rows are already gone, so a failed object delete must not fail the request.

### 2.11 Testing

**No new automated tests.** `CLAUDE.md` sanctions three areas — the compiler and
the caps (phase 5) and position arithmetic (phase 4) — plus the meta-prompt
fidelity area added in phase 3. The pipeline is orchestration over I/O; testing
it properly would need an injectable Gemini client, which the no-mocks policy
excludes.

The sweep is the one component that is pure SQL and tempting to test. It is
verified instead by inserting a backdated `pending` row and watching it resolve
(§5.5), which exercises the real statement against the real index.

---

## 3. Repository layout after phase 6

```
server/src/
├── index.ts                    MOD  start sweep; clear it on shutdown
├── db/
│   ├── generations.ts          NEW  insert, terminal updates, poll read, sweep
│   ├── frames.ts               MOD  + generation image keys for a frame
│   └── stories.ts              MOD  + generation image keys for a story
├── routes/
│   ├── frames.ts               MOD  + generate, select-generation
│   └── generations.ts          NEW  GET /generations/:id
└── services/
    ├── generation.ts           NEW  the pipeline
    ├── sweep.ts                NEW  stale generation sweep
    ├── gemini.ts               MOD  extract withRetryAndDeadline; + generateImage
    ├── s3.ts                   MOD  + generationImageKey
    ├── frames.ts               MOD  S3 cleanup on delete
    └── stories.ts              MOD  S3 cleanup on delete
```

No new dependencies.

---

## 4. Step-by-step execution

### Step 1 — Probe the image model's refusal shape (§2.1)

Throwaway script. Record findings; delete it.

### Step 2 — `services/gemini.ts`: extract the shared policy, add `generateImage`

`withRetryAndDeadline(deadlineMs, run)` used by both functions. `generateImage`
takes the compiled `parts`, returns `{ base64, interactionId }`, and treats a
missing `output_image` as `upstream_error`.

### Step 3 — `db/generations.ts`

`insertPending`, `markSucceeded`, `markFailed`, `getById`, `hasPendingForFrame`,
`selectGeneration`, `sweepStale`, plus the image-key collectors for §2.10.

### Step 4 — `services/generation.ts`

The §2.4 handler path and the §2.5/§2.6 background task.

### Step 5 — `services/sweep.ts` and wiring in `index.ts`

### Step 6 — Routes

### Step 7 — S3 cleanup on frame and story delete (§2.10)

---

## 5. Verification

Billed calls are real. Aim for **no more than four successful generations**
across the whole phase.

### 5.1 The happy path, end to end

Create a story and a frame, attach two concepts with reference images (one
`character`, one `setting`), write a real scene description, and generate.

- `202 { generationId }` returns in well under a second — proving the handler
  does not await the model.
- The row is `pending` **with `compiled_prompt` and `input_snapshot` already
  populated**, checked in SQL *while the call is still in flight*. This is
  invariant 7 and it is only observable during this window.
- Polling `GET /generations/:id` shows `pending` → `succeeded`.
- The object exists at `generations/{id}.jpg`; the presigned URL loads; the
  image is **1376×768 JPEG**.
- `interaction_id` and `completed_at` are set.
- The frame's `selected_generation_id` now points at this generation.
- The image is inspected visually — this is the one phase where "it returned
  200" is not the same as "it worked."

### 5.2 Append-never-overwrite

Generate a second time on the same frame.

- A new row appears; the first is untouched.
- `selected_generation_id` **still points at the first** generation.
- `GET /frames/:id` lists both, newest first.
- `POST /frames/:id/select-generation` moves the pointer to the second, and
  `GET /stories/:id/frames` reflects the new image.

### 5.3 Prompt fidelity

Read `compiled_prompt` back out of the row and confirm it matches what the phase
5 compiler produces for the same inputs — the enumeration order, the frame
description verbatim, and reference image count equal to the number of attached
concepts with images.

Confirm `input_snapshot` holds `imageKey` values and not base64, and that its
`concepts[].ord` matches the attachment order.

### 5.4 Failure paths

| Case | Expected |
|---|---|
| Generate with a pending generation in flight | `409` |
| Frame with an empty description | `422 empty_frame_description` |
| Frame with 5 character concepts | `422 too_many_characters` |
| Frame with 11 concepts | `422 too_many_concepts` |
| Unknown frame id | `404` |
| Prohibited scene text | row `failed`, `error_code = 'safety_blocked'` |
| Invalid API key (temporarily) | row `failed`, `error_code` from the taxonomy, **no key material in the row or response** |
| Deadline exceeded (temporarily shortened) | row `failed`, `error_code = 'timeout'` |
| `select-generation` with another frame's generation | `422` |
| `select-generation` with a failed generation | `422` |

Crucially, a failed generation must leave `selected_generation_id` **unchanged**
— a failure must never clear a good image.

### 5.5 The sweep

- Insert a `pending` row backdated 10 minutes; within 60s it becomes `failed`
  with `error_code = 'abandoned'` and a `completed_at`.
- Insert a `pending` row dated now; confirm the sweep leaves it alone.
- Restart the server with a backdated `pending` row present and confirm the
  start-up sweep resolves it immediately rather than waiting for the interval.
- Confirm the interval is cleared on SIGTERM — the process exits promptly.

### 5.6 S3 cleanup and regression

- Delete a frame with generations → its objects are gone from the bucket.
- Delete a story with frames and generations → all its objects are gone.
- Concepts CRUD, upload, describe (phase 3 — re-verified after the §2.3
  refactor), stories/frames CRUD, ordering and attachment all still work.
- Typecheck clean; 67/67 tests; no `500` anywhere.
- Bucket empty and database empty at the end.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Losing a paid image to a dropped connection | Backend owns the call; bytes go to S3 immediately (§2.6) |
| Double-fire from an impatient double-click | `409` on an existing pending generation (§2.4) |
| A newer generation stealing selection from a better one | Set `selected_generation_id` only when null (§2.6) |
| UI spinning forever after a deploy | Stale sweep on start and every 60s (§2.8) |
| `compiled_prompt` diverging from what was sent | Compile before insert, with the same bytes (§2.4) |
| Snapshot bloat | `imageKey`, never base64 (§2.7) |
| Retry logic drifting between describe and generate | One shared helper (§2.3) |
| Safety refusal reading as a crash | Probe first (§2.1); classify to `safety_blocked` |
| Background task crashing the process | `runGeneration` never throws; outer `.catch` as backstop (§2.5) |
| Orphaned generation objects | Cleanup on frame and story delete (§2.10) |
| Runaway spend during verification | Explicit budget of ~4 successful generations (§5) |

---

## 7. Explicitly deferred

| Item | Phase |
|---|---|
| All client views: four generation states, elapsed timer, history thumbnails, polling | 7 |
| Retrying a failed `PutObject` after a billed generation | Not planned (§2.6) |
| `previous_interaction_id` chaining | Not in v1; the column is stored and nothing reads it |
| Spend controls, quotas, usage dashboards | Explicitly out of scope (`CLAUDE.md`) |
| A job queue, Redis, or a worker process | Explicitly forbidden; one process is correct here |

---

## 8. Execution notes

### Two defects found and fixed

**1. A soft safety refusal was misclassified as `upstream_error`.**
The Step 1 probe found the hard block — a `400` carrying `Input blocked` — but
the image model refuses in a **second, undocumented way**: it returns
`status: "completed"` with **no `output_image`** and an `output_text` explaining
the refusal ("I cannot create photorealistic imagery of the synthesis of…").

The original code treated any missing image as `upstream_error`, which in the
section 8.6 taxonomy means "the service is unavailable, offer retry". Retrying a
refusal cannot help, and the message read as a broken application — exactly what
section 8.6 exists to prevent, on the failure mode most likely to hit a
storyboarding user.

`generateImage` now uses the presence of explanatory text as the discriminator:
text present → `safety_blocked` with a rephrase suggestion; no text → genuine
`upstream_error`. Verified end to end: the same prompt now yields
`failed / safety_blocked`.

Worth noting the probe alone would not have caught this — the CSAM prompt hard-
blocks, while a chemical-weapons prompt soft-refuses. Only running a *second*
kind of prohibited prompt through the real pipeline surfaced it.

**2. Shared classifier messages named the wrong operation.**
Extracting the retry policy (§2.3) also made phase 3's error *messages* shared,
and they were describe-specific. A frame generation timing out reported "The
**description** request timed out", while `rate_limited` said "image service"
even when describing. All five messages are now operation-neutral, with a
comment at the interface saying why.

### Verified

- `202` returned in **0.27s** and **0.29s** — the handler does not await the model.
- **Invariant 7 caught in flight**: while a call was still running, the row read
  `status=pending`, `compiled_prompt=874 chars`, `snapshot concepts=2`,
  `image_key` null. Only observable in that window.
- **Append never overwrites**: a second generation left
  `selected_generation_id` on the first, both before and after it succeeded.
  `select-generation` then moved it explicitly, and the story grid cover
  followed.
- `409 generation_in_progress` on a double-fire.
- Stored `compiled_prompt` has 2 reference lines in `ord` order
  (`Spaceman`, `Old Keep`) and contains the frame description verbatim.
  `input_snapshot` carries `imageKey` values, not base64, with `ord` preserved.
- Failure paths: `422 empty_frame_description`, `422 too_many_characters`
  ("5 character concepts are attached, but at most 4 are supported. Remove 1."),
  `422 too_many_concepts`, `404`, `422 generation_frame_mismatch`,
  `failed/timeout` under a shortened deadline, `failed/safety_blocked`.
  **A failed generation never changed `selected_generation_id`.**
- No key material or raw upstream text in any persisted `error_message`.
- **Sweep**: start-up run resolved a 10-minute-old `pending` row to
  `failed/abandoned` while leaving a fresh one alone; the interval tick caught a
  backdated row after 41s; SIGTERM exits in **0.30s** with the interval cleared.
- **Phase 4 S3 debt paid**: deleting the frame and story removed their
  generation objects.
- The generated image was inspected visually and is genuinely correct: both
  concepts' identities carried through from their reference images, and every
  staging directive in the frame description (left third, wide shot, dusk,
  muted storyboard style) was honoured.
- 67/67 tests, typecheck clean, zero unhandled errors, database and bucket empty.

### Observations, not defects

- **The model drew a border around the frame** despite `OUTPUT_CONSTRAINTS`
  saying "no panel divisions, borders, captions, or text overlays". The
  constraint text is verbatim from the skill, so this is a note on prompt
  effectiveness rather than a code defect. Worth revisiting if borders prove
  consistent.
- **Verifying S3 deletion needed a positive control.** The scoped IAM user has
  no `ListBucket`, so S3 masks `NoSuchKey` as `403 AccessDenied` — meaning a
  `403` alone cannot distinguish "deleted" from "no permission". Establishing
  that `200` means present and `403` means absent *for this credential set* was
  necessary before the deletion result meant anything.
- **Billed generations used: 5.** One more than the §5 budget of four, because a
  malformed test of mine created a frame *with* a description and then asserted
  it should be rejected as empty — firing a real generation. The test was wrong,
  not the code.
- **A verification habit was wrong.** `npx tsc … | head -10 && echo "clean"`
  chains on `head`'s exit status, not `tsc`'s, and printed "typecheck clean"
  alongside a real type error. Replaced with a helper that reports tsc's own
  exit code.
