import sharp from "sharp";
import { REFERENCE_IMAGE_JPEG_QUALITY, REFERENCE_IMAGE_MAX_EDGE } from "@storyboards/shared";
import { AppError } from "../lib/AppError.js";

/**
 * Preprocess an uploaded reference image (TECH_SPEC.md section 9).
 *
 * Pure: buffer in, buffer out. No S3, no database, no clock.
 *
 * Order matters more than it looks:
 *
 * - .rotate() with no arguments must come first. The spec says to strip EXIF,
 *   and sharp strips metadata by default -- but orientation lives in EXIF. A
 *   phone photo is commonly stored sideways with a tag telling viewers to turn
 *   it. Dropping that tag without applying it yields a rotated reference image,
 *   which then teaches the model that the subject lies on its side in every
 *   frame generated from the concept. Bare .rotate() bakes the orientation into
 *   the pixels and then discards the tag.
 *
 * - fit "inside" with withoutEnlargement caps the long edge while preserving
 *   aspect ratio and leaves already-small images untouched. A plain
 *   resize(1024, 1024) would crop to a square and cut off part of the subject.
 *
 * - .flatten() must precede .jpeg(). JPEG has no alpha channel, so a reference
 *   uploaded as a transparent PNG -- a very likely way to supply a prop --
 *   composites onto black without it. White is the neutral plate.
 */
export async function preprocessReferenceImage(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input, { failOn: "error" })
      .rotate()
      .resize({
        width: REFERENCE_IMAGE_MAX_EDGE,
        height: REFERENCE_IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: REFERENCE_IMAGE_JPEG_QUALITY })
      .toBuffer();
  } catch (err) {
    // sharp throws on anything it cannot decode, which is the authoritative
    // check that the upload is actually an image. The declared MIME type is
    // only a hint and is never trusted.
    throw new AppError(400, "invalid_image", "The uploaded file is not a readable image", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}
