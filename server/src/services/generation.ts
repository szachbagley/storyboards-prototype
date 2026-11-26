import { createHash, randomUUID } from "node:crypto";
import {
  ASPECT_RATIO, GENERATION_ERROR_CODES, IMAGE_MIME_TYPE, IMAGE_MODEL, IMAGE_SIZE,
  type GenerateFrameBody, type GenerationErrorCode, type GenerationSummaryDto,
} from "@storyboards/shared";
import * as framesDb from "../db/frames.js";
import * as generationsDb from "../db/generations.js";
import * as storiesDb from "../db/stories.js";
import { generationToDto } from "./generationProjection.js";
import { requireContinuityRollout } from "./continuityRollout.js";
import { withReferencePreflight, readConceptReferenceBytes, stageContinuityCopy,
  cleanupKnownUncommittedContinuityCopy } from "./referencePreflight.js";
import { withTransaction } from "../db/pool.js";
import { AppError } from "../lib/AppError.js";
import { generateImage } from "./gemini.js";
import { classifyGeminiError } from "./geminiErrors.js";
import type { AuthUser } from "../middleware/auth.js";
import { compileFramePrompt, validateFrameForGeneration, type CompilerConcept } from "./promptCompiler.js";
import type { GenerationInputSnapshotV2 } from "./generationSnapshot.js";
import { resolveUserApiKey } from "./userApiKey.js";
import { deleteObject, generationImageKey, putObject } from "./s3.js";

export async function lookupRequest(frameId: string, requestId: string, userId: string): Promise<string> {
  const row = await generationsDb.getGenerationByRequest(frameId, requestId, userId);
  if (!row) throw new AppError(404, "not_found", "No generation request for this frame.");
  return row.id;
}

export async function getGeneration(id: string, userId: string): Promise<GenerationSummaryDto> {
  const row = await generationsDb.getGenerationById(id, userId);
  if (!row) throw new AppError(404, "not_found", `No generation with id ${id}`);
  return generationToDto(row, userId);
}

function frameNotFound(frameId: string): AppError {
  return new AppError(404, "not_found", `No frame with id ${frameId}`);
}

function pendingError(id: string): AppError {
  return new AppError(409, "generation_in_progress", "This frame already has a generation in progress.",
    { generationId: id });
}

function admissionConflictName(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const pgError = err as { code?: unknown; constraint?: unknown };
  if (pgError.code === "23505" && (
    pgError.constraint === "generations_frame_request_uidx" ||
    pgError.constraint === "generations_one_pending_per_frame_uidx"
  )) return pgError.constraint;
  return null;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function startGeneration(
  frameId: string, user: AuthUser, body: GenerateFrameBody = {}, continuityEnabled = false,
): Promise<string> {
  const ownedStoryId = await framesDb.getOwnedFrameStoryId(frameId, user.id);
  if (!ownedStoryId) throw frameNotFound(frameId);

  if (body.requestId) {
    const prior = await generationsDb.getGenerationByRequest(frameId, body.requestId, user.id);
    if (prior) return prior.id;
  }

  // Resolving the caller's key has no network effect.
  const apiKey = resolveUserApiKey(user);
  const captured = await framesDb.captureGenerationInputs(frameId, user.id);
  if (!captured) throw frameNotFound(frameId);
  if (body.requestId) {
    const prior = await generationsDb.getGenerationByRequest(frameId, body.requestId, user.id);
    if (prior) return prior.id;
  }
  if (body.expectedContinuitySourceFrameId !== undefined &&
      (body.expectedContinuitySourceFrameId?.toLowerCase() ?? null) !== captured.continuitySourceFrameId) {
    throw new AppError(409, "continuity_configuration_changed", "The source frame changed. Refresh and review it.");
  }
  if (captured.continuitySourceFrameId !== null) {
    requireContinuityRollout(continuityEnabled);
    if (captured.sourceId !== captured.continuitySourceFrameId) {
      throw new AppError(422, "invalid_continuity_source", "Choose another frame in this story.");
    }
    if (!captured.source) {
      throw new AppError(422, "continuity_source_unusable", "Select a succeeded image on the source frame.");
    }
  }

  const conceptsForValidation: CompilerConcept[] = captured.concepts.map((concept) => ({
    id: concept.id, name: concept.name, type: concept.type, description: concept.description,
    imageBase64: null, imageMimeType: concept.imageMime,
  }));
  validateFrameForGeneration({
    frameDescription: captured.frameDescription, concepts: conceptsForValidation,
    continuity: captured.source ? { imageBase64: "", imageMimeType: IMAGE_MIME_TYPE } : null,
  });
  const fastPending = await generationsDb.findPendingForFrame(frameId, user.id);
  if (fastPending) {
    if (body.requestId && fastPending.requestId === body.requestId.toLowerCase()) return fastPending.id;
    throw pendingError(fastPending.id);
  }

  const candidateId = randomUUID();
  let ownsCopy = false;
  let inserted = false;
  let insertAttempted = false;
  let replayDuringAdmission: string | null = null;
  try {
    const { buffers, copy } = await withReferencePreflight(async (budget) => {
      const buffers = await readConceptReferenceBytes(captured.concepts.map((c) => c.imageKey), budget);
      const copy = captured.source ? await stageContinuityCopy(candidateId, captured.source.imageKey, budget) : null;
      ownsCopy = copy !== null;
      return { buffers, copy };
    });
    const concepts: CompilerConcept[] = captured.concepts.map((concept, index) => ({
      id: concept.id, name: concept.name, type: concept.type, description: concept.description,
      imageBase64: buffers[index]?.toString("base64") ?? null, imageMimeType: concept.imageMime,
    }));
    const { prompt, parts } = compileFramePrompt({
      frameDescription: captured.frameDescription, concepts,
      continuity: copy && { imageBase64: copy.imageBytes.toString("base64"), imageMimeType: copy.imageMime },
    });
    const inputSnapshot: GenerationInputSnapshotV2 = {
      schemaVersion: 2,
      compilerVersion: "explicit-continuity-v1",
      capturedAt: captured.capturedAt.toISOString(),
      frameDescription: captured.frameDescription,
      aspectRatio: ASPECT_RATIO,
      imageSize: IMAGE_SIZE,
      concepts: captured.concepts.map((concept, index) => ({
        id: concept.id, ord: concept.ord, name: concept.name, type: concept.type,
        description: concept.description, imageKey: concept.imageKey,
        imageMime: concept.imageKey ? (concept.imageMime ?? IMAGE_MIME_TYPE) : null,
        imageSha256: buffers[index] ? hash(buffers[index]) : null,
      })),
      continuity: captured.source && copy ? {
        sourceFrameId: captured.source.frameId, sourceGenerationId: captured.source.generationId,
        sourcePosition: captured.source.position, sourceImageKey: captured.source.imageKey,
        sourceImageSha256: copy.sourceImageSha256, imageKey: copy.imageKey,
        imageSha256: copy.imageSha256, imageMime: copy.imageMime,
      } : null,
    };

    const admission = await withTransaction(async (client) => {
      if (!(await storiesDb.lockStoryForUpdate(client, captured.storyId, user.id)) ||
          !(await framesDb.lockOwnedFrameForUpdate(client, frameId, captured.storyId, user.id))) {
        throw frameNotFound(frameId);
      }
      if (body.requestId) {
        const replay = await generationsDb.getGenerationByRequest(frameId, body.requestId, user.id, client);
        if (replay) {
          replayDuringAdmission = replay.id;
          return { id: replay.id, inserted: false };
        }
      }
      const pending = await generationsDb.getPendingForFrame(client, frameId, user.id);
      if (pending) throw pendingError(pending.id);
      insertAttempted = true;
      await generationsDb.insertPending(client, {
        id: candidateId, frameId, requestId: body.requestId ?? null,
        model: IMAGE_MODEL, compiledPrompt: prompt, inputSnapshot,
      });
      inserted = true;
      return { id: candidateId, inserted: true };
    });
    if (!admission.inserted) return admission.id;
    void runGeneration(admission.id, frameId, captured.storyId, apiKey, parts).catch((err: unknown) => {
      console.error(`[generation] ${admission.id} escaped its own error handling`, err);
    });
    return admission.id;
  } catch (err) {
    // The transaction helper rolls back first. A lost COMMIT acknowledgement
    // must never trigger another dispatch.
    if (replayDuringAdmission) return replayDuringAdmission;
    if (!insertAttempted) throw err;
    let candidateState: Awaited<ReturnType<typeof generationsDb.getGenerationState>>;
    try {
      candidateState = await generationsDb.getGenerationState(candidateId);
    } catch {
      throw new AppError(503, "admission_uncertain", "Generation admission could not be confirmed. Check later.");
    }
    if (candidateState) {
      throw new AppError(503, "admission_uncertain", "Generation was recorded but dispatch could not be confirmed.",
        { generationId: candidateId });
    }
    if (inserted) throw new AppError(503, "admission_uncertain",
      "Generation admission could not be confirmed. Check the frame before retrying.");
    const constraint = admissionConflictName(err);
    if (constraint) {
      if (body.requestId) {
        const replay = await generationsDb.getGenerationByRequest(frameId, body.requestId, user.id);
        if (replay) return replay.id;
      }
      const pending = await withTransaction((client) =>
        generationsDb.getPendingForFrame(client, frameId, user.id));
      if (pending) throw pendingError(pending.id);
      // The conflicting row can become terminal or be deleted between the
      // unique violation and this fresh read. Do not expose raw SQL errors.
      throw new AppError(409, "generation_in_progress",
        "Generation admission changed while this request was being saved. Check the frame before retrying.");
    }
    throw err;
  } finally {
    // A lost COMMIT acknowledgement after INSERT may still leave a committed row.
    // An ambiguous PUT never established ownership of its key.
    if (ownsCopy && !inserted) {
      await cleanupKnownUncommittedContinuityCopy(candidateId).catch(() =>
        console.error(`[generation] ${candidateId} could not clean up its staged input`));
    }
  }
}

function isGenerationErrorCode(code: string): code is GenerationErrorCode {
  return (GENERATION_ERROR_CODES as readonly string[]).includes(code);
}

async function recordFailure(
  generationId: string, frameId: string, storyId: string, err: unknown,
): Promise<void> {
  const classified = err instanceof AppError
    ? { code: err.code, message: err.message }
    : classifyGeminiError(err);
  const code = isGenerationErrorCode(classified.code) ? classified.code : "upstream_error";
  try {
    await withTransaction(async (client) => {
      if (!await storiesDb.lockStoryForUpdate(client, storyId)) return;
      await generationsDb.markFailed(client, generationId, frameId, code, classified.message);
    });
  } catch (dbErr) {
    console.error(`[generation] ${generationId} could not be marked failed`, dbErr);
  }
  console.error(`[generation] ${generationId} failed code=${code}`);
}

async function finalizeOutput(
  generationId: string, frameId: string, storyId: string, key: string, interactionId: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    if (!await storiesDb.lockStoryForUpdate(client, storyId)) return false;
    const transitioned = await generationsDb.markSucceeded(client, generationId, frameId, key, interactionId);
    if (transitioned) await generationsDb.selectIfUnset(client, generationId, frameId);
    return transitioned;
  });
}

/** Delete only when a fresh DB read proves the output is unreferenced. A lost
 * finalization COMMIT or DB outage must preserve the already-paid image. */
async function cleanupUncommittedOutput(generationId: string, key: string): Promise<void> {
  let state: Awaited<ReturnType<typeof generationsDb.getGenerationState>>;
  try {
    state = await generationsDb.getGenerationState(generationId);
  } catch (err) {
    console.error(`[generation] ${generationId} cannot verify output cleanup`, err);
    return;
  }
  if (state?.status === "pending" ||
      (state?.status === "succeeded" && state.imageKey === key)) return;
  await deleteObject(key).catch((err: unknown) =>
    console.error(`[generation] ${generationId} could not remove unreferenced output`, err));
}

async function runGeneration(
  generationId: string, frameId: string, storyId: string, apiKey: string,
  parts: ReturnType<typeof compileFramePrompt>["parts"],
): Promise<void> {
  let image: Awaited<ReturnType<typeof generateImage>>;
  try {
    image = await generateImage(apiKey, parts);
  } catch (err) {
    await recordFailure(generationId, frameId, storyId, err);
    return;
  }

  const key = generationImageKey(generationId);
  try {
    await putObject(key, Buffer.from(image.base64, "base64"), IMAGE_MIME_TYPE);
  } catch (err) {
    console.error(`[generation] ${generationId} billed output could not be saved`, err);
    await recordFailure(generationId, frameId, storyId,
      new AppError(502, "upstream_error", "The generated image could not be saved."));
    return;
  }

  try {
    if (await finalizeOutput(generationId, frameId, storyId, key, image.interactionId)) {
      console.log(`[generation] ${generationId} succeeded`);
      return;
    }
  } catch (err) {
    // Re-read after an uncertain COMMIT. Retry only DB finalization with the
    // same stored bytes; never make a second Gemini request.
    console.error(`[generation] ${generationId} finalization unconfirmed`, err);
    try {
      const state = await generationsDb.getGenerationState(generationId);
      if (state?.status === "succeeded" && state.imageKey === key) return;
      if (state?.status === "pending") {
        try {
          if (await finalizeOutput(generationId, frameId, storyId, key, image.interactionId)) return;
        } catch (retryErr) {
          console.error(`[generation] ${generationId} DB-only finalization retry unconfirmed`, retryErr);
        }
      }
    } catch (readErr) {
      console.error(`[generation] ${generationId} cannot check finalization`, readErr);
    }
  }
  await cleanupUncommittedOutput(generationId, key);
}

/** POST /frames/:id/select-generation */
export async function selectGeneration(frameId: string, generationId: string, userId: string): Promise<void> {
  const storyId = await framesDb.getOwnedFrameStoryId(frameId, userId);
  if (!storyId) throw frameNotFound(frameId);
  await withTransaction(async (client) => {
    if (!(await storiesDb.lockStoryForUpdate(client, storyId, userId)) ||
        !(await framesDb.lockOwnedFrameForUpdate(client, frameId, storyId, userId))) throw frameNotFound(frameId);
    const generation = await generationsDb.getGenerationById(generationId, userId, client);
    if (!generation) throw new AppError(404, "not_found", `No generation with id ${generationId}`);
    if (generation.frameId !== frameId) {
      throw new AppError(422, "generation_frame_mismatch", "That generation belongs to a different frame.");
    }
    if (generation.status !== "succeeded" || !generation.imageKey) {
      throw new AppError(422, "generation_not_succeeded", `That generation is ${generation.status}, not usable.`);
    }
    if (!(await generationsDb.setSelectedGeneration(client, frameId, generationId, userId))) {
      throw new AppError(422, "generation_not_succeeded", "That generation is no longer usable.");
    }
  });
}
