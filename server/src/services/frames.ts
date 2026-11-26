import { createHash } from "node:crypto";
import {
  appendPosition,
  type ConceptDto,
  type CreateFrameBody,
  type DeleteFrameQuery,
  type FrameDto,
  type FrameSummaryDto,
  type UpdateFrameBody,
} from "@storyboards/shared";
import * as framesDb from "../db/frames.js";
import { ownedGenerationKeys, deleteGenerationObjects } from "./generationCleanup.js";
import type { AttachedConceptRow, FrameRow } from "../db/frames.js";
import { withTransaction } from "../db/pool.js";
import * as storiesDb from "../db/stories.js";
import { generationToDto } from "./generationProjection.js";
import { requireContinuityRollout } from "./continuityRollout.js";
import { AppError } from "../lib/AppError.js";
import { getPresignedUrl } from "./s3.js";

function frameNotFound(id: string): AppError {
  return new AppError(404, "not_found", `No frame with id ${id}`);
}

async function toSummary(row: FrameRow): Promise<FrameSummaryDto> {
  return {
    id: row.id,
    storyId: row.storyId,
    position: row.position,
    description: row.description,
    continuitySourceFrameId: row.continuitySourceFrameId,
    continuitySourceSelectedGenerationId: row.continuitySourceSelectedGenerationId,
    continuityReferencedByCount: row.continuityReferencedByCount,
    selectedImageState: row.selectedImageState,
    selectedGenerationId: row.selectedGenerationId,
    imageUrl: row.selectedImageKey ? await getPresignedUrl(row.selectedImageKey) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function conceptToDto(row: AttachedConceptRow): Promise<ConceptDto> {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    imageUrl: row.imageKey ? await getPresignedUrl(row.imageKey) : null,
    imageMime: row.imageMime,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function toFrameDto(row: FrameRow, userId: string): Promise<FrameDto> {
  // listFrameConcepts orders by ord, and that order is preserved straight
  // through into the DTO array -- invariant 5 depends on it.
  const [summary, conceptRows, generationRows] = await Promise.all([
    toSummary(row),
    framesDb.listFrameConcepts(row.id, userId),
    framesDb.listFrameGenerations(row.id, userId),
  ]);
  return {
    ...summary,
    concepts: await Promise.all(conceptRows.map(conceptToDto)),
    generations: await Promise.all(generationRows.map((row) => generationToDto(row, userId))),
  };
}

export async function listStoryFrames(storyId: string, userId: string): Promise<FrameSummaryDto[]> {
  // An empty array for a nonexistent story is a silent lie the client would
  // render as an empty grid.
  if (!(await storiesDb.storyExists(storyId, userId))) {
    throw new AppError(404, "not_found", `No story with id ${storyId}`);
  }
  return Promise.all((await framesDb.listFramesByStory(storyId, userId)).map(toSummary));
}

export async function getFrame(id: string, userId: string): Promise<FrameDto> {
  const row = await framesDb.getFrameById(id, userId);
  if (!row) throw frameNotFound(id);
  return toFrameDto(row, userId);
}

export async function createFrame(storyId: string, userId: string, body: CreateFrameBody): Promise<FrameDto> {
  // Reading max(position) and inserting must not interleave with another
  // append, or two frames land on the same position.
  const id = await withTransaction(async (client) => {
    if (!(await storiesDb.lockStoryForUpdate(client, storyId, userId))) {
      throw new AppError(404, "not_found", `No story with id ${storyId}`);
    }
    const max = await framesDb.maxPositionInStory(client, storyId, userId);
    return framesDb.insertFrame(client, storyId, userId, appendPosition(max), body.description ?? "");
  });
  if (!id) throw new AppError(404, "not_found", `No story with id ${storyId}`);

  return getFrame(id, userId);
}

function invalidSource() {
  return new AppError(422, "invalid_continuity_source", "Choose another frame in this story.");
}

export async function updateFrame(id: string, userId: string, body: UpdateFrameBody, continuityEnabled = false): Promise<FrameDto> {
  const storyId = await framesDb.getOwnedFrameStoryId(id, userId);
  if (!storyId) throw frameNotFound(id);
  await withTransaction(async (client) => {
    if (!(await storiesDb.lockStoryForUpdate(client, storyId, userId)) ||
        !(await framesDb.lockOwnedFrameForUpdate(client, id, storyId, userId))) throw frameNotFound(id);
    const sourceId = body.continuitySourceFrameId;
    if (sourceId) {
      if (sourceId.toLowerCase() === id.toLowerCase() ||
          !await framesDb.lockOwnedSource(client, sourceId, storyId, userId)) {
        throw invalidSource();
      }
      requireContinuityRollout(continuityEnabled);
    }
    const updated = await framesDb.updateFrameFields(client, id, userId, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.continuitySourceFrameId !== undefined
        ? { continuitySourceFrameId: body.continuitySourceFrameId } : {}),
    });
    if (!updated) throw frameNotFound(id);

    if (body.conceptIds !== undefined) {
      const existing = await framesDb.findExistingConceptIds(client, body.conceptIds, userId);
      const unknown = body.conceptIds.filter((conceptId) => !existing.has(conceptId));
      if (unknown.length > 0) {
        // Named ids beat catching a foreign-key violation and sniffing
        // constraint names, and this check runs inside the transaction so it
        // cannot race a concurrent concept delete.
        throw new AppError(
          422,
          "unknown_concept",
          `Unknown concept id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
        );
      }
      await framesDb.replaceFrameConcepts(client, id, body.conceptIds, userId);
    }
  }).catch((error: unknown) => {
    const pgError = error as { code?: string; constraint?: string } | null;
    if (pgError?.code === "23503" && pgError.constraint === "frames_continuity_source_fk") throw invalidSource();
    throw error;
  });

  return getFrame(id, userId);
}

export async function deleteFrame(id: string, userId: string, query: DeleteFrameQuery): Promise<void> {
  const storyId = await framesDb.getOwnedFrameStoryId(id, userId);
  if (!storyId) throw frameNotFound(id);
  // Collect and delete under the same story lock as finalization. Storage work
  // follows COMMIT; a late runner sees no row and cleans its own new output.
  const imageKeys = await withTransaction(async (client) => {
    if (!(await storiesDb.lockStoryForUpdate(client, storyId, userId)) ||
        !(await framesDb.lockOwnedFrameForUpdate(client, id, storyId, userId))) throw frameNotFound(id);
    const dependentIds = await framesDb.dependentFrameIds(client, id, storyId, userId);
    const referencedByCount = dependentIds.length;
    if (referencedByCount > 0 || query.referenceSetToken !== undefined) {
      const referenceSetToken = createHash("sha256").update(dependentIds.join("\n")).digest("hex");
      if (query.confirmContinuity !== "true" || query.referenceSetToken !== referenceSetToken) {
        const consequence = referencedByCount === 0
          ? "The source selections changed. No frames currently use this source."
          : `This frame is a continuity source for ${referencedByCount} other ${referencedByCount === 1 ? "frame" : "frames"}. Deleting it clears those source selections.`;
        throw new AppError(409, "continuity_source_in_use",
          consequence + " Existing outputs and their saved continuity inputs remain with those frames." +
          " You will need to choose another source before generating with continuity again." +
          " Already accepted generation work may still finish or be billed.",
          { referencedByCount, referenceSetToken });
      }
    }
    const keys = await ownedGenerationKeys(client, storyId, userId, id);
    if (referencedByCount) await framesDb.clearDependentFrames(client, id, storyId, userId);
    if (!(await framesDb.deleteFrame(client, id, userId))) throw frameNotFound(id);
    return keys;
  });

  await deleteGenerationObjects(imageKeys);
}
