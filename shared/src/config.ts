// Application constants. These are code, not deployment configuration -- see
// TECH_SPEC.md 11 and invariant 9 in CLAUDE.md. Nothing here belongs in an
// environment variable, and no call site should re-declare any of it inline.

// --- Gemini models --------------------------------------------------------
// Current as of August 2026. See the gemini-nano-banana skill before changing
// any of these; pre-2026 model IDs (gemini-1.5-*, gemini-2.0-*, and the
// gemini-2.5-flash-image legacy image model) are shut down or superseded.
export const IMAGE_MODEL = "gemini-3.1-flash-image" as const;
export const DESCRIPTION_MODEL = "gemini-3.7-flash" as const;

// gemini-3.7-flash accepts only "low" | "medium" | "high". Unlike the image
// models it rejects "minimal" outright.
export const DESCRIPTION_THINKING_LEVEL = "low" as const;

// --- Image output (TECH_SPEC.md 8.5) --------------------------------------
export const ASPECT_RATIO = "16:9" as const;

// Case-sensitive. "1k" is rejected by the API; "1K" is 1376x768 at 16:9.
export const IMAGE_SIZE = "1K" as const;

export const IMAGE_MIME_TYPE = "image/jpeg" as const;

// --- Reference image budget (TECH_SPEC.md 8.3) ----------------------------
// Exceeding these does not error upstream -- faces blend and drift instead --
// so they are validated locally before every generation.
export const MAX_CHARACTER_CONCEPTS = 4;
export const MAX_TOTAL_CONCEPTS = 10;

// --- Generation timing ----------------------------------------------------
// Total wall-clock budget for one generation task, rate-limit retries
// included, enforced by a single AbortController for the whole task. It is
// deliberately not a per-attempt timeout: per attempt, the worst case
// (90s + backoff + 90s + backoff + 90s) approaches STALE_GENERATION_AGE_MS and
// a still-running generation would be swept as abandoned.
export const GENERATION_DEADLINE_MS = 90_000;

// rate_limited is the only error code that auto-retries (TECH_SPEC.md 8.6).
export const RATE_LIMIT_MAX_RETRIES = 2;
export const RATE_LIMIT_BACKOFF_MS = [2_000, 8_000] as const;

export const POLL_INTERVAL_MS = 2_000;

// Total budget for one /describe call, retries included, enforced with the
// SDK's native `timeout` request option. Unlike image generation, describe is
// synchronous from the client's perspective, so an unbounded upstream call
// would hold the HTTP connection open. Measured latency for this model at
// thinking_level "low" is 1.5-8.5s, so 30s is headroom rather than a hang.
export const DESCRIBE_DEADLINE_MS = 30_000;

// Longer than GENERATION_DEADLINE_MS on purpose. If the client gave up at the
// same moment the server did, the user would see a generic client-side timeout
// instead of the server's classified error from the TECH_SPEC.md 8.6 taxonomy.
export const CLIENT_POLL_CEILING_MS = 105_000;

// --- Stale generation sweep (TECH_SPEC.md 7.1) ----------------------------
export const STALE_GENERATION_AGE_MS = 5 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;

// --- Identity (see identity-plan.md) ---
// Absolute session lifetime. No sliding expiry: re-login is cheap and an
// absolute bound means a stolen token cannot be renewed indefinitely.
export const SESSION_TTL_DAYS = 30;

// Length over composition rules -- NIST has advised against forced character
// classes since 2017.
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

// Restricted charset keeps case-insensitive uniqueness meaningful: no spaces
// and no unicode lookalikes that would read as a different account.
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Per-account lockout. This exists specifically because replacing a 32-byte
// random shared secret with a human-chosen password lowers credential entropy
// on a publicly reachable API.
export const MAX_LOGIN_ATTEMPTS = 10;
export const LOGIN_LOCKOUT_MINUTES = 15;

// --- Frame ordering (TECH_SPEC.md 5.2) ------------------------------------
// Appending uses max(position) + POSITION_GAP; inserting between two frames
// uses their midpoint, which is why position is DOUBLE PRECISION.
export const POSITION_GAP = 1000;

// --- Uploads and storage (TECH_SPEC.md 9) ---------------------------------
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Reference images are downscaled before storage: larger inputs cost more
// tokens on every generation that includes the concept, with no quality gain.
export const REFERENCE_IMAGE_MAX_EDGE = 1024;
export const REFERENCE_IMAGE_JPEG_QUALITY = 85;

export const PRESIGNED_URL_TTL_SECONDS = 3600;
