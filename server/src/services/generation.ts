import {
  ASPECT_RATIO,
  IMAGE_MIME_TYPE,
  IMAGE_MODEL,
  IMAGE_SIZE,
  type GenerationSummaryDto,
} from "@storyboards/shared";
import * as framesDb from "../db/frames.js";
import * as generationsDb from "../db/generations.js";
import type { GenerationDetailRow } from "../db/generations.js";
import { withTransaction } from "../db/pool.js";
import { AppError } from "../lib/AppError.js";
import { generateImage } from "./gemini.js";
import { classifyGeminiError } from "./geminiErrors.js";
import { compileFramePrompt, validateFrameForGeneration, type CompilerConcept } from "./promptCompiler.js";
import { deleteObject, generationImageKey, getObjectBytes, getPresignedUrl, putObject } from "./s3.js";

async function toDto(row: GenerationDetailRow): Promise<GenerationSummaryDto> {
  return {
    id: row.id,
    status: row.status,
    imageUrl: row.imageKey ? await getPresignedUrl(row.imageKey) : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function getGeneration(id: string): Promise<GenerationSummaryDto> {
  const row = await generationsDb.getGenerationById(id);
  if (!row) throw new AppError(404, "not_found", `No generation with id ${id}`);
  return toDto(row);
}

/**
 * Start a generation (TECH_SPEC.md section 7).
 *
 * Returns as soon as the pending row exists; the model call runs in the
 * background. The client polls GET /generations/:id.
 *
 * Ordering here is fixed by two invariants. Reference images are read from S3
 * BEFORE the row is inserted, because compiled_prompt must be exactly what gets
 * sent and the parts cannot be built without the bytes -- compiling afterwards
 * would risk the recorded prompt diverging from the real one. It also means an
 * S3 failure surfaces as a clean error with no orphaned pending row.
 */
export async function startGeneration(frameId: string): Promise<string> {
  const frame = await framesDb.getFrameById(frameId);
  if (!frame) throw new AppError(404, "not_found", `No frame with id ${frameId}`);

  const attached = await framesDb.listFrameConcepts(frameId);

  // Caps and the non-empty description rule, before any billed work.
  const conceptsForValidation: CompilerConcept[] = attached.map((concept) => ({
    id: concept.id,
    name: concept.name,
    type: concept.type,
    description: concept.description,
    imageBase64: null,
    imageMimeType: concept.imageMime,
  }));
  validateFrameForGeneration({ frameDescription: frame.description, concepts: conceptsForValidation });

  // Concepts with a null image_key are included by description only.
  const concepts: CompilerConcept[] = await Promise.all(
    attached.map(async (concept) => ({
      id: concept.id,
      name: concept.name,
      type: concept.type,
      description: concept.description,
      imageBase64: concept.imageKey ? (await getObjectBytes(concept.imageKey)).toString("base64") : null,
      imageMimeType: concept.imageMime,
    })),
  );

  const { prompt, parts } = compileFramePrompt({ frameDescription: frame.description, concepts });

  // TECH_SPEC.md section 5.1. imageKey, never base64: embedding the bytes would
  // bloat every row for no benefit. The snapshot exists for provenance --
  // concepts are mutable, so without it, editing one description invalidates
  // the record of every frame already generated from it.
  const inputSnapshot = {
    frameDescription: frame.description,
    aspectRatio: ASPECT_RATIO,
    imageSize: IMAGE_SIZE,
    concepts: attached.map((concept) => ({
      id: concept.id,
      ord: concept.ord,
      name: concept.name,
      type: concept.type,
      description: concept.description,
      imageKey: concept.imageKey,
    })),
  };

  const generationId = await withTransaction(async (client) => {
    if (await generationsDb.hasPendingForFrame(client, frameId)) {
      throw new AppError(409, "generation_in_progress", "This frame already has a generation in progress.");
    }
    return generationsDb.insertPending(client, {
      frameId,
      model: IMAGE_MODEL,
      compiledPrompt: prompt,
      inputSnapshot,
    });
  });

  // Fired without awaiting: the handler returns 202 immediately. runGeneration
  // never throws -- the catch is a backstop for a bug in the error path itself,
  // since an unhandled rejection would take the process down.
  void runGeneration(generationId, frameId, parts).catch((err: unknown) => {
    console.error(`[generation] ${generationId} escaped its own error handling`, err);
  });

  return generationId;
}

/**
 * The background task. Always writes a terminal state before returning.
 *
 * If the process dies mid-call the row stays pending and the stale sweep
 * resolves it -- that is the designed recovery path, not a gap.
 */
async function runGeneration(generationId: string, frameId: string, parts: ReturnType<typeof compileFramePrompt>["parts"]): Promise<void> {
  try {
    const { base64, interactionId } = await generateImage(parts);

    // Persist the moment bytes arrive (invariant 2). S3 first, then the row:
    // a failed row update leaves an unreferenced object, which is harmless,
    // while the reverse leaves a row pointing at an object that does not exist.
    const key = generationImageKey(generationId);
    try {
      await putObject(key, Buffer.from(base64, "base64"), IMAGE_MIME_TYPE);
    } catch (err) {
      // We have paid for this image and are about to lose it. Log loudly enough
      // that it is recognisable rather than mysterious.
      console.error(
        `[generation] ${generationId} LOST A BILLED IMAGE: S3 put failed for ${key} (interaction=${interactionId}, ${base64.length} b64 chars)`,
        err,
      );
      throw err;
    }

    // The row can disappear mid-flight: deleting the frame (or its story)
    // cascades the generations row away, and the delete collected its S3 keys
    // before this object existed. Without this check the object we just wrote
    // is orphaned with nothing referencing it and no sweeper to find it.
    const persisted = await generationsDb.markSucceeded(generationId, key, interactionId);
    if (!persisted) {
      console.warn(`[generation] ${generationId} was deleted mid-flight; removing its orphaned object`);
      await deleteObject(key).catch((err: unknown) =>
        console.error(`[generation] could not remove orphaned object ${key}`, err),
      );
      return;
    }

    await generationsDb.selectIfUnset(generationId, frameId);
    console.log(`[generation] ${generationId} succeeded`);
  } catch (err) {
    const classified =
      err instanceof AppError
        ? { code: err.code, message: err.message }
        : (() => {
            const c = classifyGeminiError(err);
            return { code: c.code, message: c.message };
          })();

    // error_code is constrained to the section 8.6 taxonomy. Anything else that
    // reaches here (an S3 throw, for instance) is an upstream failure.
    const code = isGenerationErrorCode(classified.code) ? classified.code : "upstream_error";
    await generationsDb
      .markFailed(generationId, code, classified.message)
      .catch((dbErr: unknown) => console.error(`[generation] ${generationId} could not be marked failed`, dbErr));
    console.error(`[generation] ${generationId} failed code=${code}`);
  }
}

const GENERATION_ERROR_CODE_SET = new Set([
  "safety_blocked",
  "rate_limited",
  "timeout",
  "invalid_input",
  "upstream_error",
  "abandoned",
]);

function isGenerationErrorCode(code: string): code is Parameters<typeof generationsDb.markFailed>[1] {
  return GENERATION_ERROR_CODE_SET.has(code);
}

/** POST /frames/:id/select-generation */
export async function selectGeneration(frameId: string, generationId: string): Promise<void> {
  const generation = await generationsDb.getGenerationById(generationId);
  if (!generation) throw new AppError(404, "not_found", `No generation with id ${generationId}`);

  if (generation.frameId !== frameId) {
    throw new AppError(422, "generation_frame_mismatch", "That generation belongs to a different frame.");
  }
  if (generation.status !== "succeeded") {
    // Selecting a failed or pending generation would point the frame at a row
    // with no image.
    throw new AppError(422, "generation_not_succeeded", `That generation is ${generation.status}, not succeeded.`);
  }

  await generationsDb.setSelectedGeneration(frameId, generationId);
}
