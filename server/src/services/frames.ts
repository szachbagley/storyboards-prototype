import {
  appendPosition,
  type ConceptDto,
  type CreateFrameBody,
  type FrameDto,
  type FrameSummaryDto,
  type GenerationSummaryDto,
  type UpdateFrameBody,
} from "@storyboards/shared";
import * as framesDb from "../db/frames.js";
import * as generationsDb from "../db/generations.js";
import type { AttachedConceptRow, FrameRow, GenerationRow } from "../db/frames.js";
import { withTransaction } from "../db/pool.js";
import * as storiesDb from "../db/stories.js";
import { AppError } from "../lib/AppError.js";
import { deleteObject, getPresignedUrl } from "./s3.js";

function frameNotFound(id: string): AppError {
  return new AppError(404, "not_found", `No frame with id ${id}`);
}

async function toSummary(row: FrameRow): Promise<FrameSummaryDto> {
  return {
    id: row.id,
    storyId: row.storyId,
    position: row.position,
    description: row.description,
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

async function generationToDto(row: GenerationRow): Promise<GenerationSummaryDto> {
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

async function toFrameDto(row: FrameRow): Promise<FrameDto> {
  // listFrameConcepts orders by ord, and that order is preserved straight
  // through into the DTO array -- invariant 5 depends on it.
  const [summary, conceptRows, generationRows] = await Promise.all([
    toSummary(row),
    framesDb.listFrameConcepts(row.id),
    framesDb.listFrameGenerations(row.id),
  ]);
  return {
    ...summary,
    concepts: await Promise.all(conceptRows.map(conceptToDto)),
    generations: await Promise.all(generationRows.map(generationToDto)),
  };
}

export async function listStoryFrames(storyId: string): Promise<FrameSummaryDto[]> {
  // An empty array for a nonexistent story is a silent lie the client would
  // render as an empty grid.
  if (!(await storiesDb.storyExists(storyId))) {
    throw new AppError(404, "not_found", `No story with id ${storyId}`);
  }
  return Promise.all((await framesDb.listFramesByStory(storyId)).map(toSummary));
}

export async function getFrame(id: string): Promise<FrameDto> {
  const row = await framesDb.getFrameById(id);
  if (!row) throw frameNotFound(id);
  return toFrameDto(row);
}

export async function createFrame(storyId: string, body: CreateFrameBody): Promise<FrameDto> {
  if (!(await storiesDb.storyExists(storyId))) {
    throw new AppError(404, "not_found", `No story with id ${storyId}`);
  }

  // Reading max(position) and inserting must not interleave with another
  // append, or two frames land on the same position.
  const id = await withTransaction(async (client) => {
    const max = await framesDb.maxPositionInStory(client, storyId);
    return framesDb.insertFrame(client, storyId, appendPosition(max), body.description ?? "");
  });

  return getFrame(id);
}

export async function updateFrame(id: string, body: UpdateFrameBody): Promise<FrameDto> {
  await withTransaction(async (client) => {
    const updated = await framesDb.updateFrameFields(client, id, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
    });
    if (!updated) throw frameNotFound(id);

    if (body.conceptIds !== undefined) {
      const existing = await framesDb.findExistingConceptIds(client, body.conceptIds);
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
      await framesDb.replaceFrameConcepts(client, id, body.conceptIds);
    }
  });

  return getFrame(id);
}

export async function deleteFrame(id: string): Promise<void> {
  // Collected before the delete: the rows cascade away and their keys with them.
  const imageKeys = await generationsDb.imageKeysForFrame(id);

  if (!(await framesDb.deleteFrame(id))) throw frameNotFound(id);

  // Best effort, matching the concept-delete precedent: the rows are already
  // gone, so a failed object delete must not fail the request. There is no
  // orphan sweeper in this system, which is why cleanup happens inline at all.
  await deleteGenerationObjects(imageKeys);
}

async function deleteGenerationObjects(imageKeys: string[]): Promise<void> {
  await Promise.all(
    imageKeys.map(async (key) => {
      try {
        await deleteObject(key);
      } catch (err) {
        console.error(`[frames] failed to delete generation object ${key}`, err);
      }
    }),
  );
}
