import type { CreateStoryBody, StoryDto } from "@storyboards/shared";
import * as db from "../db/stories.js";
import * as generationsDb from "../db/generations.js";
import type { StoryRow } from "../db/stories.js";
import { AppError } from "../lib/AppError.js";
import { deleteObject, getPresignedUrl } from "./s3.js";

async function toDto(row: StoryRow): Promise<StoryDto> {
  return {
    id: row.id,
    title: row.title,
    coverImageUrl: row.coverImageKey ? await getPresignedUrl(row.coverImageKey) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound(id: string): AppError {
  return new AppError(404, "not_found", `No story with id ${id}`);
}

export async function listStories(userId: string): Promise<StoryDto[]> {
  return Promise.all((await db.listStories(userId)).map(toDto));
}

export async function getStory(id: string, userId: string): Promise<StoryDto> {
  const row = await db.getStoryById(id, userId);
  if (!row) throw notFound(id);
  return toDto(row);
}

export async function createStory(userId: string, body: CreateStoryBody): Promise<StoryDto> {
  return toDto(await db.insertStory(userId, body.title));
}

export async function updateStory(id: string, userId: string, title: string): Promise<StoryDto> {
  const row = await db.updateStoryTitle(id, userId, title);
  if (!row) throw notFound(id);
  return toDto(row);
}

export async function deleteStory(id: string, userId: string): Promise<void> {
  // Collected before the delete: frames and their generation rows cascade away.
  const imageKeys = await generationsDb.imageKeysForStory(id, userId);

  if (!(await db.deleteStory(id, userId))) throw notFound(id);

  // Best effort -- the rows are already gone, so a failed object delete must
  // not fail the request.
  await Promise.all(
    imageKeys.map(async (key) => {
      try {
        await deleteObject(key);
      } catch (err) {
        console.error(`[stories] failed to delete generation object ${key}`, err);
      }
    }),
  );
}
