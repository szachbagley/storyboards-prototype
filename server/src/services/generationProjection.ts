import type { GenerationSummaryDto } from "@storyboards/shared";
import { sourceStillExists, type GenerationRow } from "../db/frames.js";
import { parseGenerationSnapshot } from "./generationSnapshot.js";
import { getPresignedUrl } from "./s3.js";

export async function generationToDto(row: GenerationRow, userId: string): Promise<GenerationSummaryDto> {
  const parsed = parseGenerationSnapshot(row.inputSnapshot);
  let continuity: GenerationSummaryDto["continuity"];
  if (parsed.kind === "v2") {
    const source = parsed.snapshot.continuity;
    continuity = { provenance: "known", source: source && {
      frameId: source.sourceFrameId, generationId: source.sourceGenerationId,
      sourceFrameDeleted: !(await sourceStillExists(row.frameId, source.sourceFrameId, userId)),
    } };
  } else {
    continuity = { provenance: parsed.kind };
  }
  return {
    continuity,
    id: row.id,
    status: row.status,
    imageUrl: row.status === "succeeded" && row.imageKey ? await getPresignedUrl(row.imageKey) : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
