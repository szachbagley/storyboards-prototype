import { describe, expect, it } from "vitest";
import { GenerateFrameSchema, UpdateFrameSchema } from "@storyboards/shared";
import { parseGenerationSnapshot } from "../src/services/generationSnapshot.js";

const frameId = "8974bf8c-ad34-4880-9239-93548115fb3f";
const historical = {
  frameDescription: "  Authored scene.  ",
  aspectRatio: "16:9",
  imageSize: "1K",
  concepts: [{
    id: frameId, ord: 0, name: "Subject", type: "character",
    description: "Identity only", imageKey: null,
  }],
};

describe("generation snapshot provenance", () => {
  it("classifies a historical shape as legacy, never known no-continuity", () => {
    expect(parseGenerationSnapshot(historical)).toEqual({ kind: "legacy" });
  });

  it("classifies explicit V2 null continuity as known no-continuity", () => {
    const parsed = parseGenerationSnapshot({
      ...historical,
      schemaVersion: 2,
      compilerVersion: "explicit-continuity-v1",
      capturedAt: "2026-10-26T00:00:00.000Z",
      concepts: [{
        ...historical.concepts[0], imageMime: null, imageSha256: null,
      }],
      continuity: null,
    });
    expect(parsed.kind).toBe("v2");
    if (parsed.kind === "v2") expect(parsed.snapshot.continuity).toBeNull();
  });

  it("keeps future and malformed old records unknown", () => {
    expect(parseGenerationSnapshot({ ...historical, schemaVersion: 3 })).toEqual({ kind: "unknown" });
    expect(parseGenerationSnapshot({ ...historical, concepts: "broken" })).toEqual({ kind: "unknown" });
    expect(parseGenerationSnapshot(null)).toEqual({ kind: "unknown" });
  });
});

describe("additive continuity request validation", () => {
  it("distinguishes omitted source, explicit null, and a UUID", () => {
    expect(UpdateFrameSchema.parse({ description: "scene" }).continuitySourceFrameId).toBeUndefined();
    expect(UpdateFrameSchema.parse({ continuitySourceFrameId: null }).continuitySourceFrameId).toBeNull();
    expect(UpdateFrameSchema.parse({ continuitySourceFrameId: frameId }).continuitySourceFrameId).toBe(frameId);
    expect(GenerateFrameSchema.parse({})).toEqual({});
    expect(GenerateFrameSchema.parse({ expectedContinuitySourceFrameId: null })
      .expectedContinuitySourceFrameId).toBeNull();
  });

  it("rejects malformed request and source IDs at the boundary", () => {
    expect(GenerateFrameSchema.safeParse({ requestId: "bad" }).success).toBe(false);
    expect(UpdateFrameSchema.safeParse({ continuitySourceFrameId: "bad" }).success).toBe(false);
  });
});
