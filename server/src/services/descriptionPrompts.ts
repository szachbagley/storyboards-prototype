import type { ConceptType } from "@storyboards/shared";

// Meta-prompts for AI-generated concept descriptions (TECH_SPEC.md section 8.1).
//
// SOURCE OF TRUTH: .agents/skills/storyboard-prompt-compiler/SKILL.md
// These strings are transcribed verbatim from that skill and must stay
// byte-identical to it; server/test/descriptionPrompts.test.ts enforces that.
// The skill is documentation and is not deployed, so the text is duplicated
// here rather than read at runtime.
//
// This is the FIRST of the three places the identity-only rule is enforced
// (section 8.2). The other two are the concept textarea placeholder and the
// prompt compiler. Weakening the exclusion clause below does not error: it
// quietly produces descriptions carrying pose, lighting and environment, which
// then fight every frame description they are compiled against.

export const SHARED_PREAMBLE = "You are writing a reference description for a storyboard concept library.\nThis description will be combined with separate scene descriptions to\ngenerate storyboard frames, so it must describe ONLY the subject's fixed,\nrecognizable characteristics.\n\nDo NOT describe: pose, action, gesture, expression, background,\nenvironment, setting, weather, time of day, lighting, camera angle, shot\nsize, framing, composition, or mood. Those are supplied elsewhere and your\ndescription must not conflict with them.\n\nWrite flowing prose, not a bulleted list. Do not begin with \"This image\nshows\" or similar. Do not add commentary before or after. Output only the\ndescription.";

export const META_PROMPT_BY_TYPE: Record<ConceptType, string> = {
  character: "Describe the character in this image so that an image generation model\ncould render the same individual in any scene.\n\nCover: build and proportions, face and hair, clothing and costume including\nmaterials, colours, and construction, wear and damage, and any distinguishing\nmarks, insignia, or permanently carried equipment.\n\nBegin with the subject as a noun phrase — \"A weathered astronaut in a matte\noff-white suit...\" — not with an action.\n\nTarget 60 to 120 words.",

  setting: "Describe the location in this image so that an image generation model could\nrender the same place from any angle, at any time of day.\n\nCover: architecture and structure, materials and surfaces, scale, notable\ncontents or fixtures, era and style, and state of repair or decay.\n\nDescribe the place as it permanently is. Omit anything transient — weather,\nlight, the position of the sun, people or vehicles that happen to be present.\n\nTarget 60 to 120 words.",

  prop: "Describe the object in this image so that an image generation model could\nrender the same object in any context.\n\nCover: form and silhouette, materials and finish, colours, approximate scale\nrelative to a human hand or body, markings or text, and condition or wear.\n\nDescribe the object alone. Omit whatever is holding it, whatever it rests on,\nand the surroundings.\n\nTarget 40 to 90 words.",
};

/**
 * The full meta-prompt sent to the description model for a given concept type.
 *
 * The concept's name is deliberately NOT interpolated: the model must describe
 * what it sees in the reference image, not elaborate on a name.
 */
export function buildDescriptionPrompt(type: ConceptType): string {
  return `${SHARED_PREAMBLE}\n\n${META_PROMPT_BY_TYPE[type]}`;
}
