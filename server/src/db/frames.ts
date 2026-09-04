import type pg from "pg";
import type { ConceptType, GenerationStatus } from "@storyboards/shared";
import { query } from "./pool.js";

export interface FrameRow {
  id: string;
  storyId: string;
  position: number;
  description: string;
  selectedGenerationId: string | null;
  selectedImageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttachedConceptRow {
  ord: number;
  id: string;
  name: string;
  type: ConceptType;
  description: string;
  imageKey: string | null;
  imageMime: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GenerationRow {
  id: string;
  status: GenerationStatus;
  imageKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

// Frames carry no user_id of their own: a frame belongs to a story, which has an
// owner. One source of truth means the owner cannot drift out of sync, at the
// cost of a join on every query -- which is the right trade at this size.
const SELECT_FRAMES = `
  SELECT f.id,
         f.story_id AS "storyId",
         f.position,
         f.description,
         f.selected_generation_id AS "selectedGenerationId",
         g.image_key AS "selectedImageKey",
         f.created_at AS "createdAt",
         f.updated_at AS "updatedAt"
  FROM frames f
  JOIN stories st ON st.id = f.story_id
  LEFT JOIN generations g ON g.id = f.selected_generation_id
`;

export async function listFramesByStory(storyId: string, userId: string): Promise<FrameRow[]> {
  const { rows } = await query<FrameRow>(
    `${SELECT_FRAMES} WHERE f.story_id = $1 AND st.user_id = $2 ORDER BY f.position ASC`,
    [storyId, userId],
  );
  return rows;
}

export async function getFrameById(id: string, userId: string): Promise<FrameRow | null> {
  const { rows } = await query<FrameRow>(`${SELECT_FRAMES} WHERE f.id = $1 AND st.user_id = $2`, [id, userId]);
  return rows[0] ?? null;
}

/**
 * Attached concepts in frame_concepts.ord order.
 *
 * The ORDER BY is load-bearing, not cosmetic: this ordering becomes the
 * reference-image enumeration order in the compiled prompt (invariant 5).
 * Without it Postgres may return rows in any order and the model would attach
 * descriptions to the wrong subjects -- a failure that presents as the image
 * model being unreliable and points at nothing.
 */
export async function listFrameConcepts(frameId: string, userId: string): Promise<AttachedConceptRow[]> {
  const { rows } = await query<AttachedConceptRow>(
    `SELECT fc.ord,
            c.id,
            c.name,
            c.type,
            c.description,
            c.image_key  AS "imageKey",
            c.image_mime AS "imageMime",
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt"
     FROM frame_concepts fc
     JOIN concepts c ON c.id = fc.concept_id
     JOIN frames f   ON f.id = fc.frame_id
     JOIN stories st ON st.id = f.story_id
     WHERE fc.frame_id = $1 AND st.user_id = $2
     ORDER BY fc.ord ASC`,
    [frameId, userId],
  );
  return rows;
}

/** Generation history, newest first (TECH_SPEC.md section 12.4). */
export async function listFrameGenerations(frameId: string, userId: string): Promise<GenerationRow[]> {
  const { rows } = await query<GenerationRow>(
    `SELECT g.id,
            g.status,
            g.image_key     AS "imageKey",
            g.error_code    AS "errorCode",
            g.error_message AS "errorMessage",
            g.created_at    AS "createdAt",
            g.completed_at  AS "completedAt"
     FROM generations g
     JOIN frames f   ON f.id = g.frame_id
     JOIN stories st ON st.id = f.story_id
     WHERE g.frame_id = $1 AND st.user_id = $2
     ORDER BY g.created_at DESC`,
    [frameId, userId],
  );
  return rows;
}

export async function maxPositionInStory(
  client: pg.PoolClient,
  storyId: string,
  userId: string,
): Promise<number | null> {
  const { rows } = await client.query<{ max: number | null }>(
    `SELECT max(f.position) AS max FROM frames f
       JOIN stories st ON st.id = f.story_id
      WHERE f.story_id = $1 AND st.user_id = $2`,
    [storyId, userId],
  );
  return rows[0]?.max ?? null;
}

export async function insertFrame(
  client: pg.PoolClient,
  storyId: string,
  userId: string,
  position: number,
  description: string,
): Promise<string | null> {
  // INSERT ... SELECT so the ownership check and the write are one statement:
  // no row is created if the story is not the caller's.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO frames (story_id, position, description)
     SELECT $1, $3, $4 FROM stories WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [storyId, userId, position, description],
  );
  return rows[0]?.id ?? null;
}

export async function updateFrameFields(
  client: pg.PoolClient,
  id: string,
  userId: string,
  patch: { description?: string; position?: number },
): Promise<boolean> {
  // COALESCE rather than a built SET clause. Unambiguous because both columns
  // are NOT NULL, so a null parameter can only mean "not supplied".
  const { rowCount } = await client.query(
    `UPDATE frames SET
       description = COALESCE($2, description),
       position    = COALESCE($3, position),
       updated_at  = now()
     WHERE id = $1
       AND story_id IN (SELECT id FROM stories WHERE user_id = $4)`,
    [id, patch.description ?? null, patch.position ?? null, userId],
  );
  return rowCount === 1;
}

/** Which of the given concept ids actually exist. Used to return a named 422
 * instead of letting a foreign-key violation surface as a 500. */
export async function findExistingConceptIds(
  client: pg.PoolClient,
  ids: string[],
  userId: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // Scoped by owner, so attaching another account's concept fails as
  // "unknown_concept" rather than succeeding and leaking its description into a
  // compiled prompt.
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM concepts WHERE id = ANY($1::uuid[]) AND user_id = $2",
    [ids, userId],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Replace a frame's attachment set wholesale. Array index becomes ord.
 *
 * The DELETE must precede the INSERT within one transaction: the unique index
 * on (frame_id, ord) means any reordering that reuses an existing ord collides
 * otherwise. unnest with explicit array casts keeps this fully parameterized --
 * no SQL built by string concatenation.
 */
export async function replaceFrameConcepts(
  client: pg.PoolClient,
  frameId: string,
  conceptIds: string[],
): Promise<void> {
  await client.query("DELETE FROM frame_concepts WHERE frame_id = $1", [frameId]);
  if (conceptIds.length === 0) return;

  await client.query(
    `INSERT INTO frame_concepts (frame_id, concept_id, ord)
     SELECT $1, c.id, c.ord
     FROM unnest($2::uuid[], $3::int[]) AS c(id, ord)`,
    [frameId, conceptIds, conceptIds.map((_, index) => index)],
  );
}

export async function deleteFrame(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM frames WHERE id = $1 AND story_id IN (SELECT id FROM stories WHERE user_id = $2)",
    [id, userId],
  );
  return rowCount === 1;
}
