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

/** Newest first, so a freshly created concept appears next to the "+" tile in
 * the grid. The spec does not prescribe an order. */
export async function listConcepts(): Promise<ConceptRow[]> {
  const { rows } = await query<ConceptRow>(`SELECT ${COLUMNS} FROM concepts ORDER BY created_at DESC`);
  return rows;
}

export async function getConceptById(id: string): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(`SELECT ${COLUMNS} FROM concepts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertConcept(name: string, type: ConceptType): Promise<ConceptRow> {
  const { rows } = await query<ConceptRow>(
    `INSERT INTO concepts (name, type) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [name, type],
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
  patch: { name?: string; type?: ConceptType; description?: string },
): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(
    `UPDATE concepts SET
       name        = COALESCE($2, name),
       type        = COALESCE($3::concept_type, type),
       description = COALESCE($4, description),
       updated_at  = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, patch.name ?? null, patch.type ?? null, patch.description ?? null],
  );
  return rows[0] ?? null;
}

export async function setConceptImage(id: string, imageKey: string, imageMime: string): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(
    `UPDATE concepts SET image_key = $2, image_mime = $3, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, imageKey, imageMime],
  );
  return rows[0] ?? null;
}

/** Returns the deleted row so the caller can clean up its S3 object, or null if
 * there was nothing to delete. Attachments in frame_concepts cascade. */
export async function deleteConcept(id: string): Promise<ConceptRow | null> {
  const { rows } = await query<ConceptRow>(`DELETE FROM concepts WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
  return rows[0] ?? null;
}
