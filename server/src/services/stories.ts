import type { CreateStoryBody, StoryDto } from "@storyboards/shared";
import * as db from "../db/stories.js";
import { ownedGenerationKeys, deleteGenerationObjects } from "./generationCleanup.js";
import type { StoryRow } from "../db/stories.js";
import { AppError } from "../lib/AppError.js";
import { withTransaction } from "../db/pool.js";
import { getPresignedUrl } from "./s3.js";

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
  const imageKeys = await withTransaction(async (client) => {
    if (!(await db.lockStoryForUpdate(client, id, userId))) throw notFound(id);
    const keys = await ownedGenerationKeys(client, id, userId, null);
    if (!(await db.deleteStory(client, id, userId))) throw notFound(id);
    return keys;
  });

  await deleteGenerationObjects(imageKeys);
}
