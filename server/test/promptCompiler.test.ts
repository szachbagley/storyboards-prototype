import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_CHARACTER_CONCEPTS, MAX_TOTAL_CONCEPTS, type ConceptType } from "@storyboards/shared";
import { AppError } from "../src/lib/AppError.js";
import {
  FORMAT_PREAMBLE,
  OUTPUT_CONSTRAINTS,
  compileFramePrompt,
  validateFrameForGeneration,
  type CompilerConcept,
} from "../src/services/promptCompiler.js";

/**
 * The prompt compiler. Every rule here fails SILENTLY when broken -- a
 * violation produces plausible-looking but degraded images, never an error --
 * which is why this is the one component CLAUDE.md calls worth real tests.
 */

const SKILL_PATH = fileURLToPath(
  new URL("../../.claude/skills/storyboard-prompt-compiler/SKILL.md", import.meta.url),
);
const skill = readFileSync(SKILL_PATH, "utf8");

function constantsSection(): string {
  return skill.split("### Constants")[1]?.split("## Compiler rules")[0] ?? "";
}

function fencedConstant(label: string): string {
  const blocks = [...constantsSection().matchAll(/```\n(.*?)\n```/gs)].map((m) => m[1] ?? "");
  const block = blocks.find((b) => b.startsWith(`${label}:`));
  return block ? block.slice(label.length + 2) : "";
}

/** Concepts carry a unique sentinel as their base64 so an image part can be
 *  traced back to the concept it came from. */
function concept(
  name: string,
  type: ConceptType,
  opts: { image?: boolean; description?: string } = {},
): CompilerConcept {
  const withImage = opts.image ?? true;
  return {
    id: `id-${name}`,
    name,
    type,
    description: opts.description ?? `${name} description`,
    imageBase64: withImage ? `SENTINEL-${name}` : null,
    imageMimeType: withImage ? "image/jpeg" : null,
  };
}

const SCENE = "Spaceman stands menacingly on a red planet.";

describe("constant fidelity against the storyboard-prompt-compiler skill", () => {
  // Guard against vacuous passing: if the skill moved or headings changed,
  // every extraction would be "" and equality would compare "" to "".
  it("actually located and parsed the skill", () => {
    expect(constantsSection().length).toBeGreaterThan(200);
    expect(fencedConstant("FORMAT_PREAMBLE")).not.toBe("");
    expect(fencedConstant("OUTPUT_CONSTRAINTS")).not.toBe("");
  });

  it("FORMAT_PREAMBLE is byte-identical to the skill", () => {
    expect(FORMAT_PREAMBLE).toBe(fencedConstant("FORMAT_PREAMBLE"));
  });

  it("OUTPUT_CONSTRAINTS is byte-identical to the skill", () => {
    expect(OUTPUT_CONSTRAINTS).toBe(fencedConstant("OUTPUT_CONSTRAINTS"));
  });

  it("carries no visual style, which is a deliberate v1 scope decision", () => {
    for (const styleWord of ["style", "cinematic", "photoreal", "illustration", "colour palette"]) {
      expect(FORMAT_PREAMBLE.toLowerCase()).not.toContain(styleWord);
    }
  });
});

/**
 * INVARIANT 5. The single most important assertion in the project.
 *
 * Parses every "Reference image N — <Name>" line out of the compiled prompt and
 * checks that parts[N] carries that concept's sentinel. parts[0] is the text
 * part, so the Nth reference image is at parts[N].
 */
function assertEnumerationMatchesParts(concepts: CompilerConcept[]): void {
  const { prompt, parts } = compileFramePrompt({ frameDescription: SCENE, concepts });

  const labelled = [...prompt.matchAll(/^Reference image (\d+) — (.+?) \(/gm)].map((m) => ({
    index: Number(m[1]),
    name: m[2]!,
  }));

  const withImages = concepts.filter((c) => c.imageBase64 !== null);
  expect(labelled).toHaveLength(withImages.length);
  expect(parts).toHaveLength(withImages.length + 1);

  // Indices are 1..n with no gaps -- an imageless concept must not consume one.
  expect(labelled.map((l) => l.index)).toEqual(withImages.map((_, i) => i + 1));

  for (const { index, name } of labelled) {
    const part = parts[index];
    expect(part?.type).toBe("image");
    expect(part && part.type === "image" ? part.data : null).toBe(`SENTINEL-${name}`);
  }
}

describe("invariant 5: enumeration order matches image part order", () => {
  it("all concepts have images", () => {
    assertEnumerationMatchesParts([
      concept("Alpha", "character"),
      concept("Bravo", "setting"),
      concept("Charlie", "prop"),
    ]);
  });

  it("an imageless concept leads", () => {
    assertEnumerationMatchesParts([
      concept("Alpha", "character", { image: false }),
      concept("Bravo", "setting"),
      concept("Charlie", "prop"),
    ]);
  });

  it("an imageless concept is interleaved", () => {
    assertEnumerationMatchesParts([
      concept("Alpha", "character"),
      concept("Bravo", "setting", { image: false }),
      concept("Charlie", "prop"),
    ]);
  });

  it("an imageless concept trails", () => {
    assertEnumerationMatchesParts([
      concept("Alpha", "character"),
      concept("Bravo", "setting"),
      concept("Charlie", "prop", { image: false }),
    ]);
  });

  it("every concept is imageless", () => {
    assertEnumerationMatchesParts([
      concept("Alpha", "character", { image: false }),
      concept("Bravo", "prop", { image: false }),
    ]);
  });

  it("preserves the given order rather than sorting", () => {
    // Deliberately reverse-alphabetical so a sort would be visible.
    const { prompt } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Zulu", "character"), concept("Alpha", "prop"), concept("Mike", "setting")],
    });
    expect(prompt).toContain("Reference image 1 — Zulu (character)");
    expect(prompt).toContain("Reference image 2 — Alpha (prop)");
    expect(prompt).toContain("Reference image 3 — Mike (setting)");
  });
});

describe("structure and formatting", () => {
  it("orders sections: preamble, concepts, scene, constraints", () => {
    const { prompt } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Alpha", "character")],
    });
    expect(prompt.indexOf(FORMAT_PREAMBLE)).toBe(0);
    expect(prompt.indexOf("Reference image 1")).toBeGreaterThan(0);
    expect(prompt.indexOf("Scene:")).toBeGreaterThan(prompt.indexOf("Reference image 1"));
    expect(prompt.indexOf(OUTPUT_CONSTRAINTS)).toBeGreaterThan(prompt.indexOf("Scene:"));
    expect(prompt.endsWith(OUTPUT_CONSTRAINTS)).toBe(true);
  });

  it("separates the index from the name with an em-dash, not a hyphen", () => {
    const { prompt } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Alpha", "character")],
    });
    expect(prompt).toContain("Reference image 1 — Alpha");
    expect(prompt).not.toContain("Reference image 1 - Alpha");
  });

  it.each(["character", "setting", "prop"] as const)("includes the (%s) parenthetical", (type) => {
    const { prompt } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Alpha", type)],
    });
    expect(prompt).toContain(`Alpha (${type}):`);
  });

  it("lists an imageless concept by name with no Reference image prefix", () => {
    const { prompt, parts } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Gobby", "prop", { image: false })],
    });
    expect(prompt).toContain("Gobby (prop): Gobby description");
    expect(prompt).not.toContain("Reference image");
    expect(parts).toHaveLength(1);
  });

  it("emits no dangling colon when a concept has no description yet", () => {
    const { prompt } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Alpha", "character", { description: "" })],
    });
    expect(prompt).toContain("Reference image 1 — Alpha (character)\n");
    expect(prompt).not.toContain("(character): \n");
    expect(prompt).not.toMatch(/\(character\):\s*$/m);
  });

  it("omits the concept block entirely when nothing is attached", () => {
    const { prompt, parts } = compileFramePrompt({ frameDescription: SCENE, concepts: [] });
    expect(prompt).toBe(`${FORMAT_PREAMBLE}\n\nScene: ${SCENE}\n\n${OUTPUT_CONSTRAINTS}`);
    expect(prompt).not.toMatch(/\n\n\n/);
    expect(parts).toEqual([{ type: "text", text: prompt }]);
  });

  it("puts the text part first and it equals the prompt", () => {
    const { prompt, parts } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Alpha", "character")],
    });
    expect(parts[0]).toEqual({ type: "text", text: prompt });
  });

  it("defaults a missing mime type rather than emitting undefined", () => {
    const { parts } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [{ ...concept("Alpha", "character"), imageMimeType: null }],
    });
    expect(parts[1]).toMatchObject({ type: "image", mime_type: "image/jpeg" });
  });
});

describe("the frame description is inserted verbatim", () => {
  it("passes through whitespace, newlines and punctuation byte-identically", () => {
    const gnarly =
      "  Spaceman stands\tmenacingly — on a red planet;\n\nlight is warm & low, the sky is \"burnt orange\";  medium shot  ";
    const { prompt } = compileFramePrompt({
      frameDescription: gnarly,
      concepts: [concept("Alpha", "character")],
    });
    expect(prompt).toContain(`Scene: ${gnarly}`);
  });

  it("does not trim leading or trailing whitespace", () => {
    const padded = "   a padded description   ";
    const { prompt } = compileFramePrompt({ frameDescription: padded, concepts: [] });
    expect(prompt).toContain(`Scene: ${padded}`);
    expect(prompt).not.toContain("Scene: a padded description\n");
  });

  it("does not alter a concept description either", () => {
    const desc = "  A weathered   astronaut — matte off-white.  ";
    const { prompt } = compileFramePrompt({
      frameDescription: SCENE,
      concepts: [concept("Alpha", "character", { description: desc })],
    });
    expect(prompt).toContain(`Alpha (character): ${desc}`);
  });
});

describe("the skill's worked example", () => {
  it("is reproduced exactly, modulo the skill's markdown line wrapping", () => {
    const worked = skill.split("## Worked example")[1] ?? "";
    const quotes = [...worked.matchAll(/^> (.+)$/gm)].map((m) => m[1]!);
    const [conceptDescription, frameDescription] = quotes;
    const expected = /\*\*Compiled:\*\*\n```\n(.*?)\n```/s.exec(worked)?.[1] ?? "";

    expect(conceptDescription).toBeTruthy();
    expect(frameDescription).toBeTruthy();
    expect(expected).toBeTruthy();

    const { prompt } = compileFramePrompt({
      frameDescription: frameDescription!,
      concepts: [
        {
          id: "spaceman",
          name: "Spaceman",
          type: "character",
          description: conceptDescription!,
          imageBase64: "SENTINEL-Spaceman",
          imageMimeType: "image/jpeg",
        },
      ],
    });

    // The skill wraps its expected block for markdown readability, so the two
    // differ only in newline-versus-space placement. Collapsing whitespace runs
    // compares the exact word sequence; asserting equal character counts proves
    // nothing was added or dropped by the normalization.
    const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(collapse(prompt)).toBe(collapse(expected));
    expect(prompt).toHaveLength(expected.length);
  });
});

describe("validation caps", () => {
  const characters = (n: number) =>
    Array.from({ length: n }, (_, i) => concept(`Char${i}`, "character"));
  const props = (n: number) => Array.from({ length: n }, (_, i) => concept(`Prop${i}`, "prop"));

  function codeOf(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.status).toBe(422);
      return appErr.code;
    }
    throw new Error("expected validation to reject");
  }

  it(`accepts exactly ${MAX_CHARACTER_CONCEPTS} character concepts`, () => {
    expect(() =>
      validateFrameForGeneration({ frameDescription: SCENE, concepts: characters(MAX_CHARACTER_CONCEPTS) }),
    ).not.toThrow();
  });

  it(`rejects ${MAX_CHARACTER_CONCEPTS + 1} character concepts`, () => {
    expect(
      codeOf(() =>
        validateFrameForGeneration({
          frameDescription: SCENE,
          concepts: characters(MAX_CHARACTER_CONCEPTS + 1),
        }),
      ),
    ).toBe("too_many_characters");
  });

  it("names the actual numbers in the message", () => {
    try {
      validateFrameForGeneration({ frameDescription: SCENE, concepts: characters(6) });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as AppError).message).toContain("6");
      expect((err as AppError).message).toContain(String(MAX_CHARACTER_CONCEPTS));
    }
  });

  it(`accepts exactly ${MAX_TOTAL_CONCEPTS} total concepts`, () => {
    expect(() =>
      validateFrameForGeneration({ frameDescription: SCENE, concepts: props(MAX_TOTAL_CONCEPTS) }),
    ).not.toThrow();
  });

  it(`rejects ${MAX_TOTAL_CONCEPTS + 1} total concepts`, () => {
    expect(
      codeOf(() =>
        validateFrameForGeneration({ frameDescription: SCENE, concepts: props(MAX_TOTAL_CONCEPTS + 1) }),
      ),
    ).toBe("too_many_concepts");
  });

  it("treats the two caps independently", () => {
    // 4 characters + 6 props = 10 total: at both limits, still valid.
    expect(() =>
      validateFrameForGeneration({
        frameDescription: SCENE,
        concepts: [...characters(MAX_CHARACTER_CONCEPTS), ...props(MAX_TOTAL_CONCEPTS - MAX_CHARACTER_CONCEPTS)],
      }),
    ).not.toThrow();
  });

  it("rejects an empty frame description", () => {
    expect(codeOf(() => validateFrameForGeneration({ frameDescription: "", concepts: [] }))).toBe(
      "empty_frame_description",
    );
  });

  it("rejects a whitespace-only frame description", () => {
    expect(codeOf(() => validateFrameForGeneration({ frameDescription: "  \n\t ", concepts: [] }))).toBe(
      "empty_frame_description",
    );
  });

  it("compileFramePrompt refuses invalid input rather than compiling it", () => {
    expect(codeOf(() => compileFramePrompt({ frameDescription: "", concepts: [] }))).toBe(
      "empty_frame_description",
    );
    expect(
      codeOf(() =>
        compileFramePrompt({ frameDescription: SCENE, concepts: characters(MAX_CHARACTER_CONCEPTS + 1) }),
      ),
    ).toBe("too_many_characters");
  });
});
