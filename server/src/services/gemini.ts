import { GoogleGenAI } from "@google/genai";
import {
  ASPECT_RATIO,
  DESCRIBE_DEADLINE_MS,
  DESCRIPTION_MODEL,
  DESCRIPTION_THINKING_LEVEL,
  GENERATION_DEADLINE_MS,
  IMAGE_MIME_TYPE,
  IMAGE_MODEL,
  IMAGE_SIZE,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_MAX_RETRIES,
} from "@storyboards/shared";
import { AppError } from "../lib/AppError.js";
import type { InputPart } from "./promptCompiler.js";
import { classifyGeminiError } from "./geminiErrors.js";

// The only module in the project that imports the Gemini SDK.
//
// There is deliberately no module-scope client any more: every call is billed to
// the calling user's own key, so a client is constructed per call from the key
// passed in. Construction is local object setup with no network I/O, so this
// costs nothing measurable -- and a cache keyed by key material would be a place
// for one user's client to be handed to another.
//
// The plaintext key exists only as an argument for the duration of a call. It is
// never logged: the log lines below print interaction ids, latency and byte
// counts, and must stay that way.
function clientFor(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-request options. `maxRetries: 0` is not optional -- see withRetryAndDeadline. */
interface RequestOptions {
  timeout: number;
  maxRetries: 0;
}

/**
 * The single implementation of the TECH_SPEC.md section 8.6 retry policy.
 *
 * Shared by description and image generation because the two must behave
 * identically; two copies of retry logic that have to agree is how they stop
 * agreeing.
 *
 * - `rate_limited` is the only condition that retries, twice, with exponential
 *   backoff. Everything else fails on the first attempt.
 *
 * - `maxRetries: 0` is essential, not cosmetic. The SDK retries internally by
 *   default -- measured at 6ms versus 6210ms for the same failing call with and
 *   without it -- and those hidden retries would compound with the loop here and
 *   overrun the deadline.
 *
 * - The deadline is a TOTAL budget across attempts, enforced by shrinking each
 *   attempt's `timeout` to whatever remains, and by skipping a backoff that
 *   would exhaust it. A per-attempt timeout would multiply under retry and make
 *   the worst case unpredictable.
 */
async function withRetryAndDeadline<T>(
  label: string,
  deadlineMs: number,
  run: (options: RequestOptions) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) break;

    try {
      return await run({ timeout: remaining, maxRetries: 0 });
    } catch (err) {
      if (err instanceof AppError) throw err;
      lastError = err;

      const classified = classifyGeminiError(err);
      console.error(`[gemini] ${label} failed code=${classified.code} attempt=${attempt + 1}`, err);

      if (!classified.retryable || attempt === RATE_LIMIT_MAX_RETRIES) {
        throw new AppError(classified.status, classified.code, classified.message);
      }

      const backoff = RATE_LIMIT_BACKOFF_MS[attempt] ?? 0;
      if (Date.now() - startedAt + backoff >= deadlineMs) {
        throw new AppError(classified.status, classified.code, classified.message);
      }
      await sleep(backoff);
    }
  }

  const classified = classifyGeminiError(lastError);
  throw new AppError(classified.status, classified.code, classified.message);
}

export interface DescribeImageInput {
  apiKey: string;
  base64: string;
  mimeType: string;
  prompt: string;
}

/** Describe a reference image (TECH_SPEC.md section 8.1). */
export async function describeImage({ apiKey, base64, mimeType, prompt }: DescribeImageInput): Promise<string> {
  const startedAt = Date.now();

  return withRetryAndDeadline("describe", DESCRIBE_DEADLINE_MS, async (options) => {
    const interaction = await clientFor(apiKey).interactions.create(
      {
        model: DESCRIPTION_MODEL,
        input: [
          // Order is semantically meaningful: the meta-prompt says "this
          // image", so the instruction must precede the image part.
          { type: "text", text: prompt },
          { type: "image", mime_type: mimeType, data: base64 },
        ],
        generation_config: { thinking_level: DESCRIPTION_THINKING_LEVEL },
      },
      options,
    );

    const text = (interaction.output_text ?? "").trim();
    if (!text) {
      throw new AppError(502, "upstream_error", "The description service returned an empty response.");
    }

    console.log(`[gemini] describe ok interaction=${interaction.id} ms=${Date.now() - startedAt}`);
    return text;
  });
}

export interface GeneratedImage {
  base64: string;
  interactionId: string;
}

/**
 * Generate a storyboard frame (TECH_SPEC.md section 8.5).
 *
 * `parts` comes from the phase 5 compiler: the text part first, then reference
 * images in enumeration order. This function must not reorder them.
 *
 * No temperature / top_p / top_k. This model was measured to accept them, but
 * the project sends none.
 */
export async function generateImage(apiKey: string, parts: InputPart[]): Promise<GeneratedImage> {
  const startedAt = Date.now();

  return withRetryAndDeadline("generate", GENERATION_DEADLINE_MS, async (options) => {
    const interaction = await clientFor(apiKey).interactions.create(
      {
        model: IMAGE_MODEL,
        input: parts,
        response_format: {
          type: "image",
          mime_type: IMAGE_MIME_TYPE,
          // "1K" is case-sensitive; "1k" is rejected outright.
          aspect_ratio: ASPECT_RATIO,
          image_size: IMAGE_SIZE,
        },
      },
      options,
    );

    const base64 = interaction.output_image?.data;
    if (!base64) {
      // The image model refuses in TWO distinct ways, both observed:
      //
      //  1. A hard input block -- a 400 BadRequestError carrying "Input
      //     blocked", handled by classifyGeminiError like the text model.
      //  2. A SOFT refusal -- status "completed", no output_image, and
      //     output_text explaining why it declined ("I cannot create...").
      //
      // Case 2 must not be reported as upstream_error: that code means "the
      // service is unavailable, offer retry", and retrying a refusal cannot
      // help. TECH_SPEC.md section 8.6 is explicit that refusals are an
      // expected, user-recoverable condition and must not read as a broken
      // application. The presence of explanatory text is the discriminator.
      const refusal = (interaction.output_text ?? "").trim();
      if (refusal) {
        console.warn(`[gemini] generate refused interaction=${interaction.id}: ${refusal.slice(0, 300)}`);
        throw new AppError(
          422,
          "safety_blocked",
          "The content filter declined this frame. Try rephrasing the description.",
        );
      }
      throw new AppError(502, "upstream_error", "The image service returned no image.");
    }

    console.log(
      `[gemini] generate ok interaction=${interaction.id} ms=${Date.now() - startedAt} b64=${base64.length}`,
    );
    return { base64, interactionId: interaction.id };
  });
}

/**
 * Check that a user-supplied API key actually works, with the cheapest call
 * available. Used at registration and whenever a key is replaced, so a typo is
 * caught in the form rather than forty seconds into a frame generation.
 *
 * Returns a boolean rather than throwing: the caller turns it into a 422 with a
 * message about the key, and any other upstream problem should not be reported
 * to the user as "your key is bad".
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const interaction = await clientFor(apiKey).interactions.create(
      {
        model: DESCRIPTION_MODEL,
        input: [{ type: "text", text: "Reply with the single word: ok" }],
        generation_config: { thinking_level: DESCRIPTION_THINKING_LEVEL },
      },
      { timeout: 20_000, maxRetries: 0 },
    );
    return typeof interaction.output_text === "string";
  } catch (err) {
    const status = typeof err === "object" && err !== null ? (err as { status?: number }).status : undefined;
    // 401/403 means the key is bad. Anything else -- a rate limit, an outage --
    // is not the key's fault, so do not tell the user to replace it.
    if (status === 401 || status === 403) return false;
    console.error("[gemini] key validation could not complete", err);
    throw new AppError(502, "upstream_error", "Could not verify the API key right now. Try again.");
  }
}
