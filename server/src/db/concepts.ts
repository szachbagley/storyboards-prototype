import type { ConceptType } from "@storyboards/shared";
import { query } from "./pool.js";

/** A concepts row, aliased to camelCase in SQL so rows arrive DTO-shaped. */
export interface ConceptRow {
  id: string;
  name: string;
  type: ConceptType;
  description: string;
  imageKey: string | null;
  imageMime: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id,
  name,
  type,
  description,
  image_key  AS "imageKey",
  image_mime AS "imageMime",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

// Every read and write is scoped to the owning user. A missing `user_id`
// predicate here does not error -- it silently exposes one account's work to
// another -- which is why the ownership matrix in identity-plan.md 6.2 exercises
// every endpoint rather than spot-checking.

/** Newest first, so a freshly created concept appears next to the "+" tile in
 * the grid. Matches the concepts_user_idx composite index. */
export async function listConcepts(userId: string): Promise<ConceptRow[]> {
  const { rows } = await query<ConceptRow>(
    `SELECT ${COLUMNS} FROM concepts WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/** Returns null for another user's concept, exactly as for one that does not
 *  exist: the caller turns both into 404, so the endpoint is not an existence
 *  oracle. */
export async function getConceptById(id: string, userId: string): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(
    `SELECT ${COLUMNS} FROM concepts WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function insertConcept(userId: string, name: string, type: ConceptType): Promise<ConceptRow> {
  const { rows } = await query<ConceptRow>(
    `INSERT INTO concepts (user_id, name, type) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
    [userId, name, type],
  );
  // INSERT ... RETURNING always yields exactly one row or throws.
  return rows[0]!;
}

/**
 * Patch any subset of the three editable fields without building SQL by
 * concatenation. COALESCE is unambiguous here precisely because all three
 * columns are NOT NULL: a null parameter can only mean "not supplied", never a
 * value the caller wants to store.
 *
 * The ::concept_type cast is required. Without it Postgres cannot unify a text
 * parameter with an enum column and the statement fails at parse time with
 * "COALESCE types text and concept_type cannot be matched".
 */
export async function updateConcept(
  id: string,
  userId: string,
  patch: { name?: string; type?: ConceptType; description?: string },
): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(
    `UPDATE concepts SET
       name        = COALESCE($2, name),
       type        = COALESCE($3::concept_type, type),
       description = COALESCE($4, description),
       updated_at  = now()
     WHERE id = $1 AND user_id = $5
     RETURNING ${COLUMNS}`,
    [id, patch.name ?? null, patch.type ?? null, patch.description ?? null, userId],
  );
  return rows[0] ?? null;
}

export async function setConceptImage(
  id: string,
  userId: string,
  imageKey: string,
  imageMime: string,
): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(
    `UPDATE concepts SET image_key = $2, image_mime = $3, updated_at = now()
     WHERE id = $1 AND user_id = $4 RETURNING ${COLUMNS}`,
    [id, imageKey, imageMime, userId],
  );
  return rows[0] ?? null;
}

/** Returns the deleted row so the caller can clean up its S3 object, or null if
 * there was nothing to delete. Attachments in frame_concepts cascade. */
export async function deleteConcept(id: string, userId: string): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(
    `DELETE FROM concepts WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
    [id, userId],
  );
  return rows[0] ?? null;
}
