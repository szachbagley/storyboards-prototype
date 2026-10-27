import { createHash } from "node:crypto";
import {
  CANDIDATE_CLEANUP_DEADLINE_MS, IMAGE_MIME_TYPE, MAX_TOTAL_CONCEPTS,
  REFERENCE_PREFLIGHT_DEADLINE_MS,
} from "@storyboards/shared";
import { AppError } from "../lib/AppError.js";
import { preprocessContinuityImage } from "./imagePreprocess.js";
import {
  continuityImageKey, deleteObject, EmptyS3BodyError, getObjectBytes, putContinuityObject,
} from "./s3.js";

type ReferenceKind = "concept" | "continuity";

function unavailable(): AppError {
  return new AppError(503, "reference_storage_unavailable", "Reference storage is unavailable. Try again later.");
}

function invalid(kind: ReferenceKind): AppError {
  return kind === "continuity"
    ? new AppError(422, "continuity_image_invalid", "The selected source image is empty or unreadable.")
    : new AppError(422, "reference_image_invalid", "A concept reference image is empty or unreadable.");
}

function missing(kind: ReferenceKind): AppError {
  return kind === "continuity"
    ? new AppError(422, "continuity_image_missing", "The selected source image is missing.")
    : new AppError(422, "reference_image_missing", "A concept reference image is missing.");
}

function classifyReadFailure(error: unknown, kind: ReferenceKind): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof EmptyS3BodyError) return invalid(kind);
  if (typeof error === "object" && error !== null) {
    const s3Error = error as {
      name?: unknown; code?: unknown; statusCode?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    const status = s3Error.$metadata?.httpStatusCode ?? s3Error.statusCode;
    if (status === 403 || (typeof status === "number" && status >= 500) ||
        s3Error.name === "NoSuchBucket") return unavailable();
    if (s3Error.name === "NoSuchKey" || s3Error.code === "NoSuchKey" ||
        status === 404) {
      return missing(kind);
    }
  }
  return unavailable();
}

export interface PreflightBudget {
  readonly signal: AbortSignal;
  reserveReference(): void;
  wait<T>(operation: Promise<T>): Promise<T>;
}

/** One deadline covers every reference read, transformation and copy PUT. */
export async function withReferencePreflight<T>(
  work: (budget: PreflightBudget) => Promise<T>,
  deadlineMs = REFERENCE_PREFLIGHT_DEADLINE_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let referenceReads = 0;
  const budget: PreflightBudget = {
    signal: controller.signal,
    reserveReference() {
      if (++referenceReads > MAX_TOTAL_CONCEPTS) {
        throw new AppError(422, "too_many_concepts", "Too many reference images for one attempt.");
      }
    },
    async wait<T>(operation: Promise<T>): Promise<T> {
      if (controller.signal.aborted) throw unavailable();
      let onAbort: (() => void) | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(unavailable());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([operation, expired]);
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  try {
    return await budget.wait(work(budget));
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readReferenceBytes(
  key: string, kind: ReferenceKind, budget: PreflightBudget,
): Promise<Buffer> {
  budget.reserveReference();
  try {
    const bytes = await budget.wait(getObjectBytes(key, budget.signal));
    if (bytes.length === 0) throw invalid(kind);
    return bytes;
  } catch (error) {
    // A deadline outranks any late 404 from the same request.
    if (budget.signal.aborted) throw unavailable();
    throw classifyReadFailure(error, kind);
  }
}

/** The attachment cap also limits concurrent S3 GET fanout. Null keys stay text-only. */
export async function readConceptReferenceBytes(
  keys: ReadonlyArray<string | null>, budget: PreflightBudget,
): Promise<Array<Buffer | null>> {
  if (keys.length > MAX_TOTAL_CONCEPTS) {
    throw new AppError(422, "too_many_concepts", "Too many concept references attached.");
  }
  return Promise.all(keys.map((key) => key ? readReferenceBytes(key, "concept", budget) : null));
}

function requireCandidateId(candidateId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateId)) {
    throw new Error("Expected a candidate generation UUID");
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isConditionalWriteConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const s3Error = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return s3Error.name === "PreconditionFailed" ||
    s3Error.name === "ConditionalRequestConflict" ||
    s3Error.$metadata?.httpStatusCode === 412 ||
    s3Error.$metadata?.httpStatusCode === 409;
}

export interface StagedContinuityCopy {
  imageKey: string;
  imageMime: typeof IMAGE_MIME_TYPE;
  sourceImageSha256: string;
  imageSha256: string;
  imageBytes: Buffer;
}

/** Call only for a fresh candidate before SQL admission; the result is not ownership proof. */
export async function stageContinuityCopy(
  candidateId: string, sourceImageKey: string, budget: PreflightBudget,
): Promise<StagedContinuityCopy> {
  requireCandidateId(candidateId);
  const original = await readReferenceBytes(sourceImageKey, "continuity", budget);
  const transformed = await budget.wait(preprocessContinuityImage(original));
  const imageKey = continuityImageKey(candidateId);
  try {
    await budget.wait(putContinuityObject(candidateId, transformed, budget.signal));
  } catch (error) {
    // A conditional conflict may refer to an existing copy; never delete it.
    // Other failed PUTs can have reached S3 but cannot own a committed row yet.
    // A deadline can hide a late conditional conflict. Keep the key for later
    // reconciliation rather than risk deleting an already-owned object.
    if (!budget.signal.aborted && !isConditionalWriteConflict(error)) {
      try {
        await cleanupKnownUncommittedContinuityCopy(candidateId);
      } catch {
        console.error("[continuity] candidate cleanup failed; a private orphan may remain");
      }
    }
    throw error instanceof AppError ? error : unavailable();
  }
  return {
    imageKey, imageMime: IMAGE_MIME_TYPE,
    sourceImageSha256: sha256(original), imageSha256: sha256(transformed),
    imageBytes: transformed,
  };
}

/** Only call after SQL establishes that this candidate was never committed. */
export async function cleanupKnownUncommittedContinuityCopy(candidateId: string): Promise<void> {
  requireCandidateId(candidateId);
  await withReferencePreflight(
    (budget) => budget.wait(deleteObject(continuityImageKey(candidateId), budget.signal)),
    CANDIDATE_CLEANUP_DEADLINE_MS,
  );
}
