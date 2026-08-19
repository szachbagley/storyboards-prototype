import { IMAGE_MIME_TYPE, type ConceptDto, type CreateConceptBody, type UpdateConceptBody } from "@storyboards/shared";
import * as db from "../db/concepts.js";
import type { ConceptRow } from "../db/concepts.js";
import { AppError } from "../lib/AppError.js";
import { preprocessReferenceImage } from "./imagePreprocess.js";
import { conceptImageKey, deleteObject, getPresignedUrl, putObject } from "./s3.js";

async function toDto(row: ConceptRow): Promise<ConceptDto> {
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

function notFound(id: string): AppError {
  return new AppError(404, "not_found", `No concept with id ${id}`);
}

export async function listConcepts(): Promise<ConceptDto[]> {
  const rows = await db.listConcepts();
  // Presigning is local signature computation, not a network call, so fanning
  // out over the list costs nothing.
  return Promise.all(rows.map(toDto));
}

export async function getConcept(id: string): Promise<ConceptDto> {
  const row = await db.getConceptById(id);
  if (!row) throw notFound(id);
  return toDto(row);
}

export async function createConcept(body: CreateConceptBody): Promise<ConceptDto> {
  return toDto(await db.insertConcept(body.name, body.type));
}

export async function updateConcept(id: string, body: UpdateConceptBody): Promise<ConceptDto> {
  const row = await db.updateConcept(id, body);
  if (!row) throw notFound(id);
  return toDto(row);
}

export async function deleteConcept(id: string): Promise<void> {
  const row = await db.deleteConcept(id);
  if (!row) throw notFound(id);

  if (row.imageKey) {
    // Best effort. The row is already gone, so a failed object delete must not
    // fail the request -- it leaves an unreachable object, which is the milder
    // outcome. There is no orphan sweeper in this system, which is why the
    // delete happens inline at all.
    try {
      await deleteObject(row.imageKey);
    } catch (err) {
      console.error(`[concepts] failed to delete S3 object ${row.imageKey}`, err);
    }
  }
}

export async function setConceptImage(id: string, upload: Buffer): Promise<ConceptDto> {
  const existing = await db.getConceptById(id);
  if (!existing) throw notFound(id);

  const processed = await preprocessReferenceImage(upload);
  const key = conceptImageKey(id);

  // S3 first, then the database. If the database write fails afterwards, the
  // bucket holds an object no row references -- harmless, and overwritten by
  // the next upload for this concept. Reversed, a row would point at an object
  // that does not exist and every generation including this concept would fail
  // on a missing key. Prefer the orphan.
  await putObject(key, processed, IMAGE_MIME_TYPE);

  const row = await db.setConceptImage(id, key, IMAGE_MIME_TYPE);
  if (!row) throw notFound(id);
  return toDto(row);
}
