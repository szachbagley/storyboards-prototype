import type pg from "pg";
import type { GenerationErrorCode, GenerationStatus } from "@storyboards/shared";
import { query } from "./pool.js";

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

const SELECT_COLUMNS = `
  id,
  frame_id      AS "frameId",
  status,
  image_key     AS "imageKey",
  error_code    AS "errorCode",
  error_message AS "errorMessage",
  created_at    AS "createdAt",
  completed_at  AS "completedAt"
`;

export async function getGenerationById(id: string): Promise<GenerationDetailRow | null> {
  const { rows } = await query<GenerationDetailRow>(
    `SELECT ${SELECT_COLUMNS} FROM generations WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** TECH_SPEC.md section 7.2: one pending generation per frame, so an impatient
 *  double-click cannot fire two billed calls. */
export async function hasPendingForFrame(client: pg.PoolClient, frameId: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM generations WHERE frame_id = $1 AND status = 'pending') AS exists",
    [frameId],
  );
  return rows[0]?.exists ?? false;
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
  input: { frameId: string; model: string; compiledPrompt: string; inputSnapshot: unknown },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO generations (frame_id, status, model, compiled_prompt, input_snapshot)
     VALUES ($1, 'pending', $2, $3, $4)
     RETURNING id`,
    [input.frameId, input.model, input.compiledPrompt, JSON.stringify(input.inputSnapshot)],
  );
  return rows[0]!.id;
}

/** Returns false when the row no longer exists -- the frame or story was
 *  deleted while this generation was still in flight. */
export async function markSucceeded(id: string, imageKey: string, interactionId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE generations
        SET status = 'succeeded', image_key = $2, interaction_id = $3, completed_at = now()
      WHERE id = $1`,
    [id, imageKey, interactionId],
  );
  return rowCount === 1;
}

export async function markFailed(
  id: string,
  errorCode: GenerationErrorCode,
  errorMessage: string,
): Promise<void> {
  await query(
    `UPDATE generations
        SET status = 'failed', error_code = $2, error_message = $3, completed_at = now()
      WHERE id = $1`,
    [id, errorCode, errorMessage],
  );
}

/**
 * Point the frame at this generation only if nothing is selected yet
 * (TECH_SPEC.md section 7 step 3).
 *
 * The `IS NULL` guard is what makes invariant 8 real: regenerating appends and
 * never displaces an earlier, possibly better, result. Promoting the newest
 * would be a one-word change that silently breaks the core loop of the app.
 */
export async function selectIfUnset(generationId: string, frameId: string): Promise<void> {
  await query(
    `UPDATE frames SET selected_generation_id = $2, updated_at = now()
      WHERE id = $1 AND selected_generation_id IS NULL`,
    [frameId, generationId],
  );
}

/** Explicit user choice (POST /frames/:id/select-generation). */
export async function setSelectedGeneration(frameId: string, generationId: string): Promise<void> {
  await query(
    "UPDATE frames SET selected_generation_id = $2, updated_at = now() WHERE id = $1",
    [frameId, generationId],
  );
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
  const { rowCount } = await query(
    `UPDATE generations
        SET status = 'failed',
            error_code = 'abandoned',
            error_message = 'The server restarted while this generation was in flight.',
            completed_at = now()
      WHERE status = 'pending'
        AND created_at < now() - ($1 * interval '1 millisecond')`,
    [olderThanMs],
  );
  return rowCount ?? 0;
}

/** Generation object keys for a frame, collected before the rows are deleted. */
export async function imageKeysForFrame(frameId: string): Promise<string[]> {
  const { rows } = await query<{ imageKey: string }>(
    `SELECT image_key AS "imageKey" FROM generations WHERE frame_id = $1 AND image_key IS NOT NULL`,
    [frameId],
  );
  return rows.map((row) => row.imageKey);
}

/** Same, for every frame in a story. */
export async function imageKeysForStory(storyId: string): Promise<string[]> {
  const { rows } = await query<{ imageKey: string }>(
    `SELECT g.image_key AS "imageKey"
       FROM generations g
       JOIN frames f ON f.id = g.frame_id
      WHERE f.story_id = $1 AND g.image_key IS NOT NULL`,
    [storyId],
  );
  return rows.map((row) => row.imageKey);
}
