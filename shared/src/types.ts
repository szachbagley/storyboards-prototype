// Domain unions shared by client and server. The database mirrors these as
// enums (concept_type, generation_status); generations.error_code is TEXT and
// is constrained only by GenerationErrorCode below.

export const CONCEPT_TYPES = ["character", "setting", "prop"] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const GENERATION_STATUSES = ["pending", "succeeded", "failed"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

// TECH_SPEC.md 8.6. A boolean failure state is not sufficient: safety refusals
// are an expected, user-recoverable condition and must not read as a broken
// application.
export const GENERATION_ERROR_CODES = [
  "safety_blocked",
  "rate_limited",
  "timeout",
  "invalid_input",
  "upstream_error",
  "abandoned",
] as const;
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

/** Shape of every non-2xx response body from the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** A concept as returned by the API.
 *
 * image_key is deliberately not exposed: it is an internal storage detail the
 * client has no use for, and imageUrl === null already communicates "no
 * reference image yet". imageUrl is a presigned GET valid for one hour. */
export interface ConceptDto {
  id: string;
  name: string;
  type: ConceptType;
  description: string;
  imageUrl: string | null;
  imageMime: string | null;
  createdAt: string;
  updatedAt: string;
}
