import { z } from "zod";
import { ASPECT_RATIO, CONCEPT_TYPES, IMAGE_SIZE } from "@storyboards/shared";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotConcept = z.object({
  id: z.uuid(),
  ord: z.number().int().nonnegative(),
  name: z.string(),
  type: z.enum(CONCEPT_TYPES),
  description: z.string(),
  imageKey: z.string().nullable(),
  imageMime: z.string().nullable(),
  imageSha256: sha256.nullable(),
});

const snapshotV2 = z.object({
  schemaVersion: z.literal(2),
  compilerVersion: z.literal("explicit-continuity-v1"),
  capturedAt: z.iso.datetime(),
  frameDescription: z.string(),
  aspectRatio: z.literal(ASPECT_RATIO),
  imageSize: z.literal(IMAGE_SIZE),
  concepts: z.array(snapshotConcept),
  continuity: z.object({
    sourceFrameId: z.uuid(),
    sourceGenerationId: z.uuid(),
    sourcePosition: z.number().finite(),
    sourceImageKey: z.string(),
    sourceImageSha256: sha256,
    imageKey: z.string(),
    imageMime: z.literal("image/jpeg"),
    imageSha256: sha256,
  }).nullable(),
});

export type GenerationInputSnapshotV2 = z.infer<typeof snapshotV2>;

// Only the historical shape we actually wrote counts as legacy. A malformed
// record or a future version remains unknown, never inferred as no continuity.
const legacySnapshot = z.object({
  frameDescription: z.string(),
  aspectRatio: z.literal(ASPECT_RATIO),
  imageSize: z.literal(IMAGE_SIZE),
  concepts: z.array(snapshotConcept.omit({ imageMime: true, imageSha256: true })),
});

export type ParsedGenerationSnapshot =
  | { kind: "v2"; snapshot: GenerationInputSnapshotV2 }
  | { kind: "legacy" }
  | { kind: "unknown" };

export function parseGenerationSnapshot(value: unknown): ParsedGenerationSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "unknown" };
  if ("schemaVersion" in value) {
    const parsed = snapshotV2.safeParse(value);
    return parsed.success ? { kind: "v2", snapshot: parsed.data } : { kind: "unknown" };
  }
  return legacySnapshot.safeParse(value).success ? { kind: "legacy" } : { kind: "unknown" };
}
