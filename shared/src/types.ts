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

/** A story. coverImageUrl is the presigned URL of the FIRST frame's selected
 * generation, where "first" means lowest position -- null when that frame has
 * no selected generation, even if a later frame does. */
export interface StoryDto {
  id: string;
  title: string;
  coverImageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A frame as rendered in the story grid: thumbnail and description only.
 *
 * There is deliberately no label or index field. TECH_SPEC.md section 5.2 is
 * explicit that "Frame 1" / "Frame 7" are derived at render time from position
 * order; storing one would be a second source of truth that goes stale on
 * every reorder. */
export interface FrameSummaryDto {
  id: string;
  storyId: string;
  position: number;
  description: string;
  selectedGenerationId: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationSummaryDto {
  id: string;
  status: GenerationStatus;
  imageUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A frame as rendered in the editor. */
export interface FrameDto extends FrameSummaryDto {
  /** In frame_concepts.ord order. This ordering is the origin of invariant 5:
   * it becomes the reference-image enumeration order in the compiled prompt. */
  concepts: ConceptDto[];
  /** Newest first (TECH_SPEC.md section 12.4). */
  generations: GenerationSummaryDto[];
}
