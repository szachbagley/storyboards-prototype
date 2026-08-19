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
  LEFT JOIN generations g ON g.id = f.selected_generation_id
`;

export async function listFramesByStory(storyId: string): Promise<FrameRow[]> {
  const { rows } = await query<FrameRow>(
    `${SELECT_FRAMES} WHERE f.story_id = $1 ORDER BY f.position ASC`,
    [storyId],
  );
  return rows;
}

export async function getFrameById(id: string): Promise<FrameRow | null> {
  const { rows } = await query<FrameRow>(`${SELECT_FRAMES} WHERE f.id = $1`, [id]);
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
export async function listFrameConcepts(frameId: string): Promise<AttachedConceptRow[]> {
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
     WHERE fc.frame_id = $1
     ORDER BY fc.ord ASC`,
    [frameId],
  );
  return rows;
}

/** Generation history, newest first (TECH_SPEC.md section 12.4). */
export async function listFrameGenerations(frameId: string): Promise<GenerationRow[]> {
  const { rows } = await query<GenerationRow>(
    `SELECT id,
            status,
            image_key     AS "imageKey",
            error_code    AS "errorCode",
            error_message AS "errorMessage",
            created_at    AS "createdAt",
            completed_at  AS "completedAt"
     FROM generations
     WHERE frame_id = $1
     ORDER BY created_at DESC`,
    [frameId],
  );
  return rows;
}

export async function maxPositionInStory(client: pg.PoolClient, storyId: string): Promise<number | null> {
  const { rows } = await client.query<{ max: number | null }>(
    "SELECT max(position) AS max FROM frames WHERE story_id = $1",
    [storyId],
  );
  return rows[0]?.max ?? null;
}

export async function insertFrame(
  client: pg.PoolClient,
  storyId: string,
  position: number,
  description: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO frames (story_id, position, description) VALUES ($1, $2, $3) RETURNING id",
    [storyId, position, description],
  );
  return rows[0]!.id;
}

export async function updateFrameFields(
  client: pg.PoolClient,
  id: string,
  patch: { description?: string; position?: number },
): Promise<boolean> {
  // COALESCE rather than a built SET clause. Unambiguous because both columns
  // are NOT NULL, so a null parameter can only mean "not supplied".
  const { rowCount } = await client.query(
    `UPDATE frames SET
       description = COALESCE($2, description),
       position    = COALESCE($3, position),
       updated_at  = now()
     WHERE id = $1`,
    [id, patch.description ?? null, patch.position ?? null],
  );
  return rowCount === 1;
}

/** Which of the given concept ids actually exist. Used to return a named 422
 * instead of letting a foreign-key violation surface as a 500. */
export async function findExistingConceptIds(client: pg.PoolClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM concepts WHERE id = ANY($1::uuid[])",
    [ids],
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

export async function deleteFrame(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM frames WHERE id = $1", [id]);
  return rowCount === 1;
}
