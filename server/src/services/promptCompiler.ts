import {
  IMAGE_MIME_TYPE,
  MAX_CHARACTER_CONCEPTS,
  MAX_TOTAL_CONCEPTS,
  type ConceptType,
} from "@storyboards/shared";
import { AppError } from "../lib/AppError.js";

// The prompt compiler (TECH_SPEC.md section 8.4).
//
// SOURCE OF TRUTH for the two constants below:
// .agents/skills/storyboard-prompt-compiler/SKILL.md
// They are transcribed verbatim and must stay byte-identical to that skill;
// server/test/promptCompiler.test.ts enforces it. The skill is documentation
// and is not deployed, so the text is duplicated here rather than read at
// runtime.
//
// This module is PURE: no database, no S3, no network, no clock, no randomness.
// Reference image bytes are supplied by the caller precisely so that stays
// true. Every rule enforced here fails silently when broken -- a violation
// produces plausible-looking but degraded images, never an error.

/** Carries no visual style. That is a deliberate v1 scope decision, not an
 *  omission: the user expresses style inline in the frame description. */
export const FORMAT_PREAMBLE = "Generate a single storyboard frame for a film production.\n\nThe reference images below establish how specific subjects must look.\nReproduce each referenced subject faithfully — the same face, the same\ncostume, the same materials — while placing them in the scene described.";

export const OUTPUT_CONSTRAINTS = "Render exactly one image. Compose it as a single continuous frame with no\npanel divisions, borders, captions, or text overlays.";

export interface CompilerConcept {
  id: string;
  name: string;
  type: ConceptType;
  description: string;
  /** null when the concept has no reference image. Such a concept is included
   *  by description only and consumes no reference index. */
  imageBase64: string | null;
  imageMimeType: string | null;
}

export interface CompilerInput {
  frameDescription: string;
  /** Already in frame_concepts.ord order. The compiler preserves this order and
   *  never sorts: ord is the user's chosen order and it becomes the
   *  reference-image enumeration order. */
  concepts: CompilerConcept[];
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data: string };

export interface CompiledPrompt {
  prompt: string;
  parts: InputPart[];
}

/**
 * Validate a frame before compiling (TECH_SPEC.md section 8.3).
 *
 * Exceeding the caps does not error upstream -- faces blend and drift instead --
 * so they must be caught locally. Messages name the actual numbers because a
 * bare limit is not "a clear message".
 */
export function validateFrameForGeneration(input: CompilerInput): void {
  if (input.frameDescription.trim().length === 0) {
    throw new AppError(
      422,
      "empty_frame_description",
      "This frame has no description. Concepts alone do not describe a shot.",
    );
  }

  const characterCount = input.concepts.filter((c) => c.type === "character").length;
  if (characterCount > MAX_CHARACTER_CONCEPTS) {
    throw new AppError(
      422,
      "too_many_characters",
      `${characterCount} character concepts are attached, but at most ${MAX_CHARACTER_CONCEPTS} are supported. Remove ${characterCount - MAX_CHARACTER_CONCEPTS}.`,
    );
  }

  if (input.concepts.length > MAX_TOTAL_CONCEPTS) {
    throw new AppError(
      422,
      "too_many_concepts",
      `${input.concepts.length} concepts are attached, but at most ${MAX_TOTAL_CONCEPTS} are supported. Remove ${input.concepts.length - MAX_TOTAL_CONCEPTS}.`,
    );
  }
}

/**
 * Compile a frame into the prompt text and ordered input parts.
 *
 * Validation runs first so there is no code path that compiles an invalid
 * frame.
 */
export function compileFramePrompt(input: CompilerInput): CompiledPrompt {
  validateFrameForGeneration(input);

  const lines: string[] = [];
  const imageParts: InputPart[] = [];
  let referenceIndex = 0;

  for (const concept of input.concepts) {
    const label = `${concept.name} (${concept.type})`;
    // A concept may legitimately have no description yet -- concepts are created
    // with an empty one. Emit the bare label rather than a dangling colon; the
    // reference image is what carries identity in that case.
    const body = concept.description.trim().length > 0 ? `${label}: ${concept.description}` : label;

    if (concept.imageBase64 !== null) {
      // The index advances and the image part is pushed in the same branch, so
      // "Reference image N" and imageParts[N - 1] cannot desynchronize. That
      // desync is the highest-severity failure mode in the system: it makes the
      // model attach the wrong description to the wrong subject, which presents
      // as random inconsistency and points at nothing.
      referenceIndex += 1;
      lines.push(`Reference image ${referenceIndex} \u2014 ${body}`);
      imageParts.push({
        type: "image",
        mime_type: concept.imageMimeType ?? IMAGE_MIME_TYPE,
        data: concept.imageBase64,
      });
    } else {
      lines.push(body);
    }
  }

  const sections: string[] = [FORMAT_PREAMBLE];
  // A frame with no attached concepts is legal -- it is simply a text-to-image
  // prompt -- and must not leave a ragged double blank line.
  if (lines.length > 0) sections.push(lines.join("\n"));
  // Verbatim and untrimmed. This is the user's authored intent (invariant 6).
  sections.push(`Scene: ${input.frameDescription}`);
  sections.push(OUTPUT_CONSTRAINTS);

  const prompt = sections.join("\n\n");

  return { prompt, parts: [{ type: "text", text: prompt }, ...imageParts] };
}
