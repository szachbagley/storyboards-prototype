---
name: gemini-nano-banana
description: Correct usage of the Google Gemini API for image generation (Nano Banana) and image understanding via the Interactions API and the @google/genai SDK — current model IDs, request shape, response parsing, reference-image limits, aspect ratio and resolution options, and error classification. Use this skill whenever the task touches Gemini, Nano Banana, image generation, image editing, describing an image with an AI model, `@google/genai`, `interactions.create`, `generateContent`, or any model ID beginning with `gemini-`. Consult it before writing or reviewing any Gemini API call, even a small one — model IDs and the request surface changed recently and pre-2026 knowledge is wrong in ways that fail at runtime.
---

# Gemini / Nano Banana API

Current as of August 2026. Pre-2026 training data is wrong about the package name, the call surface, and every model ID. Follow this file over recollection.

## Quick reference

| | |
|---|---|
| Package | `@google/genai` |
| Call | `ai.interactions.create({ ... })` |
| Endpoint | `POST https://generativelanguage.googleapis.com/v1beta/interactions` |
| Auth header | `x-goog-api-key` |
| Image generation | `gemini-3.1-flash-image` |
| Text / vision | `gemini-3.7-flash` |

## Deprecated — do not use

| Wrong | Right |
|---|---|
| `@google/generative-ai` | `@google/genai` |
| `getGenerativeModel()` | `ai.interactions.create()` |
| `generateContent()` | `interactions.create()` |
| `contents: [{ parts: [...] }]` | `input: [...]` |
| `inlineData: { mimeType, data }` | `{ type: "image", mime_type, data }` |
| `generationConfig` | `generation_config` / `response_format` |
| `gemini-1.5-*`, `gemini-2.0-*` | shut down — 404 |
| `gemini-2.5-flash-image` | legacy; use `gemini-3.1-flash-image` |
| Imagen for general generation | Nano Banana |

---

## The model family

**`gemini-3.1-flash-image`** (Nano Banana 2) — the default choice. Balances speed and quality, handles multiple reference images well, supports 512px through 4K.

**`gemini-3.1-flash-lite-image`** (Nano Banana 2 Lite) — cheapest and fastest, **1K only**, and explicitly *not* optimized for multiple reference inputs or multi-turn editing. Wrong choice for any consistency-dependent workflow.

**`gemini-3-pro-image`** (Nano Banana Pro) — highest quality, most reference-image headroom, supports style references. Slower and more expensive.

**`gemini-2.5-flash-image`** (original Nano Banana) — legacy, works with at most 3 input images. Migrate away.

For text and image *understanding* (not generation), use **`gemini-3.7-flash`**. `gemini-3.6-flash` is the previous stable if you need a conservative pin.

---

## Text-to-image

```ts
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});  // reads GEMINI_API_KEY

const interaction = await ai.interactions.create({
  model: "gemini-3.1-flash-image",
  input: "A weathered astronaut on rust-colored regolith",
  response_format: {
    type: "image",
    mime_type: "image/jpeg",
    aspect_ratio: "16:9",
    image_size: "1K",
  },
});

const buffer = Buffer.from(interaction.output_image.data, "base64");
```

## Image + text input

`input` becomes an array of parts. Images are base64 in `data`, with `mime_type` alongside.

```ts
const interaction = await ai.interactions.create({
  model: "gemini-3.1-flash-image",
  input: [
    { type: "text", text: promptText },
    { type: "image", mime_type: "image/jpeg", data: base64One },
    { type: "image", mime_type: "image/jpeg", data: base64Two },
  ],
  response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
});
```

**Part order is semantically meaningful.** If the text refers to "the first reference image," it must be the first image part. This is a frequent and hard-to-diagnose source of wrong output.

## Image understanding (image → text)

```ts
const interaction = await ai.interactions.create({
  model: "gemini-3.7-flash",
  input: [
    { type: "text", text: metaPrompt },
    { type: "image", mime_type: "image/jpeg", data: base64 },
  ],
  generation_config: { thinking_level: "low" },
});

const text = interaction.output_text;
```

---

## Reference image limits

Up to 14 reference images total, but the useful caps are per-category and per-model:

| | 3.1 Flash Lite | 3.1 Flash | 3 Pro |
|---|---|---|---|
| High-fidelity objects | 14 | 10 | 6 |
| Character consistency | — | 4 | 5 |
| Style references | — | — | 3 |

Exceeding the character cap degrades quality rather than erroring — faces blend and drift. Validate before the call and surface a clear message.

Note that Lite offers **no** character-consistency guarantee at all. If identity across images matters, Lite is not a candidate.

---

## Aspect ratio and resolution

Set via `response_format`. Supported ratios on 3.1 Flash: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, plus the extremes `1:4`, `4:1`, `1:8`, `8:1`.

Sizes: `512px`, `1K`, `2K`, `4K` (3.1 Flash); `1K` only on Lite; `1K`/`2K`/`4K` on Pro.

**`image_size` is case-sensitive.** `"1K"` is valid; `"1k"` is rejected outright.

Common resolutions at 16:9 — `512px`: 688×384, `1K`: 1376×768, `2K`: 2752×1536, `4K`: 5504×3072.

If `aspect_ratio` is omitted the model matches the input image's ratio, or defaults to square. Always set it explicitly.

---

## Parameters that error

- **`temperature`, `top_p`, `top_k`** — rejected by Gemini 3.x. Remove them.
- **Prefilled model turns** — no longer supported.
- **`thinking_level: "minimal"`** — valid on `gemini-3.1-flash-image` (and is its default) but **rejected by `gemini-3.7-flash`**, which accepts only `low`, `medium` (default), and `high`.

Thinking cannot be disabled on the image models. Thinking tokens are billed at the output rate.

---

## Multi-turn editing

`previous_interaction_id` chains an edit onto a prior result — "same image, warmer light" — rather than rolling fresh.

```ts
const edit = await ai.interactions.create({
  model: "gemini-3.1-flash-image",
  input: "Make the lighting warmer. Change nothing else.",
  previous_interaction_id: interaction.id,
  response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
});
```

Store `interaction.id` if chaining might ever matter. **The validity lifetime of an interaction ID is undocumented** — verify empirically before depending on it.

---

## Response parsing

`interaction.output_image` and `interaction.output_text` are convenience accessors that return the *last* block of that type. They are correct for single-output calls.

For interleaved text-and-image output, iterate steps:

```ts
for (const step of interaction.steps) {
  if (step.type !== "model_output") continue;
  for (const block of step.content) {
    if (block.type === "image") { /* block.data is base64 */ }
    if (block.type === "text")  { /* block.text */ }
  }
}
```

`step.type === "thought"` holds interim reasoning and up to two interim images. Not billed for the images; useful for debugging composition failures.

---

## Error classification

Never surface a raw upstream error. Classify:

| Condition | Code | Handling |
|---|---|---|
| Content policy refusal | `safety_blocked` | Show the prompt for editing; suggest rephrasing |
| HTTP 429 | `rate_limited` | Retry twice with exponential backoff, then surface |
| No response in budget | `timeout` | Offer retry |
| HTTP 4xx (not 429) | `invalid_input` | Fix the request; do not retry |
| HTTP 5xx / SDK throw | `upstream_error` | Offer retry |

Safety refusals are an expected, recoverable state — especially for dramatic, violent, or dark subject matter. They must not read to the user as a broken application.

---

## Operational notes

- **Image generation is synchronous.** There is no job ID and nothing to poll. A dropped connection loses the result and still bills. The server must own the call and persist the bytes immediately.
- **Latency is 10–40s** with thinking enabled. Design the client around that; silence reads as failure.
- **Every generated image carries a SynthID watermark**, now alongside C2PA Content Credentials.
- **The Batch API** offers higher rate limits in exchange for up to 24h turnaround — right for bulk backfills, wrong for interactive use.
- **Downscale reference images before sending.** A 1024px long edge is plenty. Larger inputs cost more tokens and add latency for no quality gain.
- **Best-supported languages** for prompts: English, plus ar-EG, de-DE, es-MX, fr-FR, hi-IN, id-ID, it-IT, ja-JP, ko-KR, pt-BR, ru-RU, ua-UA, vi-VN, zh-CN.

---

## Verifying against current docs

This file will drift. Authoritative sources:

- `https://ai.google.dev/gemini-api/docs/image-generation` — Nano Banana reference
- `https://ai.google.dev/gemini-api/docs/models` — model IDs and status
- `https://ai.google.dev/gemini-api/docs/changelog` — release notes and deprecations
- `https://ai.google.dev/gemini-api/docs/interactions-overview` — Interactions API

If a call fails with an unexpected error, check the changelog before rewriting the code — model deprecations land on announced dates and the failure will look like a bug in your request.
