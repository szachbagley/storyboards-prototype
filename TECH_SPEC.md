# Storyboard Prototype — Technical Specification

**Status:** Draft v1
**Last updated:** 2026-10-15

---

## 1. Overview

A multi-user web application for generating and managing film storyboards using Google's Gemini APIs. The core idea: each account builds its own private, reusable library of **Concepts** (characters, settings, props) each anchored by a reference image and an identity description. They then compose **Frames** within **Stories**, writing a freeform scene description and attaching the relevant concepts. The system compiles a prompt from the frame description plus the attached concept descriptions, sends it to Nano Banana along with the concept reference images, and returns a rendered storyboard frame.

The reference images are the mechanism that makes a character look the same in frame 1 and frame 7. The text descriptions supplement them; they do not replace them.

This is a **rough proof-of-concept** built as a rapid AI-development exercise. Scope is deliberately minimal. See §3.

---

## 2. Tech stack

| Layer | Choice | Deployment |
|---|---|---|
| Client | React + TypeScript (Vite) | Vercel |
| API | Node + TypeScript (Express or Fastify) | Railway |
| Database | PostgreSQL (managed) | Railway |
| Object storage | Amazon S3 | AWS |
| Image generation | `gemini-3.1-flash-image` (Nano Banana 2) | Gemini API |
| Image description | `gemini-3.7-flash` | Gemini API |

**SDK:** `@google/genai` (JavaScript). Description and image generation use the
**Interactions API** (`ai.interactions.create`). Registration and Settings use
the read-only `models.list` metadata endpoint solely to check key acceptance.

---

## 3. Scope

### In scope

- Concept CRUD: name, type, reference image upload, description
- AI-generated concept descriptions from the uploaded reference image
- Story CRUD: title only
- Frame CRUD within a story: freeform description, concept attachment, ordering
- Frame image generation via Nano Banana with concept reference images attached
- Optional explicit image continuity from the selected output of one other frame in the same story, earlier or later
- Generation history per frame with a selected result and frozen source provenance
- Accounts: username, password, and a per-user Gemini API key
- Session-based authentication; each account sees only its own data

### Explicitly out of scope for v1

| Deferred | Rationale |
|---|---|
| Spend controls / quotas | Deliberately outside this prototype's scope; each account supplies its own Gemini key |
| Story-level styling | User expresses style inline in each frame description |
| Per-story aspect ratio | One global constant: 16:9 |
| Sequential frame continuity (`previous_interaction_id` chaining) | Adds order-dependence between frames |
| Concept reference canonicalization | First lever to pull if consistency disappoints |
| Export (PDF / contact sheet) | Not needed to prove the concept |

---

## 4. Domain model

### Concept

A reusable visual element. Global to the user — not scoped to a story — so the same character appears across multiple stories.

- `type` is one of `character | setting | prop`. It is **not** cosmetic. It selects the meta-prompt used to generate the description (§8.1) and it enforces the per-frame character cap (§8.3).
- `description` is **identity-only**. See §8.2 — this is the single most important content rule in the system.

### Story

A named container for an ordered sequence of frames. Carries no styling or configuration in v1.

### Frame

A single storyboard panel. Holds a freeform scene description authored by the user, an ordered set of attached concepts, a pointer to the currently selected generation, and an optional same-story source frame. Frame UUIDs survive reordering. Two frames may select each other because each generation reads only its immediate source.

### Generation

One attempt at rendering a frame. Frames accumulate generations; regenerating never destroys a previous result. Each generation stores the exact compiled prompt and a snapshot of its inputs, which makes prompt-compiler behaviour auditable after the fact.

---

## 5. Database schema

See also [server/migrations/002_identity.sql](server/migrations/002_identity.sql), which adds `users` and `sessions` and the
`user_id` columns on `concepts` and `stories`.

```sql
CREATE TYPE concept_type AS ENUM ('character', 'setting', 'prop');
CREATE TYPE generation_status AS ENUM ('pending', 'succeeded', 'failed');

CREATE TABLE concepts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  type         concept_type NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  image_key    TEXT,                      -- S3 object key; NULL until uploaded
  image_mime   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE frames (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id               UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  position               DOUBLE PRECISION NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  selected_generation_id UUID,            -- FK added after generations exists
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX frames_story_position_idx ON frames (story_id, position);

CREATE TABLE frame_concepts (
  frame_id     UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  concept_id   UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  PRIMARY KEY (frame_id, concept_id)
);
CREATE UNIQUE INDEX frame_concepts_ord_idx ON frame_concepts (frame_id, ord);

CREATE TABLE generations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id         UUID NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  status           generation_status NOT NULL DEFAULT 'pending',
  model            TEXT NOT NULL,
  compiled_prompt  TEXT NOT NULL,
  input_snapshot   JSONB NOT NULL,        -- see §5.1
  image_key        TEXT,
  interaction_id   TEXT,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX generations_frame_idx ON generations (frame_id, created_at DESC);
CREATE INDEX generations_pending_idx ON generations (created_at) WHERE status = 'pending';

ALTER TABLE frames
  ADD CONSTRAINT frames_selected_generation_fk
  FOREIGN KEY (selected_generation_id) REFERENCES generations(id) ON DELETE SET NULL;
```

Migration [003_frame_continuity.sql](server/migrations/003_frame_continuity.sql) adds nullable `frames.continuity_source_frame_id` with a self-reference check, an indexed foreign key with `ON DELETE SET NULL`, and nullable `generations.request_id`. Separate partial unique indexes enforce one pending row per frame and one row per non-null request UUID per frame. An existing duplicate-pending group aborts the migration transaction. Investigate it before retrying. Existing generation snapshots and the sweep index survive migration.

### 5.1 `input_snapshot` shape

New generation rows store a server-only V2 snapshot. `schemaVersion: 2`, `compilerVersion: "explicit-continuity-v1"` and `capturedAt` accompany the verbatim `frameDescription`, `aspectRatio`, `imageSize`, and ordered `concepts`. Each concept records its UUID, order, name, type, description, image key, MIME type and hash of the bytes sent. An imageless attachment has null image fields.

| `continuity` value | Recorded meaning |
|---|---|
| `null` | This attempt ran without a source. |
| Object | `sourceFrameId`, `sourceGenerationId`, position at capture, original storage key and SHA-256, and the attempt-owned JPEG key, MIME type and SHA-256. |

The client receives a limited historical projection. A recognized unversioned snapshot yields `legacy`, an unrecognized or malformed snapshot yields `unknown`, and valid V2 yields `known` with null or the source and generation IDs plus `sourceFrameDeleted`. Snapshots and object keys stay private. Captured IDs continue to describe an attempt after source deletion.

### 5.2 Ordering

`frames.position` is a `DOUBLE PRECISION`, not a sequence integer. Appending uses `max(position) + 1000`; inserting between two frames uses the midpoint. This avoids rewriting every downstream row on reorder.

Frame *labels* ("Frame 1", "Frame 7") are derived at render time from position order. They are not stored.

---

## 6. API surface

All routes are prefixed `/api`. Health, registration, and login are public; user-data routes require the bearer session token described in §10.

### Concepts

| Method | Path | Notes |
|---|---|---|
| `GET` | `/concepts` | List; includes presigned image URLs |
| `POST` | `/concepts` | `{ name, type }` |
| `GET` | `/concepts/:id` | |
| `PATCH` | `/concepts/:id` | `{ name?, type?, description? }` |
| `DELETE` | `/concepts/:id` | Cascades to `frame_concepts` |
| `POST` | `/concepts/:id/image` | `multipart/form-data`; see §9 |
| `POST` | `/concepts/:id/describe` | Generates a description from the reference image; returns text, does **not** persist |

`/describe` returning text without persisting is deliberate. The client decides whether to write it into the field (§12.2).

### Stories and frames

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stories` | |
| `POST` | `/stories` | `{ title }` |
| `PATCH` | `/stories/:id` | `{ title }` |
| `DELETE` | `/stories/:id` | Cascades to frames and generations |
| `GET` | `/stories/:id/frames` | Ordered by position and UUID, with selected image URL, readiness, source IDs and dependent count |
| `POST` | `/stories/:id/frames` | Appends; `{ description? }` |
| `GET` | `/frames/:id` | Includes attached concepts, history and the server boolean `continuityEnabled` |
| `PATCH` | `/frames/:id` | `{ description?, conceptIds?, position?, continuitySourceFrameId? }` |
| `DELETE` | `/frames/:id` | Exact dependent-set confirmation when referenced (§9) |

`conceptIds` is an ordered array and replaces the attachment set wholesale. Array index becomes `frame_concepts.ord`.

### Generation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/frames/:id/generate` | Optional `{ requestId, expectedContinuitySourceFrameId }`. Returns `202 { generationId }` |
| `GET` | `/frames/:id/generation-requests/:requestId` | Looks up an owned accepted request and returns its generation ID or 404. Creates no work. |
| `GET` | `/generations/:id` | Poll target; returns status and, on success, a presigned URL |
| `POST` | `/frames/:id/select-generation` | `{ generationId }` |

---

## 7. Generation pipeline

No queue, no Redis. A single API process serves multiple accounts; all user-data operations remain scoped to the authenticated owner.

1. Resolve a replay by owned frame and request UUID. Capture the current scene, ordered concept metadata and selected source generation together. Snapshot an eligible, succeeded output belonging to the selected frame. A configured source with no usable selected image gives `422 continuity_source_unusable`. A source-choice precondition mismatch gives `409 continuity_configuration_changed`.
2. Validate the reference budget, read references, prepare the independent source JPEG and compile the prompt. A missing or invalid source image gives 422. Temporary or ambiguous storage failure gives `503 reference_storage_unavailable`. These failures happen before admission and provider dispatch.
3. Lock the owned story then the destination frame, recheck admission, and insert the pending row with compiled prompt and frozen input. The owner of a confirmed commit dispatches the server-side call. The route returns `202 { generationId }`.
4. Store the output, then complete only a still-pending owned generation. First success can select the image on an as-yet unselected frame. Deletion, sweep, and uncertain finalization use guarded cleanup so a late output cannot resurrect work or remove a committed selected image.
5. The active editor polls without overlapping GETs at 2-second intervals. At 105 seconds it offers an explicit status check. The server may still finish.

### 7.1 Stale generation sweep

Railway restarts the container on deploy. Any in-flight generation is lost, but its `pending` row survives — leaving the UI spinning forever.

**On process start, and on a 60s interval:** mark every `pending` generation older than 5 minutes as `failed` with `error_code = 'abandoned'`.

This is not optional. It is the difference between a prototype that recovers from a deploy and one that requires manual database surgery.

### 7.2 Idempotency

The image API is synchronous with no task handle. A dropped connection loses the image but still bills. Two rules follow:

- The **backend** owns the Gemini call end to end. Never proxy a live Gemini request through to the browser.
- The same accepted request UUID returns the original generation, even after completion. A different request while a generation is pending receives `409 generation_in_progress` with its ID. Distinct staggered requests can both run if the first finishes before the next admission. A bodyless legacy POST has no durable replay identity. A client recovering a lost response first looks up the UUID using GET. An ambiguous commit never causes automatic dispatch or a fresh POST.

---

## 8. Gemini integration

### 8.1 Concept description generation

**Model:** `gemini-3.7-flash`, `thinking_level: "low"`.
**Input:** the concept's reference image plus a type-specific meta-prompt.
**Output:** plain text, written into the description field by the client on confirmation.

The meta-prompt differs by concept type — describing a person's costume and describing an architectural space call for different attention. The source of truth for the full prompt text is the [storyboard-prompt-compiler skill](.agents/skills/storyboard-prompt-compiler/SKILL.md); application constants are verified against it by fidelity tests.

### 8.2 The identity-only rule

**This is the most important content constraint in the system.**

A concept description must contain *only* what makes the subject recognizable across shots:

**Include** — physical appearance, costume, materials, colours, textures, wear and damage, distinguishing marks, proportions, build.

**Exclude** — pose, action, gesture, facial expression, environment, background, weather, time of day, lighting, camera angle, shot size, framing, composition, mood.

Rationale: the frame description owns all of that. A concept description that says *"A weathered astronaut standing alone on a windswept ridge of rust-colored regolith"* will fight a frame description that places the same character in a sandstorm at medium shot. The model receives two competing scenes and picks arbitrarily.

The rule is enforced in three places:
1. The description-generation meta-prompt instructs against scene content explicitly.
2. The concept description textarea placeholder states the rule.
3. The prompt compiler introduces each concept with framing that positions it as a subject, not a scene.

Setting concepts get a narrower version of the same rule: describe the place, not a shot of the place.

### 8.3 Reference image budget

The application allows four character concepts and ten total attachment slots. Every attached concept counts, including text-only concepts. One configured continuity source reserves one slot, leaving room for nine concepts. Drafts may exceed either limit. The editor displays the counts, disables Generate when over budget, and leaves all attachments and the source selected. The server enforces both limits before dispatch.

### 8.4 Prompt compilation

Output is an ordered array of Interactions API input parts. The compiled text comes first, then imaged concepts in `frame_concepts.ord` order, then the optional continuity JPEG. The source receives the next numbered reference label, including number 1 when no concept has an image. Its rules precede the verbatim Scene. Explicit target Scene instructions override conflicts with either the source or concept references. Concept references establish identity and the source supplies otherwise unspecified visual details. The compiler excludes source prompt, description, position and IDs. The no-source path preserves its original text and part ordering.

```
<FORMAT_PREAMBLE — fixed constant>

Reference image 1 — Spaceman (character): <identity-only description>
Reference image 2 — Castle (setting): <identity-only description>

Scene: <frame.description, verbatim>

<OUTPUT_CONSTRAINTS — fixed constant>
```

Rules the compiler must follow:

- **The frame description is inserted verbatim and last.** It is the user's authored intent. The compiler never paraphrases, reorders, or "improves" it.
- **Enumeration order must match image part order exactly.** If a reference image is labelled "Reference image 2" in the text, it must be the second image part. Desynchronizing these causes the model to attribute the wrong description to the wrong subject — a failure that looks like random inconsistency rather than an ordering bug, and is correspondingly hard to diagnose.
- Concepts with no reference image are listed as `Spaceman (character): <description>` with no "Reference image N" prefix, and do not consume an index.
- The compiled string is written to `generations.compiled_prompt` before the API call, not after.

`FORMAT_PREAMBLE` and `OUTPUT_CONSTRAINTS` are constants in a single module. Since v1 has no story-level styling, the preamble carries only neutral storyboard framing — the user supplies visual style inline in their frame description.

### 8.5 Request configuration

```ts
const interaction = await ai.interactions.create({
  model: "gemini-3.1-flash-image",
  input: parts,
  response_format: {
    type: "image",
    mime_type: "image/jpeg",
    aspect_ratio: "16:9",
    image_size: "1K",          // 1376 x 768
  },
});

const b64 = interaction.output_image.data;
const interactionId = interaction.id;
```

Notes:

- `image_size` is case-sensitive. `"1k"` is rejected; `"1K"` is correct.
- This project deliberately omits `temperature`, `top_p`, and `top_k`; do not add them. Historical probes recorded acceptance inside `generation_config` for both project models (see [phase 3 probe findings](phase-3-plan.md#contradicts-the-documentation)), so omission is a project policy, not a blanket claim of API rejection.
- Thinking is enabled by default on 3.1 Flash Image at `minimal` and cannot be disabled. Thinking tokens are billed.
- Every generated image carries a SynthID watermark. Worth noting in the UI if these ever leave the app.

Model IDs, the aspect ratio, and the image size live in one config module. Do not scatter string literals.

### 8.6 Error taxonomy

A boolean failure state is not sufficient here. Storyboards skew violent — the sample frame in the source wireframe reads "stands menacingly" — and safety refusals are an expected, recoverable condition that the user resolves by rephrasing. It must not read as "the app is broken."

| `error_code` | Cause | User-facing message |
|---|---|---|
| `safety_blocked` | Content policy refusal | Rephrase suggestion, prompt shown for editing |
| `rate_limited` | 429 | Automatic retry with backoff, then surface |
| `timeout` | No response within 90s | Offer retry |
| `invalid_input` | Validation failure | Specific field guidance |
| `upstream_error` | 5xx or SDK error | Offer retry |
| `abandoned` | Swept by §7.1 | Offer retry |
| `invalid_api_key` | The caller's key was rejected (401, or structured 400/403 `API_KEY_INVALID`) | Tell them to update it in Settings; retrying cannot help |
| `api_key_access_denied` | Inference returned 403 without `API_KEY_INVALID` | Check key restrictions, project eligibility and billing in AI Studio |

`rate_limited` is the only code that auto-retries — twice, with exponential backoff.

---

## 9. Object storage

One private bucket stores three kinds of object.

```
concepts/{conceptId}/reference.jpg
generations/{generationId}.jpg
generations/{generationId}/continuity.jpg
```

**Uploads go through the backend**, not via presigned PUT. One code path, no bucket CORS configuration, and — most usefully — a place to run `sharp` before storing.

**Preprocessing on concept upload:**
- Resize so the long edge is at most 1024px
- Convert to JPEG at quality 85
- Strip EXIF

This is not cosmetic. Reference images gain nothing from being 12 megapixels, and downscaling cuts both the per-call token cost and the upload latency on every subsequent generation that includes the concept.

**Reads** are served via presigned GET URLs with a 1-hour expiry, generated when the API returns a record. The bucket stays private.

### 9.1 Continuity inputs

A source-backed attempt stages one private JPEG at
`generations/{candidateGenerationId}/continuity.jpg`. The candidate generation
UUID is distinct for every preflight, even when requests share an idempotency
UUID. The staged copy uses the existing 1024px, quality-85 JPEG preprocessing.
Preflight records SHA-256 of the downloaded original bytes and the transformed
bytes actually prepared as a reference; a hash is provenance, not a retained
image or a replay endpoint. Reference reads and the candidate PUT share a
30-second deadline, SDK abort signal, and a maximum ten-attachment fanout.
Authoritative S3 NoSuchKey/404 means missing; access denial, transport errors,
5xx, and timeouts mean storage unavailable. No fallback to no continuity is
allowed when a configured source fails preflight.

Only a candidate with known copy ownership and proven uncommitted admission
may delete its own staged key. An unacknowledged conditional PUT is preserved:
even a 5xx may precede evaluation of the write-if-absent condition and cannot
prove ownership of an existing key. A process crash before insert, an ambiguous
PUT, or failed cleanup may leave a private orphan requiring separately
approved inventory/reconciliation. An uncertain SQL admission must preserve
the object until ownership is established. Existing concept uploads still
overwrite `concepts/{conceptId}/reference.jpg` in place. A metadata capture
followed by that overwrite can pair an earlier description with later image
bytes, so concept images remain non-replayable despite recorded byte hashes.
The retention and deletion contract for these inputs is described below.

---

### Source selection and retention

An owned frame may reference another frame in its story, including a later
frame. PATCH omission preserves the choice and null clears it. The server
captures the source selection, destination scene and ordered concept metadata
in one read. After the capture, a different source selection or edit applies to
the next attempt. An expected source UUID (or explicit null) that differs at
capture returns 409 before storage access. A request token already accepted
for the same owned frame returns its original generation, including a terminal
one. GET `/frames/:id/generation-requests/:requestId` looks it up without
starting work. Compare the current source and its selected generation IDs with
known historical provenance to detect a changed reference.

After reference preflight, admission locks story then destination and inserts
the pending row before dispatch. Different tokens can admit again once the
first attempt completes. A bodyless POST lacks durable replay identity.
Crashing after commit can leave an abandoned row. A lost commit acknowledgement
preserves the private copy without dispatch, so there is no exactly-once billing
guarantee. An ambiguous copy PUT or failed cleanup can leave a private orphan.

The approved retention rule covers every accepted attempt, including failures.
Keep its private input after source deletion, until its destination frame or
story is deleted. No bucket expiry rule may remove a live target’s retained inputs. Verify lifecycle compatibility before enabling the feature. Delete by consuming generation ownership. The private copy survives deletion of the original source and is never exposed as a downloadable historical input.

### Confirming deletion and cleaning up retained inputs

An unconfirmed `DELETE /frames/:id` succeeds when no other frame references it.
Otherwise the server returns `409 continuity_source_in_use` with the current
`referencedByCount` and `referenceSetToken`. The token is the lowercase SHA-256
of the sorted dependent UUIDs joined with LF. After reviewing the consequences,
send `?confirmContinuity=true&referenceSetToken=<token>`. If membership changed,
even to an empty set or a different set of the same size, the server returns an
updated challenge. Each challenge requires an explicit decision.

Deletion locks the owned story and source, checks the set, clears incoming
source links and updates those frames' timestamps in the same transaction.
Historical outputs and frozen inputs on surviving frames remain available.
Accepted work may still complete and bill. A frame or story deletion collects
its generations' outputs and valid V2 inputs under the story lock, including
inputs of failed or pending attempts. Only a copy key matching that generation's
own derived key is eligible. Individual object deletes follow commit. A failed
object delete or lost commit acknowledgement may leave a private orphan.

## 10. Authentication

Accounts with username and password. Sessions are opaque bearer tokens.

- `POST /auth/register` takes `{ username, password, geminiApiKey }`. A
  non-generative metadata check confirms Gemini accepts the key before the
  account is created. Model access is checked only when generation runs.
- `POST /auth/login` returns `{ token, user }`. The token is 32 random bytes,
  base64url-encoded, sent as `Authorization: Bearer <token>`.
- Sessions are stored as `sha256(token)` in a `sessions` table, so a database
  dump yields no live sessions. They are revocable, unlike a JWT: sign-out
  deletes the row and a password change deletes every other session for that
  user.
- Absolute expiry of `SESSION_TTL_DAYS` (30). Expired rows are removed by the
  existing sweeper.
- Passwords are hashed with `scrypt` (`N=16384, r=8, p=1`), a 16-byte random
  salt, stored self-describing as `scrypt$N$r$p$salt$hash`, and compared with
  `crypto.timingSafeEqual`.
- After `MAX_LOGIN_ATTEMPTS` (10) consecutive failures an account locks for
  `LOGIN_LOCKOUT_MINUTES` (15). An unknown username, a wrong password and a
  locked account all return the same message, so the endpoint is not a username
  oracle.
- Registration is open unless `SIGNUP_CODE` is set, in which case it is required.

### 10.1 Data ownership

`concepts` and `stories` carry a `user_id`. Frames and generations are scoped
transitively — frame → story → user — so the owner has exactly one source of
truth and cannot drift out of sync.

Another account's row returns `404`, never `403`: a `403` would confirm the id
exists and turn every endpoint into an existence oracle.

### 10.2 The per-user Gemini key

Each account supplies its own key, encrypted at rest with AES-256-GCM under the
server's `ENCRYPTION_KEY`. It is decrypted only at the call site in
`services/gemini.ts`, never written to `input_snapshot`, never logged, and never
returned by any endpoint — `GET /auth/me` exposes only `hasGeminiKey` and a
4-character hint.

Registration and Settings check a candidate key using Google's read-only
[`GET /v1beta/models?pageSize=1`](https://ai.google.dev/api/models) before
encrypting or saving it. HTTP 200 with well-formed JSON confirms only that
Gemini accepts the key. It does **not** establish project tier eligibility,
billing readiness, inference availability, or access to either application
model; Google [documents this limitation](https://ai.google.dev/gemini-api/docs/troubleshooting).
The UI states it, and generation/description errors surface model-access
failures when they occur. An HTTP 400 is an invalid-key response only when its
structured ErrorInfo reason is `API_KEY_INVALID`; other 400s can indicate a
request error. Permission, rate-limit, timeout, and upstream failures return
safe, distinct guidance. A failed check leaves any previously saved encrypted
key unchanged. The check has a 20s application deadline, aborts its transport
on expiry, and makes no automatic retries. The timer is cleared on settlement.
An upstream HTTP 503 is returned as a safe HTTP 503; no candidate key is saved.
Timeouts before headers or while reading the response body return HTTP 504. Server logs never include the
candidate key or raw upstream response body.
On a deadline, a safe server log records the last transport stage and when it
was reached: socket assignment, DNS, TCP, TLS, request finish, or response
headers. A request-finish event means Node handed the bytes to the operating
system; it does not prove Gemini received the request. These stage markers
distinguish a connection or TLS stall from waiting for an upstream response
without logging key material, response bodies, or network addresses.

Account key acceptance uses a dedicated direct GET to the
[`v1beta/models` metadata endpoint](https://ai.google.dev/api/models), with
`pageSize=1` and no generation. It rejects redirects and caps response bodies
at 1 MiB. This narrow exception to SDK usage uses Node
HTTPS to own the request and response streams explicitly, destroys both on
abort/overflow, and removes its abort listener when settled. The SDK 2.17.1
request-cloning path lost abort propagation after garbage collection in
loopback probes on Node 24.19.0 and 22.23.2. Direct fetch also failed body
cancellation on Node 22.23.2. Native HTTPS avoids those controller chains;
the full transport matrix passes on both runtimes with forced collection.
Generation and description still use the SDK; no SDK or runtime upgrade is
included. The earlier failing SDK fixture is preserved in commit `98abf303`.

After building, `server/scripts/verify-key17-transport.mjs` exercises key acceptance
over loopback HTTP, including the full 20s deadline, direct transport settlement,
abort dispatch, body cancellation, oversized responses and redirect rejection.
`server/scripts/verify-key17-app.mjs` verifies encrypted persistence using its
disposable PostgreSQL fixture (`KEY17_TEST_DATABASE_URL`). Run both with
`node --import ./server/scripts/offline-network-guard.mjs` before the script path;
add `--expose-gc` for the transport fixture to force collection while requests
are pending. They refuse to run without the guard and use only dummy keys.
Cancellation checks observe unfinished HTTP/1.1 responses closing, not every
pooled socket: idle keep-alive connections may remain/reopen. Raw transport
promises must reject without relying on the application's deadline race.

These offline checks do not establish live key acceptance or inference access.
The earlier production failures occurred during the completed-generation check:
an upstream HTTP 503 and a separate 20s deadline. The metadata path has not
been verified against a live key.

Losing `ENCRYPTION_KEY` makes every stored key unrecoverable; users would have
to re-enter them.

---

## 11. Configuration

| Variable | Location | Notes |
|---|---|---|
| `DATABASE_URL` | API | Railway-provided |
| `ENCRYPTION_KEY` | API | 32 bytes base64; encrypts each user's Gemini key at rest |
| `SIGNUP_CODE` | API | Optional; when set, registration requires it |
| `AWS_ACCESS_KEY_ID` | API | |
| `AWS_SECRET_ACCESS_KEY` | API | |
| `AWS_REGION` | API | |
| `S3_BUCKET` | API | |
| `CONTINUITY_ENABLED` | API only | Literal `true` enables source selection and admission. Omitted or literal `false` keeps them closed. Other values reject startup. |
| `VITE_API_BASE_URL` | Client | Railway API origin |

There is no server-wide Gemini key. Each request uses the caller's own key, decrypted server-side; stored keys are never returned to the client, and all Gemini traffic originates from the Railway backend. Users submit their own keys through registration or Settings.

Application constants (model IDs, `ASPECT_RATIO = "16:9"`, `IMAGE_SIZE = "1K"`, `MAX_CHARACTER_CONCEPTS = 4`, `MAX_TOTAL_CONCEPTS = 10`, `POLL_INTERVAL_MS = 2000`) live in a single shared module, not in environment variables — they are code, not deployment config.

---

## 12. Client

### 12.1 Routes

| Route | View |
|---|---|
| `/login` | Username and password sign-in |
| `/register` | Account creation with username, password, Gemini key, and optional invite code |
| `/settings` | Update password or Gemini key |
| `/concepts` | Concept grid with a leading "+" tile |
| `/concepts/:id` | Reference image, upload control, description textarea, "Generate Description" |
| `/stories` | Story grid with a leading "+" tile |
| `/stories/:id` | Frame grid in position order, trailing "+" tile |
| `/stories/:id/frames/:frameId` | Generated image, description textarea, concept picker, "Generate Frame" |

Top-level navigation is two tabs — Concepts and Stories — persistent across all authenticated views.

### 12.2 Description overwrite behaviour

"Generate Description" writes directly into the field **only when the field is empty**. When the field has content, show a confirmation before replacing it.

The endpoint returns text without persisting (§6), so the client holds the returned draft and only commits on confirmation. A user who has hand-tuned a description should never lose it to a misclick.

### 12.3 Generation states

The frame view renders four distinct states: idle, generating (with elapsed timer — 10 to 40 seconds is normal and silence reads as failure), succeeded, and failed. The failed state renders the message from the §8.6 taxonomy alongside a retry action, and for `safety_blocked` keeps the description editable in place.

### 12.4 Generation history

The frame view lists prior generations as thumbnails. Selecting one sets `selected_generation_id`. Regenerating never replaces the current image — it appends. This matters because the core loop of the app is generate-until-good, and a worse result overwriting a better one with no undo is the most likely source of user frustration.

### 12.5 Source selection and request recovery

The frame detail capability controls the picker. Only `continuityEnabled === true` enables new selection. False or an omitted field means unavailable. A configured source remains visible when unavailable and can be explicitly cleared. The picker offers None and every other frame in the story. Current position determines earlier/later labels. Thumbnails, excerpts and readiness distinguish eligible frames from those without usable selected output. An unusable current choice remains visible until explicitly changed. Metadata readiness does not prove the source object is readable at generation time.

The selected output and each history item compare the frozen pair of source frame and generation UUIDs with the current pair. A match only describes the source selection. A changed source, newly selected source output, deleted source, known absence, legacy generation or unknown snapshot has its own indication. Reorder preserves identity. Focus, manual refresh and relevant changes update the last fetched view. None triggers generation.

The account- and frame-keyed editor preserves dirty fields across refreshes. Blur, source/attachment changes and Generate share a save queue. Generate saves the clicked scene and source together, then sends that source as the admission precondition. A rejected save or changed configuration preserves the draft for review. Admission temporarily disables editing. After acceptance a draft edit applies to a later request.

A new intent gets a UUID after successful saves. The client stores only outstanding IDs in account/frame-scoped tab session storage. A lost response or reload uses GET to check acceptance. A 404 allows explicit same-UUID resubmission after saving. The first admitted inputs win. Storage failure warns that reload recovery may be unavailable. A known terminal failure permits an explicit new attempt. Account change and navigation fence stale reads and polls. Separate tabs still use last-write-wins editing.

---

## 13. Build order

1. Schema, migrations, config module, auth middleware
2. Concepts CRUD + S3 upload with `sharp` preprocessing
3. Description generation endpoint and meta-prompts
4. Stories and frames CRUD, ordering, concept attachment
5. Prompt compiler as a **pure, unit-tested function** — inputs to string plus part array, no I/O
6. Generation pipeline, stale sweep, error classification
7. Client views in route order above

For explicit continuity, the dependency order is additive admission schema → owned storage and preflight → pure compiler and budget → source API and provenance → confirmed deletion and cleanup → editor save/recovery lifecycle → picker and history. [Pinned implementation plan](https://github.com/szachbagley/storyboards-prototype/blob/892283f9876a53e36ef52908fb985de4ce5c9efb/continuity-plan.md)

**Release and backout.** Before a production rollout, verify backup and bucket retention, stop generation ingress, drain accepted work, inspect duplicate pending rows, apply the additive migration and deploy one compatible writer. Smoke no-source and source-aware clients using offline fixtures, release the client, and enable the server capability only after verification and release approval. For backout, disable new source selection/admission and keep the compatible server available for existing configurations and deletion. Preserve additive columns, indexes and snapshots. If reverting to a writer that cannot recognize continuity, keep ingress and incompatible deletions paused until compatibility is restored or live pointers and retained inputs have been explicitly reconciled. Migration tracking rows must continue to reflect the applied schema.

Step 5 before step 6 is deliberate. The compiler is the interesting surface of this exercise and it is the one component that is cheap to test in isolation and expensive to debug through a live API.

---

## 14. Testing

Minimal but non-zero. Five areas justify tests in a prototype this size, as specified in [AGENTS.md](AGENTS.md#testing):

- **Prompt compiler** — enumeration order matches part order; missing-image concepts are handled; frame description passes through verbatim and unmodified.
- **Validation** — character and total concept caps.
- **Position arithmetic** — insert between, append, reorder.
- **Prompt fidelity** — description meta-prompts and frame prompt constants remain byte-identical to the storyboard-prompt-compiler skill.
- **Credential handling** — password hash/verify, session token generation/hashing, and Gemini key encrypt/decrypt.

Verify isolation, concurrent admission, source deletion and late completion with the two-account HTTP/SQL matrix on a disposable PostgreSQL database. Stub S3, key validation, description and generation, and preload the offline transport guard before importing the app. Exercise the editor with fixture HTTP responses, including lost submissions, delayed reads and manual recovery. Any paid visual-quality trial requires separate approval of its inputs, model, account and budget. The fixture verifies request construction, state and bytes. It cannot establish real model fidelity or production bucket lifecycle behavior.

The following commands run from the repository root after `npm run build`. Set `PACKAGE1_TEST_DATABASE_URL` to a dedicated loopback PostgreSQL database named `storyboards_pkg1_test`. The scripts recreate their own fixture schemas.

```sh
node server/scripts/verify-offline-network-guard.mjs
node --import ./server/scripts/offline-network-guard.mjs server/scripts/verify-package1.mjs
node --import ./server/scripts/offline-network-guard.mjs server/scripts/verify-package2-storage.mjs
node --import ./server/scripts/offline-network-guard.mjs server/scripts/verify-package1-app.mjs
node --import ./server/scripts/offline-network-guard.mjs server/scripts/verify-package1-app.mjs --continuity
```

**Package 7 server rehearsal.** On disposable PostgreSQL 17.11, the SQL fixture rolled back duplicate-pending migration failure, preserved original rows and JSON, and verified request/pending uniqueness, owner isolation and sweep/finalization races. Both HTTP modes successfully applied all migrations to a clean fixture schema. Create, GET, PATCH and generation selection returned the correct capability. Isolated imports of the compiled boot configuration confirmed that omission and `false` close the gate, `true` opens it, and `1`, `TRUE` and an empty value reject startup. With the gate closed an existing source survived rejection and zero calls were dispatched for that attempt. With it open, the matrix checked original bytes, staged copies, concurrent admissions, exact-set deletion, both lock orders, late output cleanup and isolation of one injected cleanup failure. The closed and open HTTP runs made 12 and 17 stub generation calls respectively, each with two stub key validations and one stub description. The storage matrix made 77 stub S3 calls. All reported zero real outbound calls. The transport self-test denied non-loopback TCP, TLS, HTTPS and fetch. Production schema, bucket rules, historical replay and model quality remain outside this evidence.

For browser checks, build the client with `VITE_API_BASE_URL=http://mock.invalid` and serve its preview on loopback. Set `UI_ORIGIN` to the preview origin and `CHROMIUM_PATH` to the local Chromium executable. With Playwright available, run each fixture from the repository root:

```sh
node client/scripts/verify-continuity-picker.cjs
node client/scripts/verify-editor-lifecycle.cjs
node client/scripts/verify-legacy-frame.cjs
```

**Package 7 browser verification.** All 12 picker scenarios, the editor lifecycle matrix and all five legacy variants passed on the production build with fixture HTTP responses. Cases included enabling, disabling and omitting the capability, selecting a later frame by keyboard, saving immediately before Generate, refresh during an edit, over-budget drafts, changed and deleted source provenance, equal-count deletion reconfirmation, and explicit retry after a storage failure with zero initial dispatches. The typecheck, build and all 116 unit tests passed. The desktop and mobile fixtures verified a loaded source thumbnail and no horizontal overflow. Set `SCREENSHOT_DIR` to choose where the picker fixture writes its screenshots. [Desktop at 1280px](docs/verification/issue-14/desktop-picker.png) · [Mobile at 390px](docs/verification/issue-14/mobile-picker.png)


---

## 15. Open questions

- **Interaction ID lifetime.** `generations.interaction_id` is stored for forward compatibility with `previous_interaction_id` chaining (a natural v2 feature for "same frame, warmer light"). How long Google keeps these valid is undocumented — verify before building anything that depends on it.
- **Concept deletion with existing generations.** Currently cascades the attachment while past generations retain the concept in their `input_snapshot`. Acceptable, but confirm the frame view degrades cleanly.
