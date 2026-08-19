# CLAUDE.md

Project guidance for Claude Code. Read `TECH_SPEC.md` for the full design; this file covers what to do, what not to do, and what your training data will get wrong.

---

## What this is

A single-user storyboard generator. The user maintains a global library of **Concepts** (characters, settings, props), each with a reference image and an identity description. They write **Frames** inside **Stories**, attach concepts, and generate images via Nano Banana. The concept reference images are sent with every generation request — that is the mechanism that keeps a character looking the same across frames.

**This is a rough proof-of-concept.** Build the smallest thing that works. Do not add features, abstractions, or configuration surface that the spec does not call for.

---

## Stack

- **Client:** React + TypeScript (Vite) → Vercel
- **API:** Node + TypeScript → Railway
- **DB:** PostgreSQL on Railway
- **Storage:** Amazon S3
- **AI:** Gemini API via `@google/genai`

Monorepo layout: `client/`, `server/`, `shared/`. Shared types and constants live in `shared/` and are imported by both sides.

---

## Your training data is stale here — read this section

These are current as of August 2026 and differ from what you likely learned. Do not "correct" them.

### The Interactions API is the current surface

Use `ai.interactions.create({ ... })`. Do **not** use `generateContent`, `getGenerativeModel`, or the `@google/generative-ai` package. The correct package is **`@google/genai`**.

```ts
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({});   // reads GEMINI_API_KEY from env

const interaction = await ai.interactions.create({
  model: "gemini-3.1-flash-image",
  input: parts,
  response_format: {
    type: "image",
    mime_type: "image/jpeg",
    aspect_ratio: "16:9",
    image_size: "1K",
  },
});
```

### Model IDs

| Purpose | Model |
|---|---|
| Frame image generation | `gemini-3.1-flash-image` (Nano Banana 2) |
| Concept description from image | `gemini-3.7-flash` |

Do not substitute `gemini-2.5-flash-image`, `gemini-1.5-*`, `gemini-2.0-*`, or any Imagen model. If you believe a model ID is wrong, ask — do not silently swap it.

### Parameter gotchas that produce hard errors

- `image_size` is **case-sensitive**. `"1K"` works, `"1k"` is rejected.
- Gemini 3.x models **reject** `temperature`, `top_p`, and `top_k`. Do not add them.
- Thinking is on by default for 3.1 Flash Image and cannot be disabled. Thinking tokens are billed.
- Input parts use `{ type: "text", text }` and `{ type: "image", mime_type, data }` where `data` is base64. Not `inlineData`, not `parts`, not `fileData`.
- Read the result from `interaction.output_image.data` (base64) and `interaction.id`.

When in doubt about the Gemini surface, consult the `gemini-nano-banana` skill rather than reasoning from memory.

---

## Architectural invariants

Violating any of these is a bug even if the code runs.

**1. The API key never reaches the client.** All Gemini traffic originates from the Railway server. There is no scenario in this project where the client calls Google directly.

**2. The backend owns the Gemini call end to end.** The image API is synchronous with no task handle — a dropped connection loses the image and still bills. Never stream or proxy a live Gemini request through to the browser. Persist to S3 the moment bytes arrive.

**3. Generation is async from the client's perspective.** `POST /frames/:id/generate` inserts a `pending` row, returns `202 { generationId }`, and fires the call without awaiting. The client polls `GET /generations/:id`. There is no queue, no Redis, no BullMQ — a single process is correct here.

**4. Concept descriptions are identity-only.** No pose, environment, lighting, camera, or action. See the `storyboard-prompt-compiler` skill. This rule is enforced in the meta-prompt, the UI placeholder, and the compiler. A violation produces no error — just quietly bad images.

**5. Enumeration order must match image part order.** If the compiled text says "Reference image 2 — Castle", the second image part must be Castle's. Desync causes the model to attach the wrong description to the wrong subject, which presents as random inconsistency and is miserable to diagnose.

**6. The frame description is inserted verbatim.** Never paraphrase, reorder, summarize, or "improve" the user's authored scene text in the compiler.

**7. Snapshot before generating.** `compiled_prompt` and `input_snapshot` are written to the `generations` row **before** the API call, not after. Concepts are mutable; without the snapshot, editing one destroys the provenance of every frame made from it.

**8. Generations append, never overwrite.** `frames.selected_generation_id` points at the chosen one. Regenerating adds a row. A worse result must never destroy a better one.

**9. Constants live in `shared/config.ts`.** `ASPECT_RATIO`, `IMAGE_SIZE`, model IDs, `MAX_CHARACTER_CONCEPTS`, `MAX_TOTAL_CONCEPTS`, `POLL_INTERVAL_MS`. These are code, not environment variables. No string literals scattered through call sites.

---

## Conventions

- **TypeScript strict mode on.** No `any`. No `@ts-ignore` without a comment explaining why.
- **No ORM.** Use `pg` with parameterized queries. Migrations are numbered `.sql` files in `server/migrations/`, applied in order.
- **Validate at the boundary.** Zod schemas on every request body, in `shared/` so the client can reuse them.
- **Errors are typed.** Generation failures carry an `error_code` from the taxonomy in `TECH_SPEC.md` §8.6 — never a bare boolean or a raw upstream message.
- **No comments that restate the code.** Comment the non-obvious: why the sweep exists, why order matters, why a value is case-sensitive.
- **Server code is layered** as `routes/ → services/ → db/`. Routes parse and respond. Services hold logic. DB holds SQL. Gemini and S3 calls live in `services/`.

---

## The prompt compiler

`server/src/services/promptCompiler.ts` must be a **pure function**. Inputs in, `{ prompt: string, parts: InputPart[] }` out. No database access, no S3 calls, no network, no clock.

This is the interesting surface of the project and the one component worth real tests. It is also the thing most likely to break silently. Keep it testable.

---

## Commands

```bash
# install
npm install

# dev (from repo root, runs both)
npm run dev

# server only
npm run dev --workspace=server

# client only
npm run dev --workspace=client

# typecheck everything
npm run typecheck

# tests
npm test

# apply migrations
npm run migrate --workspace=server
```

---

## Testing

Minimal but non-zero. Three areas earn tests:

1. **Prompt compiler** — order matching, missing-image concepts, verbatim passthrough of the frame description.
2. **Validation** — the 4-character and 10-total concept caps.
3. **Position arithmetic** — append, insert-between, reorder.

Everything else is exercised by using the app. Do not write tests for CRUD handlers.

---

## Things not to do

- Do not add spend controls, quotas, or usage dashboards. Deliberately out of scope.
- Do not add story-level styling or per-story aspect ratios. One global 16:9 constant.
- Do not implement `previous_interaction_id` chaining. The column is stored for a future version; nothing reads it yet.
- Do not add multi-user support, a users table, or `user_id` columns. Auth is one shared secret.
- Do not introduce a job queue, Redis, or a worker process.
- Do not add an ORM, a state management library, or a component library. React state and `fetch` are sufficient at this size.
- Do not use presigned PUT for uploads. Uploads route through the backend so `sharp` can preprocess them.
- Do not compare the auth secret with `===`. Use `crypto.timingSafeEqual` against equal-length buffers.
- Do not scaffold features the spec does not describe, however obvious they seem. Ask instead.

---

## When something in the spec looks wrong

Say so. Do not silently work around it, and do not implement something you believe is broken. The spec is a draft and disagreement is useful — but it should be raised, not routed around.
