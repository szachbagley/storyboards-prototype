import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONCEPT_TYPES } from "@storyboards/shared";
import {
  META_PROMPT_BY_TYPE,
  SHARED_PREAMBLE,
  buildDescriptionPrompt,
} from "../src/services/descriptionPrompts.js";

/**
 * The meta-prompt is the first of the three places the identity-only rule is
 * enforced (TECH_SPEC.md section 8.2), and drift in it fails silently: nothing
 * errors, descriptions simply begin carrying pose, lighting and environment,
 * and the symptom presents as the image model being unreliable.
 *
 * This test re-parses the skill at test time and asserts byte equality against
 * the transcribed constants. Reading the skill here is safe in a way that
 * reading it at runtime would not be -- the test always runs inside the repo,
 * whereas the server may be deployed without .agents/.
 */
const SKILL_PATH = fileURLToPath(
  new URL("../../.agents/skills/storyboard-prompt-compiler/SKILL.md", import.meta.url),
);

const skill = readFileSync(SKILL_PATH, "utf8");
const section = skill.split("## Description-generation meta-prompts")[1]?.split("## Frame prompt structure")[0] ?? "";

function fencedBlock(heading: string): string {
  const match = new RegExp(`### ${heading}\\n\\n\`\`\`\\n(.*?)\\n\`\`\``, "s").exec(section);
  return match?.[1] ?? "";
}

describe("meta-prompt fidelity against the storyboard-prompt-compiler skill", () => {
  // Guard against the whole suite passing vacuously: if the skill moved or the
  // headings changed, every extraction would be "" and equality assertions
  // between two empty strings would pass while testing nothing.
  it("actually located and parsed the skill", () => {
    expect(section.length).toBeGreaterThan(500);
    expect(fencedBlock("Shared preamble")).not.toBe("");
    for (const type of CONCEPT_TYPES) expect(fencedBlock(type)).not.toBe("");
  });

  it("SHARED_PREAMBLE is byte-identical to the skill", () => {
    expect(SHARED_PREAMBLE).toBe(fencedBlock("Shared preamble"));
  });

  it.each(CONCEPT_TYPES)("the %s meta-prompt is byte-identical to the skill", (type) => {
    expect(META_PROMPT_BY_TYPE[type]).toBe(fencedBlock(type));
  });

  it("covers every concept type with no extras", () => {
    expect(Object.keys(META_PROMPT_BY_TYPE).sort()).toEqual([...CONCEPT_TYPES].sort());
  });
});

describe("buildDescriptionPrompt", () => {
  it.each(CONCEPT_TYPES)("combines the preamble and the %s block", (type) => {
    const prompt = buildDescriptionPrompt(type);
    expect(prompt).toContain(SHARED_PREAMBLE);
    expect(prompt).toContain(META_PROMPT_BY_TYPE[type]);
    expect(prompt).toBe(`${SHARED_PREAMBLE}\n\n${META_PROMPT_BY_TYPE[type]}`);
  });

  it.each(CONCEPT_TYPES)("carries the identity-only exclusion clause for %s", (type) => {
    const prompt = buildDescriptionPrompt(type);
    expect(prompt).toContain("Do NOT describe: pose, action, gesture");
    // The full exclusion list is what keeps scene content out of descriptions.
    for (const excluded of ["lighting", "camera angle", "shot", "mood"]) {
      expect(prompt).toContain(excluded);
    }
  });

  it.each(CONCEPT_TYPES)("does not interpolate a concept name into the %s prompt", (type) => {
    expect(buildDescriptionPrompt(type)).not.toMatch(/\$\{|\bundefined\b/);
  });
});
