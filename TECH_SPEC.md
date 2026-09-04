# Storyboard Prototype — Technical Specification

**Status:** Draft v1
**Last updated:** 2026-08-18

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

**SDK:** `@google/genai` (JavaScript). All Gemini calls go through the **Interactions API** (`ai.interactions.create`), which is the currently recommended surface.

---

## 3. Scope

### In scope

- Concept CRUD: name, type, reference image upload, description
- AI-generated concept descriptions from the uploaded reference image
- Story CRUD: title only
- Frame CRUD within a story: freeform description, concept attachment, ordering
- Frame image generation via Nano Banana with concept reference images attached
- Generation history per frame with a selected result
- Accounts: username, password, and a per-user Gemini API key
- Session-based authentication; each account sees only its own data

### Explicitly out of scope for v1

| Deferred | Rationale |
|---|---|
| Spend controls / quotas | Single trusted user |
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

A single storyboard panel. Holds a freeform scene description authored by the user, an ordered set of attached concepts, and a pointer to the currently selected generation.

### Generation

One attempt at rendering a frame. Frames accumulate generations; regenerating never destroys a previous result. Each generation stores the exact compiled prompt and a snapshot of its inputs, which makes prompt-compiler behaviour auditable after the fact.

---

## 5. Database schema

See also `002_identity.sql`, which adds `users` and `sessions` and the
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

### 5.1 `input_snapshot` shape

Concepts are mutable and shared. Without a snapshot, editing a concept description silently invalidates the provenance of every frame already generated from it.

```jsonc
{
  "frameDescription": "Spaceman stands menacingly on a red planet...",
  "aspectRatio": "16:9",
  "imageSize": "1K",
  "concepts": [
    {
      "id": "uuid",
      "ord": 0,
      "name": "Spaceman",
      "type": "character",
      "description": "<description as it read at generation time>",
      "imageKey": "concepts/uuid/reference.jpg"
    }
  ]
}
```

### 5.2 Ordering

`frames.position` is a `DOUBLE PRECISION`, not a sequence integer. Appending uses `max(position) + 1000`; inserting between two frames uses the midpoint. This avoids rewriting every downstream row on reorder.

Frame *labels* ("Frame 1", "Frame 7") are derived at render time from position order. They are not stored.

---

## 6. API surface

All routes are prefixed `/api` and require the auth header described in §10.

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
| `GET` | `/stories/:id/frames` | Ordered by position; includes selected generation URL |
| `POST` | `/stories/:id/frames` | Appends; `{ description? }` |
| `GET` | `/frames/:id` | Includes attached concepts and generation history |
| `PATCH` | `/frames/:id` | `{ description?, conceptIds?, position? }` |
| `DELETE` | `/frames/:id` | |

`conceptIds` is an ordered array and replaces the attachment set wholesale. Array index becomes `frame_concepts.ord`.

### Generation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/frames/:id/generate` | Returns `202` with `{ generationId }` |
| `GET` | `/generations/:id` | Poll target; returns status and, on success, a presigned URL |
| `POST` | `/frames/:id/select-generation` | `{ generationId }` |

---

## 7. Generation pipeline

No queue, no Redis. Single user, single process.

1. `POST /frames/:id/generate` loads the frame with its concepts, validates (§8.3), compiles the prompt (§8.4), inserts a `generations` row with `status='pending'` and the compiled prompt and snapshot already written.
2. The handler returns `202 { generationId }` immediately and fires the Gemini call without awaiting it.
3. On success: decode the base64 image, `PutObject` to S3, update the row to `succeeded` with `image_key` and `interaction_id`, set `completed_at`. If the frame has no `selected_generation_id`, set it to this generation.
4. On failure: update to `failed` with a classified `error_code` (§8.6).
5. The client polls `GET /generations/:id` every 2s, with a client-side ceiling of 90s before showing a timeout state.

### 7.1 Stale generation sweep

Railway restarts the container on deploy. Any in-flight generation is lost, but its `pending` row survives — leaving the UI spinning forever.

**On process start, and on a 60s interval:** mark every `pending` generation older than 5 minutes as `failed` with `error_code = 'abandoned'`.

This is not optional. It is the difference between a prototype that recovers from a deploy and one that requires manual database surgery.

### 7.2 Idempotency

The image API is synchronous with no task handle. A dropped connection loses the image but still bills. Two rules follow:

- The **backend** owns the Gemini call end to end. Never proxy a live Gemini request through to the browser.
- `POST /frames/:id/generate` rejects with `409` if the frame already has a `pending` generation. This prevents double-fire from an impatient double-click.

---

## 8. Gemini integration

### 8.1 Concept description generation

**Model:** `gemini-3.7-flash`, `thinking_level: "low"`.
**Input:** the concept's reference image plus a type-specific meta-prompt.
**Output:** plain text, written into the description field by the client on confirmation.

The meta-prompt differs by concept type — describing a person's costume and describing an architectural space call for different attention. Full prompt text lives in the `nano-banana-prompts` skill, not inline in application code.

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

`gemini-3.1-flash-image` supports character resemblance for up to **4 characters** and high-fidelity inclusion for up to **10 objects**, with 14 reference images total.

Validation on `POST /frames/:id/generate`:

- At most 4 concepts of type `character` → `422` with a clear message
- At most 10 concepts total → `422`
- Concepts with a `NULL` `image_key` are included by description only, and the compiler omits their reference-image line

The frame editor should surface remaining character slots rather than letting a user attach nine and receive slop.

### 8.4 Prompt compilation

Output is an ordered array of Interactions API input parts. Text first, then image parts **in `frame_concepts.ord` order**.

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
- Gemini 3.x models do **not** accept `temperature`, `top_p`, or `top_k`. Sending them errors.
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
| `invalid_api_key` | The caller's own Gemini key was rejected (401/403) | Tell them to update it in Settings; retrying cannot help |

`rate_limited` is the only code that auto-retries — twice, with exponential backoff.

---

## 9. Object storage

Two classes of object, one bucket:

```
concepts/{conceptId}/reference.{ext}
generations/{generationId}.jpg
```

**Uploads go through the backend**, not via presigned PUT. One code path, no bucket CORS configuration, and — most usefully — a place to run `sharp` before storing.

**Preprocessing on concept upload:**
- Resize so the long edge is at most 1024px
- Convert to JPEG at quality 85
- Strip EXIF

This is not cosmetic. Reference images gain nothing from being 12 megapixels, and downscaling cuts both the per-call token cost and the upload latency on every subsequent generation that includes the concept.

**Reads** are served via presigned GET URLs with a 1-hour expiry, generated when the API returns a record. The bucket stays private.

---

## 10. Authentication

Accounts with username and password. Sessions are opaque bearer tokens.

- `POST /auth/register` takes `{ username, password, geminiApiKey }`. The key is
  validated against Gemini before the account is created, so a typo is caught in
  the form rather than on the first generation.
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
| `VITE_API_BASE_URL` | Client | Railway API origin |

There is no server-wide Gemini key. Each request uses the caller's own key, decrypted server-side; no key is ever exposed to the client, and all Gemini traffic originates from the Railway backend.

Application constants (model IDs, `ASPECT_RATIO = "16:9"`, `IMAGE_SIZE = "1K"`, `MAX_CHARACTER_CONCEPTS = 4`, `MAX_TOTAL_CONCEPTS = 10`, `POLL_INTERVAL_MS = 2000`) live in a single shared module, not in environment variables — they are code, not deployment config.

---

## 12. Client

### 12.1 Routes

| Route | View |
|---|---|
| `/login` | Secret entry |
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

---

## 13. Build order

1. Schema, migrations, config module, auth middleware
2. Concepts CRUD + S3 upload with `sharp` preprocessing
3. Description generation endpoint and meta-prompts
4. Stories and frames CRUD, ordering, concept attachment
5. Prompt compiler as a **pure, unit-tested function** — inputs to string plus part array, no I/O
6. Generation pipeline, stale sweep, error classification
7. Client views in route order above

Step 5 before step 6 is deliberate. The compiler is the interesting surface of this exercise and it is the one component that is cheap to test in isolation and expensive to debug through a live API.

---

## 14. Testing

Minimal but non-zero. Three areas justify tests in a prototype this size:

- **Prompt compiler** — enumeration order matches part order; missing-image concepts are handled; frame description passes through verbatim and unmodified.
- **Validation** — character and total concept caps.
- **Position arithmetic** — insert between, append, reorder.

Everything else is exercised by using the app.

---

## 15. Open questions

- **Interaction ID lifetime.** `generations.interaction_id` is stored for forward compatibility with `previous_interaction_id` chaining (a natural v2 feature for "same frame, warmer light"). How long Google keeps these valid is undocumented — verify before building anything that depends on it.
- **Concept deletion with existing generations.** Currently cascades the attachment while past generations retain the concept in their `input_snapshot`. Acceptable, but confirm the frame view degrades cleanly.
