import type pg from "pg";
import { deletionInventory } from "../db/generations.js";
import { parseGenerationSnapshot } from "./generationSnapshot.js";
import { continuityImageKey, deleteObject } from "./s3.js";

export async function ownedGenerationKeys(
  client: pg.PoolClient, storyId: string, userId: string, frameId: string | null,
): Promise<string[]> {
  const rows = await deletionInventory(client, storyId, userId, frameId);
  const keys: string[] = [];
  for (const row of rows) {
    if (row.outputKey !== null) keys.push(row.outputKey);
    const parsed = parseGenerationSnapshot(row.snapshot);
    const ownedKey = continuityImageKey(row.id);
    if (parsed.kind === "v2" && parsed.snapshot.continuity?.imageKey === ownedKey) keys.push(ownedKey);
  }
  return keys;
}

/** Called after commit. Failure on one private object must not skip the others
 * or turn a completed database deletion into a failed request. */
export async function deleteGenerationObjects(keys: string[]): Promise<void> {
  await Promise.all(keys.map(async key => {
    try {
      await deleteObject(key);
    } catch {
      console.error(`[generation] failed to delete private object ${key}`);
    }
  }));
}
