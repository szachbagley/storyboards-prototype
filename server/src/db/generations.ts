import type pg from "pg";
import type { GenerationErrorCode, GenerationStatus } from "@storyboards/shared";
import { query, withTransaction } from "./pool.js";
import { lockStoryForUpdate } from "./stories.js";
import type { GenerationInputSnapshotV2 } from "../services/generationSnapshot.js";

export interface GenerationDetailRow {
  id: string;
  frameId: string;
  status: GenerationStatus;
  imageKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

// Ownership runs generation -> frame -> story -> user. Reads and user-initiated
// writes are all scoped; the server-initiated terminal updates below are not,
// because they act on a generation the server itself created and are never
// reachable from a request.
export async function getGenerationById(
  id: string, userId: string, client?: pg.PoolClient,
): Promise<GenerationDetailRow | null> {
  const sql = `SELECT g.id,
            g.frame_id      AS "frameId",
            g.status,
            g.image_key     AS "imageKey",
            g.error_code    AS "errorCode",
            g.error_message AS "errorMessage",
            g.created_at    AS "createdAt",
            g.completed_at  AS "completedAt"
       FROM generations g
       JOIN frames f   ON f.id = g.frame_id
       JOIN stories st ON st.id = f.story_id
      WHERE g.id = $1 AND st.user_id = $2`;
  const rows = client
    ? (await client.query<GenerationDetailRow>(sql, [id, userId])).rows
    : (await query<GenerationDetailRow>(sql, [id, userId])).rows;
  return rows[0] ?? null;
}

export async function getGenerationByRequest(
  frameId: string,
  requestId: string,
  userId: string,
  client?: pg.PoolClient,
): Promise<{ id: string } | null> {
  const sql = `SELECT g.id FROM generations g
     JOIN frames f ON f.id = g.frame_id
     JOIN stories st ON st.id = f.story_id
     WHERE g.frame_id = $1 AND g.request_id = $2 AND st.user_id = $3`;
  const params = [frameId, requestId, userId];
  const rows = client
    ? (await client.query<{ id: string }>(sql, params)).rows
    : (await query<{ id: string }>(sql, params)).rows;
  return rows[0] ?? null;
}

/** Internal read for a runner that holds this generation id, including after
 * an uncertain COMMIT. Absence is distinct from an unavailable database. */
export async function getGenerationState(id: string): Promise<Pick<GenerationDetailRow,
  "status" | "imageKey"> | null> {
  const { rows } = await query<Pick<GenerationDetailRow, "status" | "imageKey">>(
    `SELECT status, image_key AS "imageKey" FROM generations WHERE id = $1`, [id],
  );
  return rows[0] ?? null;
}

/** TECH_SPEC.md section 7.2: one pending generation per frame, so an impatient
 *  double-click cannot fire two billed calls. */
export async function getPendingForFrame(
  client: pg.PoolClient,
  frameId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT g.id FROM generations g
         JOIN frames f   ON f.id = g.frame_id
         JOIN stories st ON st.id = f.story_id
        WHERE g.frame_id = $1 AND g.status = 'pending' AND st.user_id = $2
        ORDER BY g.created_at, g.id LIMIT 1`,
    [frameId, userId],
  );
  return rows[0] ?? null;
}

/** Unlocked preflight hint only. Final admission repeats the check under the
 * story lock and the unique index remains the database safety net. */
export async function findPendingForFrame(frameId: string, userId: string): Promise<{
  id: string; requestId: string | null;
} | null> {
  const { rows } = await query<{ id: string; requestId: string | null }>(
    `SELECT g.id, g.request_id AS "requestId" FROM generations g
     JOIN frames f ON f.id = g.frame_id
     JOIN stories st ON st.id = f.story_id
     WHERE g.frame_id = $1 AND g.status = 'pending' AND st.user_id = $2
     ORDER BY g.created_at, g.id LIMIT 1`, [frameId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Insert the pending row with the compiled prompt and input snapshot ALREADY
 * written (invariant 7). Concepts are mutable and shared, so without the
 * snapshot, editing one description silently invalidates the provenance of
 * every frame generated from it. A failed call whose prompt was never recorded
 * is undiagnosable.
 */
export async function insertPending(
  client: pg.PoolClient,
  input: { id: string; frameId: string; requestId: string | null; model: string;
    compiledPrompt: string; inputSnapshot: GenerationInputSnapshotV2 },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO generations (id, frame_id, request_id, status, model, compiled_prompt, input_snapshot)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6)
     RETURNING id`,
    [input.id, input.frameId, input.requestId, input.model,
      input.compiledPrompt, JSON.stringify(input.inputSnapshot)],
  );
  return rows[0]!.id;
}

/** Returns false when the row no longer exists -- the frame or story was
 *  deleted while this generation was still in flight. */
/** Not user-scoped: called only by the background task for a generation the
 *  server itself created, never from a request. */
export async function markSucceeded(
  client: pg.PoolClient, id: string, frameId: string, imageKey: string, interactionId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE generations
        SET status = 'succeeded', image_key = $2, interaction_id = $3, completed_at = now()
      WHERE id = $1 AND frame_id = $4 AND status = 'pending'`,
    [id, imageKey, interactionId, frameId],
  );
  return rowCount === 1;
}

/** Not user-scoped, for the same reason as markSucceeded. */
export async function markFailed(
  client: pg.PoolClient,
  id: string,
  frameId: string,
  errorCode: GenerationErrorCode,
  errorMessage: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE generations
        SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
      WHERE id = $1 AND frame_id = $4 AND status = 'pending'`,
    [id, errorCode, errorMessage, frameId],
  );
  return rowCount === 1;
}

/**
 * Point the frame at this generation only if nothing is selected yet
 * (TECH_SPEC.md section 7 step 3).
 *
 * The `IS NULL` guard is what makes invariant 8 real: regenerating appends and
 * never displaces an earlier, possibly better, result. Promoting the newest
 * would be a one-word change that silently breaks the core loop of the app.
 */
export async function selectIfUnset(client: pg.PoolClient, generationId: string, frameId: string): Promise<void> {
  await client.query(
    `UPDATE frames SET selected_generation_id = $2, updated_at = now()
      WHERE id = $1 AND selected_generation_id IS NULL
        AND EXISTS (SELECT 1 FROM generations g WHERE g.id = $2
          AND g.frame_id = $1 AND g.status = 'succeeded' AND g.image_key IS NOT NULL)`,
    [frameId, generationId],
  );
}

/** Explicit user choice (POST /frames/:id/select-generation). */
export async function setSelectedGeneration(
  client: pg.PoolClient,
  frameId: string,
  generationId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE frames SET selected_generation_id = $2, updated_at = now()
      WHERE id = $1 AND story_id IN (SELECT id FROM stories WHERE user_id = $3)
        AND EXISTS (SELECT 1 FROM generations g WHERE g.id = $2
          AND g.frame_id = $1 AND g.status = 'succeeded' AND g.image_key IS NOT NULL)`,
    [frameId, generationId, userId],
  );
  return rowCount === 1;
}

/**
 * TECH_SPEC.md section 7.1. Railway restarts the container on deploy; any
 * in-flight generation is lost but its pending row survives, leaving the UI
 * spinning forever.
 *
 * `$1 * interval '1 millisecond'` takes the threshold as a plain integer
 * parameter. EXPLAIN confirms this predicate uses the partial index
 * generations_pending_idx created in phase 1.
 */
export async function sweepStale(olderThanMs: number): Promise<number> {
  // The preliminary list does not lock rows. Each short transaction locks its
  // story first, in UUID order, before touching generation rows.
  const { rows } = await query<{ storyId: string }>(
    `SELECT DISTINCT st.id AS "storyId" FROM stories st
     JOIN frames f ON f.story_id = st.id
     JOIN generations g ON g.frame_id = f.id
     WHERE g.status = 'pending'
       AND g.created_at < now() - ($1 * interval '1 millisecond')
     ORDER BY st.id`, [olderThanMs],
  );
  let total = 0;
  for (const { storyId } of rows) {
    total += await withTransaction(async (client) => {
      if (!(await lockStoryForUpdate(client, storyId))) return 0;
      const { rowCount } = await client.query(
        `UPDATE generations g
        SET status = 'failed',
            error_code = 'abandoned',
            error_message = 'The server restarted while this generation was in flight.',
            completed_at = now()
        FROM frames f
        WHERE g.frame_id = f.id AND f.story_id = $1
          AND g.status = 'pending'
          AND g.created_at < now() - ($2 * interval '1 millisecond')`,
        [storyId, olderThanMs],
      );
      return rowCount ?? 0;
    });
  }
  return total;
}

/** Generation object keys for a frame, collected before the rows are deleted. */
export async function imageKeysForFrame(
  client: pg.PoolClient, frameId: string, storyId: string, userId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ imageKey: string }>(
    `SELECT g.image_key AS "imageKey"
       FROM generations g
       JOIN frames f   ON f.id = g.frame_id
       JOIN stories st ON st.id = f.story_id
      WHERE g.frame_id = $1 AND st.id = $2 AND st.user_id = $3 AND g.image_key IS NOT NULL`,
    [frameId, storyId, userId],
  );
  return rows.map((row) => row.imageKey);
}

/** Same, for every frame in a story. */
export async function imageKeysForStory(
  client: pg.PoolClient, storyId: string, userId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ imageKey: string }>(
    `SELECT g.image_key AS "imageKey"
       FROM generations g
       JOIN frames f   ON f.id = g.frame_id
       JOIN stories st ON st.id = f.story_id
      WHERE f.story_id = $1 AND st.user_id = $2 AND g.image_key IS NOT NULL`,
    [storyId, userId],
  );
  return rows.map((row) => row.imageKey);
}
