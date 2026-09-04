import type { GenerationErrorCode } from "@storyboards/shared";

// Messages here are deliberately operation-neutral: this classifier is shared
// by description generation and image generation, so wording that names one of
// them ("the description request timed out") is wrong half the time.
export interface ClassifiedGeminiError {
  code: GenerationErrorCode;
  /** HTTP status for a client-facing response. */
  status: number;
  /** Safe to send to the client: never a raw upstream string. */
  message: string;
  /** True only for `rate_limited` (TECH_SPEC.md section 8.6). */
  retryable: boolean;
}

/**
 * A safety refusal arrives as an ordinary 400, not a distinct error class and
 * not an empty response. Verified empirically against @google/genai 2.17.1:
 *
 *   BadRequestError, status 400
 *   "400 Input blocked: This request was blocked by Gemini's filters."
 *
 * Distinguishing it from a genuine malformed request matters: misclassified, a
 * refusal becomes `invalid_input` and surfaces as a 502, which reads to the
 * user as a broken application. TECH_SPEC.md section 8.6 is explicit that
 * refusals are an expected, recoverable condition -- storyboards skew violent.
 */
const SAFETY_MARKERS = ["input blocked", "blocked by gemini's filters", "safety", "prohibited_content"];

function statusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Map an upstream failure onto the TECH_SPEC.md section 8.6 taxonomy.
 *
 * Pure: no I/O, no logging, no clock. Phase 6 reuses it for generations, which
 * is why it returns the taxonomy code rather than only an HTTP status.
 */
export function classifyGeminiError(err: unknown): ClassifiedGeminiError {
  const status = statusOf(err);
  const raw = messageOf(err).toLowerCase();
  const name = err instanceof Error ? err.name : "";

  if (name === "APIConnectionTimeoutError" || raw.includes("timed out") || raw.includes("aborted due to timeout")) {
    return { code: "timeout", status: 504, message: "The request timed out. Try again.", retryable: false };
  }

  if (status === 429) {
    return { code: "rate_limited", status: 429, message: "The AI service is rate limited. Try again shortly.", retryable: true };
  }

  // Must precede the generic 4xx branch below, which would otherwise swallow a
  // 401. The key belongs to the user now, so this is something they can fix --
  // and retrying without changing it cannot possibly help.
  if (status === 401 || status === 403) {
    return {
      code: "invalid_api_key",
      status: 422,
      message: "Your Gemini API key was rejected. Update it in Settings.",
      retryable: false,
    };
  }

  if (status === 400 && SAFETY_MARKERS.some((marker) => raw.includes(marker))) {
    return {
      code: "safety_blocked",
      status: 422,
      message: "The content filter declined this request. Try rephrasing, or use a different reference image.",
      retryable: false,
    };
  }

  // A 4xx that is not 429 and not a refusal means we sent a bad request. That
  // is our defect, not the caller's, so the taxonomy code records `invalid_input`
  // while the HTTP status reports a server-side failure rather than blaming the
  // client with a 400.
  if (status !== undefined && status >= 400 && status < 500) {
    return { code: "invalid_input", status: 502, message: "The AI service rejected the request.", retryable: false };
  }

  return { code: "upstream_error", status: 502, message: "The AI service is unavailable. Try again.", retryable: false };
}
