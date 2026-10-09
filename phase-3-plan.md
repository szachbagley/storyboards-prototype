# Phase 3 Plan — Description Generation Endpoint and Meta-Prompts

> Historical implementation record. References to `CLAUDE.md` and `.claude/skills/` describe the original layout. For current contribution instructions, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the skills linked from AGENTS.md.

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 3
**Depends on:** phase 1 (config, auth), phase 2 (concepts, S3) — both complete
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

Phase 3 adds one endpoint — `POST /concepts/:id/describe` — and the type-specific
meta-prompts behind it. It is the project's first Gemini call.

Small in surface area, disproportionately important in consequence. The
meta-prompt is **the first of the three places the identity-only rule is
enforced** (`TECH_SPEC.md` §8.2). A meta-prompt that drifts produces descriptions
containing pose, lighting, or environment, which then fight every frame
description they are compiled against — and that failure surfaces as "the model
is inconsistent," never as an error.

**Phase 3 is done when all of the following are true:**

1. `GEMINI_API_KEY` is required in `env.ts` and the server fails fast without it.
2. The Interactions API surface has been **verified empirically**, not assumed —
   `ai.interactions.create` exists, accepts the documented request shape, and the
   response is read from the documented accessor.
3. The three meta-prompts and the shared preamble exist in one server module,
   transcribed **verbatim** from the `storyboard-prompt-compiler` skill, with a
   **committed test** proving byte equality against the skill — and that test
   demonstrated to fail when a constant is mutated.
4. `POST /api/concepts/:id/describe` returns `200 { description }` for a concept
   that has a reference image.
5. The endpoint **does not persist** the description (`TECH_SPEC.md` §6).
6. A concept with no reference image returns `422 no_reference_image`.
7. Upstream failures are classified into the §8.6 taxonomy and never surface as a
   raw upstream message or a bare `500`.
8. `rate_limited` auto-retries twice with backoff; nothing else retries.
9. A hung upstream call is bounded by a deadline rather than holding the
   connection open indefinitely.
10. Typecheck clean; the five phase 1 auth tests and the new meta-prompt
    fidelity tests all pass.

**Not in phase 3:** stories, frames, the prompt compiler, image generation, and
every client view — including the "Generate Description" button and the
overwrite-confirmation flow of §12.2, which are phase 7.

---

## 2. Decisions

### 2.1 Verify the API surface before writing against it

The Interactions API post-dates this model's training data, and the
`gemini-nano-banana` skill exists precisely because pre-2026 recollection is
wrong about the package, the call, and every model ID.

**The first execution step is a throwaway probe**, not application code: install
`@google/genai`, call `ai.interactions.create` with the documented image-
understanding shape, and print the raw response structure. Everything downstream
is written against what the probe returns.

The probe also answers questions the skill does not:

- Does the SDK accept an `AbortSignal` or a per-request timeout?
- What does a **safety refusal** look like — a thrown error, or a response with
  empty `output_text`?
- What shape does an HTTP error take (status code on the error object, or only a
  message)?

Those three answers determine §2.6 and §2.7. Guessing them and discovering the
truth through production failures is the expensive path.

The supplied key also has an unfamiliar prefix (`AQ.` rather than the older
`AIza`). The probe confirms it authenticates before any application code depends
on it.

### 2.2 Model and request configuration

Per the skill and `TECH_SPEC.md` §8.1:

```ts
const interaction = await ai.interactions.create({
  model: DESCRIPTION_MODEL,               // "gemini-3.7-flash"
  input: [
    { type: "text", text: metaPrompt },
    { type: "image", mime_type: "image/jpeg", data: base64 },
  ],
  generation_config: { thinking_level: DESCRIPTION_THINKING_LEVEL },  // "low"
});
const text = interaction.output_text;
```

Constraints that produce hard errors and must not be "improved":

- **No `temperature`, `top_p`, or `top_k`.** Gemini 3.x rejects them outright.
- **`thinking_level` must be `low`, `medium`, or `high` on `gemini-3.7-flash`.**
  `"minimal"` is valid on the image model but **rejected** here. The constant is
  already `"low"` in `shared/config.ts`; do not inline a literal.
- **Text part before image part.** Part order is semantically meaningful. The
  meta-prompt refers to "this image", so the image follows the instruction.

Both model ID and thinking level come from `shared/config.ts` (invariant 9).
No string literals at the call site.

### 2.3 Where the meta-prompts live

`TECH_SPEC.md` §8.1 says the prompt text "lives in the skill, not inline in
application code." A skill is documentation for the agent, not a runtime
artifact — `.claude/` is not deployed and must never be read at runtime.

**Decision:** the prompts live in one server module,
`server/src/services/descriptionPrompts.ts`, transcribed verbatim from the
`storyboard-prompt-compiler` skill, with a header comment naming that skill as
the source of truth. This satisfies the spec's actual intent — one module, no
literals scattered through call sites — while keeping the application
self-contained.

> Note: §8.1 refers to a `nano-banana-prompts` skill. No such skill exists; the
> meta-prompts are in `storyboard-prompt-compiler`. Flagged during the phase 1
> review; transcribing from the correct file.

**Transcription is mechanical, not manual.** The blocks are extracted from
`SKILL.md` programmatically and the resulting module is then diffed against the
skill to prove byte equality — the same technique that proved `001_init.sql`
identical to `TECH_SPEC.md` §5. Hand-typing risks silently dropping a clause
like "Do NOT describe: pose, action, gesture..." — which is the whole point of
the prompt.

Extraction was rehearsed while writing this plan and is deterministic: the
shared preamble is 661 characters and the three type blocks are 466
(`character`), 455 (`setting`) and 390 (`prop`). The only non-ASCII character
anywhere in them is the em-dash `—`, which appears in the `character` and
`setting` blocks; British spellings such as `colours` must also survive
unchanged.

Module shape:

```ts
export const SHARED_PREAMBLE: string;
export const META_PROMPT_BY_TYPE: Record<ConceptType, string>;
export function buildDescriptionPrompt(type: ConceptType): string;
```

`buildDescriptionPrompt` joins preamble and type block with a blank line. Nothing
else — no interpolation of the concept name, which would invite the model to
describe a name rather than an image.

### 2.4 The precondition: no image, no description

A concept whose `image_key` is `NULL` cannot be described — there is nothing to
look at. Return `422` with code `no_reference_image` and a message that says to
upload a reference image first.

This is not a formality. The compiler skill's debugging section names a missing
reference image as **the most common cause of character drift by a wide margin**.
Failing loudly here is better than returning a description hallucinated from a
name.

### 2.5 Response shape and non-persistence

```
POST /api/concepts/:id/describe   ->  200 { "description": "..." }
```

No request body. The description is **returned, not written** — §6 is explicit,
and §12.2 explains why: the client holds the draft and only commits it on
confirmation, so a hand-tuned description is never lost to a misclick. Phase 3
must not add a convenience "persist=true" flag; the phase 7 client uses `PATCH`.

**Output post-processing is limited to `.trim()`.** The meta-prompt already
instructs the model to emit only the description, with no preamble and no
commentary. Stripping quotes, code fences, or "Here is..." prefixes is
speculative until a real response shows it is needed. If the probe or manual runs
show wrappers, revisit — but do not pre-build a cleanup pass for a problem that
may not exist.

An empty or whitespace-only response is treated as `upstream_error`, not as a
valid empty description.

### 2.6 Deadline

Describe is synchronous from the client's perspective, unlike generation. A hung
upstream call would hold the connection indefinitely.

**New constant: `DESCRIBE_DEADLINE_MS = 30_000`** in `shared/config.ts`. Text
description on 3.7-flash at `thinking_level: "low"` should take a few seconds;
30s is generous headroom without being a hang.

This is a *total* budget covering retries, matching the reasoning behind
`GENERATION_DEADLINE_MS` in phase 1 — a per-attempt timeout multiplies under
retry and makes the worst case unpredictable.

Implementation depends on the probe: prefer a native `AbortSignal` if the SDK
accepts one. If it does not, fall back to `Promise.race` against a timer, and
**document that the losing request still runs and still bills** — `Promise.race`
does not cancel work. Acceptable here because a text call is cheap; it would not
be acceptable for image generation, which phase 6 must handle more carefully.

### 2.7 Error classification

Never surface a raw upstream error (`CLAUDE.md`; skill). Classification lives in
`server/src/services/geminiErrors.ts` as a pure function so phase 6 reuses it for
generations rather than reinventing the taxonomy.

| Upstream condition | `GenerationErrorCode` | HTTP | Retry |
|---|---|---|---|
| Content policy refusal | `safety_blocked` | `422` | no |
| HTTP 429 | `rate_limited` | `429` | **yes, twice** |
| Deadline exceeded | `timeout` | `504` | no |
| HTTP 4xx other than 429 | `invalid_input` | `502` | no |
| HTTP 5xx or SDK throw | `upstream_error` | `502` | no |

Two points on the mapping:

- **`invalid_input` maps to `502`, not `400`.** A malformed request to Gemini is
  *our* bug, not the caller's. Returning `400` would blame the client for a
  server defect. The code stays `invalid_input` per §8.6 so the taxonomy is
  intact; only the HTTP status reflects who is at fault.
- **`safety_blocked` is `422`, not `500`.** §8.6 is emphatic: storyboards skew
  violent, refusals are expected and user-recoverable, and they must not read as
  a broken application. A `422` with a rephrase-oriented message is the honest
  answer.

Detection of a safety refusal is the one item that **cannot be specified from the
documentation** — the skill does not give its wire shape. The probe determines
it. Until then the classifier is written defensively: inspect a status code if
present, then known markers in the message, and treat an empty output with no
error as a refusal candidate rather than a success.

`rate_limited` retries twice with `RATE_LIMIT_BACKOFF_MS` (`[2000, 8000]`),
already in `shared/config.ts`. It is the only auto-retrying code (§8.6). Total
worst case is ~10s of backoff inside the 30s budget, so the deadline still
governs.

### 2.8 Fetching the reference image

`services/s3.ts` gains `getObjectBytes(key): Promise<Buffer>`, the read
counterpart to the existing `putObject`. The scoped IAM user already has
`s3:GetObject`, so no policy change is needed.

Base64 is produced at the call site with `buffer.toString("base64")`.

No downscaling is required before sending: phase 2 already caps the stored
reference at 1024px JPEG, which is exactly what the skill recommends
("a 1024px long edge is plenty").

### 2.9 Layering

Per `CLAUDE.md` (`routes/ → services/ → db/`):

- `routes/concepts.ts` — adds the route; validates `:id`; returns `{ description }`.
- `services/concepts.ts` — `describeConcept(id)`: load row, enforce the §2.4
  precondition, fetch bytes, build the prompt, call Gemini, trim, return.
- `services/gemini.ts` — the **only** module importing `@google/genai`. Owns the
  client, the retry loop, and the deadline.
- `services/geminiErrors.ts` — pure classification.
- `services/descriptionPrompts.ts` — the verbatim prompt constants.

Invariant 1 holds trivially: the key is read server-side by the SDK and no
Gemini traffic originates in the browser.

### 2.10 Testing

**One new committed test: meta-prompt fidelity.** `CLAUDE.md` names three areas
that earn tests (prompt compiler, concept caps, position arithmetic); this phase
adds a fourth, approved explicitly rather than assumed.

The justification is the same one that governs the whole project's testing
policy — test what fails *silently*. The meta-prompt is the first of the three
enforcement points of the identity-only rule (`TECH_SPEC.md` §8.2). If a clause
such as `Do NOT describe: pose, action, gesture` is dropped or reworded, nothing
errors: descriptions quietly begin carrying scene content, which then fights
every frame description they are compiled against, and the symptom presents as
model unreliability. That is exactly the failure class the three existing areas
were chosen for.

`server/test/descriptionPrompts.test.ts` asserts:

1. `SHARED_PREAMBLE` and each of the three type blocks are **byte-identical** to
   the corresponding fenced block in
   `.claude/skills/storyboard-prompt-compiler/SKILL.md`, read at test time. The
   skill is the source of truth; the test fails if either side drifts.
2. `buildDescriptionPrompt(type)` contains the preamble and the correct type
   block, for all three types.
3. The load-bearing exclusion clause survives in every compiled prompt.

Reading `SKILL.md` from the test is safe in a way that reading it at *runtime*
would not be: the test runs in the repo, where the file is guaranteed present,
while the server may be deployed without `.claude/`. If the skill is ever absent
the test fails loudly rather than silently passing — the assertion is equality
against real content, not a tolerant lookup.

**No other automated tests in this phase.** CRUD handlers, the Gemini client,
and the error classifier are exercised by the manual verification in §5,
consistent with phases 1–2.

---

## 3. Repository layout after phase 3

```
shared/src/config.ts                 MOD  + DESCRIBE_DEADLINE_MS

server/src/
├── config/env.ts                    MOD  GEMINI_API_KEY -> required
├── routes/concepts.ts               MOD  + POST /concepts/:id/describe
├── test/
│   └── descriptionPrompts.test.ts   NEW  meta-prompt fidelity (4th sanctioned area)
└── services/
    ├── concepts.ts                  MOD  + describeConcept()
    ├── s3.ts                        MOD  + getObjectBytes()
    ├── descriptionPrompts.ts        NEW  verbatim meta-prompts
    ├── gemini.ts                    NEW  SDK client, retry, deadline
    └── geminiErrors.ts              NEW  pure error classification
```

New dependency: `@google/genai` (server only), latest `2.17.1` as of writing.
Not `@google/generative-ai`, which is the superseded package.

---

## 4. Step-by-step execution

### Step 1 — Probe the API surface (throwaway)

Install `@google/genai`. Write a scratch script that:

1. Instantiates `new GoogleGenAI({})` and confirms it reads `GEMINI_API_KEY`.
2. Calls `ai.interactions.create` with the §2.2 shape against a small generated
   test image.
3. Prints `interaction.id`, `interaction.output_text`, and the top-level keys of
   the response so the real structure is known rather than assumed.
4. Probes: does the call accept `{ signal }` or a timeout option?
5. Deliberately sends `temperature` to confirm it is rejected — verifying the
   skill's claim rather than trusting it.
6. Sends a deliberately policy-violating prompt to observe the refusal shape.

Record the findings in the execution notes. **Every later step is written against
these results.** Delete the script.

### Step 2 — Environment

Promote `GEMINI_API_KEY` to required in `env.ts` (already present in
`server/.env`). Confirm fail-fast when it is absent. Add
`DESCRIBE_DEADLINE_MS` to `shared/config.ts`.

### Step 3 — `services/descriptionPrompts.ts` and its fidelity test

Extract the four fenced blocks from the skill programmatically and emit the
module. Any later difference is a bug in the extraction, not something to fix by
editing the module by hand.

Then write `server/test/descriptionPrompts.test.ts` per §2.10, which re-parses
`SKILL.md` at test time and asserts byte equality. Run it green, then mutate a
single character of one constant and confirm it fails, then restore — the test
must be shown to have teeth before it is trusted (§5.1).

### Step 4 — `services/geminiErrors.ts`

Pure `classifyGeminiError(err: unknown) => { code, status, message }`, written
against the shapes the Step 1 probe actually produced.

### Step 5 — `services/gemini.ts`

Client, `describeImage({ base64, mimeType, prompt })`, the retry loop for
`rate_limited` only, and the §2.6 deadline. Logs `interaction.id` for
traceability; nothing is persisted, as there is no table for describe calls.

### Step 6 — `services/s3.ts` + `services/concepts.ts`

Add `getObjectBytes`. Add `describeConcept(id)` per §2.9.

### Step 7 — Route

`POST /concepts/:id/describe` in `routes/concepts.ts`, `:id` validated with the
existing `UuidParamSchema`.

---

## 5. Verification

### 5.1 Meta-prompt fidelity

Covered by the committed test from §2.10 — byte equality against the four fenced
blocks in `storyboard-prompt-compiler/SKILL.md`, including punctuation, the
em-dashes, and British spellings such as `colours`.

Beyond running it green, confirm the test is **not vacuous**: mutate one
character of one prompt constant, watch the test fail, then restore. A fidelity
test that cannot demonstrate a true positive is worth nothing, and this is the
same discipline applied to the phase 2 EXIF check after an earlier fixture
silently tested nothing.

### 5.2 End-to-end, per concept type

Create three concepts — one `character`, one `setting`, one `prop` — upload a
real reference image to each, and call `/describe`. For each response check:

- `200` with a non-empty `description`.
- Word count lands near the skill's target (60–120 for character and setting,
  40–90 for prop). Treat this as a signal, not a hard assertion; the model is
  not obliged to hit it exactly.
- **The identity-only rule holds.** Scan the output for the scene words the
  compiler skill names in its debugging section: `standing`, `sitting`,
  `walking`, `background`, `lighting`, `shot`, `angle`, `sunset`, `dramatic`.
  Any hit is a meta-prompt failure and must be reported, not quietly accepted.
- The description does **not** begin with "This image shows" or similar.
- The database row is **unchanged** — `description` is still whatever it was.
  This is the non-persistence guarantee and is easy to break by accident.

### 5.3 Failure paths

| Case | Expected |
|---|---|
| Concept with no reference image | `422 no_reference_image` |
| Unknown concept id | `404 not_found` |
| Malformed `:id` | `400 invalid_input` |
| No auth token | `401 unauthorized` |
| Deliberately policy-violating image or prompt | `422 safety_blocked`, message suggests rephrasing |
| Invalid API key (temporarily) | `502 upstream_error`, no key material in the response |
| Deadline exceeded (temporarily shortened) | `504 timeout` |

The invalid-key case matters beyond its status code: confirm the response body
leaks no key material and no raw upstream text.

### 5.4 Regression

`npm run typecheck` clean, the five phase 1 auth tests still passing alongside
the new meta-prompt tests, and concepts CRUD from phase 2 unaffected.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| API surface differs from the skill | Step 1 probe precedes all application code |
| Meta-prompt transcription drift | Programmatic extraction + committed byte-equality test (§2.10), proven non-vacuous by mutation (§5.1) |
| Descriptions contain scene content, silently degrading every future frame | Scene-word scan in §5.2, reported not ignored |
| Endpoint accidentally persists | Explicit database-unchanged check in §5.2 |
| Safety refusal misread as a crash | Defensive classifier + `422` mapping, refusal shape confirmed by probe |
| `Promise.race` deadline leaves a billing request running | Prefer native abort; document the fallback's cost |
| Raw upstream errors reaching the client | Central classifier; invalid-key test asserts no leakage |

---

## 7. Resolved questions

Both raised before execution and answered by the user on 2026-08-19.

**1. Meta-prompt fidelity gets a committed test — YES.**
Adopted as a fourth sanctioned test area alongside the three in `CLAUDE.md`.
Specified in §2.10, verified non-vacuous in §5.1. Note that `CLAUDE.md`'s
testing section still lists three areas; it is worth updating so the fourth is
recorded in the project's own instructions rather than only here.

**2. Scene-word warnings on the `/describe` response — NO.**
Declined deliberately: keep the prototype simple and feature-lite. The endpoint
returns `{ description }` and nothing else — no `warnings` array, no scene-word
scan in the response path, no inline linting of model output.

This does **not** weaken the identity-only rule, because the rule's enforcement
was never meant to live here. Its three specified enforcement points are the
meta-prompt (phase 3, now covered by a test), the textarea placeholder (phase
7), and the prompt compiler (phase 5). A response-time warning would have been a
fourth, unspecified one.

The scene-word scan remains a **manual** verification step in §5.2 and stays
available as a debugging technique — the compiler skill documents it under
"Debugging inconsistency" as something to run against stored descriptions when a
character drifts. If descriptions do start carrying scene content in practice,
revisit; do not build for it now.

---

## 8. Explicitly deferred

| Item | Phase |
|---|---|
| Stories and frames CRUD, ordering, attachment | 4 |
| Prompt compiler (`promptCompiler.ts`) and its tests | 5 |
| Image generation, `generations` rows, stale sweep | 6 |
| "Generate Description" button, overwrite confirmation (§12.2), textarea placeholder — the second enforcement point of the identity-only rule | 7 |
| `previous_interaction_id` chaining | Not in v1 |
| Persisting describe-call interaction ids | No table exists; logged only |
| Scene-word warnings on `/describe` output | Declined 2026-08-19 (§7). Not deferred to a later phase — deliberately out of scope |

---

## 9. Step 1 probe findings

Empirical results from the throwaway probe (2026-08-19), against
`@google/genai@2.17.1` and the supplied key. **All later steps are written
against these, not against recollection.**

### Confirmed as documented

- `ai.interactions.create` exists and accepts the skill's exact request shape.
- Response carries `id`, `status`, `usage`, `steps`, `output_text`. `steps` for a
  single call are `thought | model_output`, matching the skill.
- `thinking_level: "minimal"` is **rejected** by `gemini-3.7-flash`:
  `400 'minimal' is not a supported thinking level for this model. Allowed
  values are: medium, low, high.` The skill's warning is accurate; `"low"` is
  correct.
- The `AQ.`-prefixed key authenticates normally.
- Latency for text + image at `thinking_level: "low"` ran 1.5–8.5s. The 30s
  `DESCRIBE_DEADLINE_MS` is adequate but not lavish.

### Contradicts the documentation

- **`temperature`, `top_p` and `top_k` are ACCEPTED** inside `generation_config`
  by `gemini-3.7-flash`. The skill and `CLAUDE.md` state that Gemini 3.x rejects
  them. They are not merely tolerated-and-ignored: `generation_config` validates
  its keys strictly (`{ not_a_real_param: 123 }` returns
  `400 Unknown parameter 'not_a_real_param' at 'generation_config'`), so the API
  genuinely knows these three. A top-level `temperature` is rejected as
  `400 Unknown parameter`, which may be the origin of the claim.
- **Retested on `gemini-3.1-flash-image` after billing was enabled: also
  ACCEPTED.** The parameter is honoured by both the text and the image model, so
  the claim does not hold for either. Question closed.
- **Behaviour is unchanged regardless:** this project sends none of them. The
  operative instruction ("do not add them") stands; only the stated reason
  ("sending them errors") is inaccurate for the text model.

### Not covered by the documentation

- **`abortSignal` is not honoured.** It is absent from
  `GoogleGenAIRequestOptions`, so passing it is silently ignored — verified: a
  signal aborted at 150ms did not stop a 1587ms call. The correct mechanism is
  the native **`{ timeout: ms }`** request option, which throws
  `APIConnectionTimeoutError`.
- **The SDK retries internally by default.** With `timeout: 1` and
  `maxRetries: 0` the call threw in 6ms; with the default `maxRetries` it took
  6210ms. Left unset, the SDK's retries would compound with the §8.6 policy and
  blow through the deadline. **Every call must pass `maxRetries: 0`** so retry
  behaviour lives in one place.
- **A safety refusal is a `BadRequestError` with `status: 400`**, message
  beginning `Input blocked: This request was blocked by Gemini's filters.` It is
  *not* a distinct error class and *not* an empty `output_text`. The classifier
  must therefore inspect the message to separate a refusal from a genuine bad
  request — otherwise refusals classify as `invalid_input` and surface as `502`,
  which is precisely the "the app is broken" reading §8.6 warns against.
- Encouragingly, a violent-but-legitimate storyboard prompt ("a masked figure
  stands menacingly over a wounded soldier, blood on the snow, low angle")
  completed normally. Refusals appear to require genuinely prohibited content.

### Error shapes for the classifier

| Condition | Class | `status` |
|---|---|---|
| Safety refusal | `BadRequestError` | `400`, message contains `Input blocked` |
| Other bad request | `BadRequestError` | `400` |
| Rate limit / quota | `RateLimitError` | `429` |
| Bad API key | `AuthenticationError` | `401` |
| Deadline exceeded | `APIConnectionTimeoutError` | none |

### Quota — blocks phase 6, not phase 3

- `gemini-3.7-flash` (text) works on the free tier, limited **per minute**. The
  probes exhausted it briefly and it recovered within a minute.
- **`gemini-3.1-flash-image` returns `429` with
  `limit: 0, model: gemini-3.1-flash-image` for
  `generate_content_free_tier_requests`.** The free tier grants *zero* image
  generation requests — this is a hard zero, not a rate limit that recovers.

Phase 3 is unaffected. Phase 6 would not have functioned until billing was
enabled on Google Cloud project `310235093712`.

**Resolved 2026-08-19: billing enabled and verified.** A generation on
`gemini-3.1-flash-image` succeeded in 9.65s and returned a **1376x768 JPEG** —
exactly the dimensions the skill documents for `1K` at `16:9`, which
independently confirms the `image_size` and `aspect_ratio` values in
`shared/config.ts`. Phase 6 is unblocked.

---

## 10. Execution notes

Recorded after execution. Where the built code differs from the plan, the code
is correct and this section says why.

**Changes driven by the Step 1 probe**

| Change | Reason |
|---|---|
| Deadline uses the SDK's native `{ timeout: ms }`, not `Promise.race` | `abortSignal` is absent from `GoogleGenAIRequestOptions` and is silently ignored. The native option genuinely cancels, so the plan's caveat about a losing request still running and billing does not apply. |
| Every call passes `maxRetries: 0` | The SDK retries internally by default (6ms vs 6210ms for the same failing call). Left unset, those hidden retries compound with the section 8.6 loop and overrun the deadline. |
| The classifier inspects the message, not just the status | A safety refusal is an ordinary `BadRequestError` with `status: 400`, distinguishable from a genuine bad request only by `Input blocked: This request was blocked by Gemini's filters.` Without the message check, refusals would classify as `invalid_input` and surface as `502` — the "app is broken" reading section 8.6 warns against. |
| Fidelity test gained a "did we actually parse the skill" guard | Not in the plan. Without it, a moved file or changed heading would make every extraction `""`, and equality assertions between two empty strings would pass while testing nothing. |

**Verified**

- Three concept types, three real reference images: all `200`, all within the skill's word-count targets (94/88/72), none opening with a "This image shows" preamble, and **zero hits** on the compiler skill's scene-word list — the identity-only rule held.
- **Non-persistence**: all three rows still `description=''` after their describe calls.
- Failure paths: `422 no_reference_image`, `404`, `400`, `401`, `502` on a bad key with **no key material or raw upstream text in the body**, and `504 timeout` with the deadline temporarily set to 1ms.
- Classifier decision table checked against all seven observed error shapes; exactly one condition (429) is retryable, as section 8.6 requires.
- Fidelity test proven non-vacuous by two mutations: a one-character change fails only the preamble assertion; dropping the exclusion clause fails four tests.
- Phase 2 CRUD and upload unaffected; typecheck clean; 20/20 tests; no `500` and no unhandled error at any point.

**Not verified**

- **The `rate_limited` retry path never executed.** Eight concurrent describe
  calls all returned `200` on the first attempt — with billing enabled the
  limits are too high to provoke a `429` on demand. The retry *decision* is
  verified (the classifier marks only 429 retryable); the backoff-and-retry
  *execution* rests on code review. It would become testable with an injectable
  client, which the current no-mocks testing policy excludes.
