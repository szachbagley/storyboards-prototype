---
name: storyboard-prompt-compiler
description: Rules and templates for writing concept descriptions and compiling storyboard frame prompts for Nano Banana image generation — the identity-only description rule, description-generation meta-prompts by concept type, the frame prompt structure, reference-image ordering, and validation caps. Use this skill whenever the task involves generating or editing a concept description, writing or reviewing the prompt compiler, building the prompt sent to Nano Banana, debugging inconsistent characters across frames, or changing anything about how frame descriptions and concept descriptions combine. Consult it before touching any prompt text or compiler logic — the constraints here fail silently rather than erroring, so violations look like poor model quality rather than bugs.
---

# Storyboard Prompt Compiler

How concept descriptions are written and how frame prompts are assembled. Every rule here fails **silently** — a violation produces plausible-looking but degraded images, never an error. That is why they are written down.

---

## The identity-only rule

**This is the foundational constraint of the system.**

A concept description captures only what makes the subject *recognizable across shots*. The frame description owns everything else.

### Include

Physical appearance. Costume and clothing. Materials, colours, textures. Wear, damage, weathering. Distinguishing marks, scars, insignia, logos. Build and proportions. Permanent accessories.

### Exclude

Pose. Action. Gesture. Facial expression. Environment or background. Weather. Time of day. Lighting. Camera angle. Shot size. Framing. Composition. Mood or atmosphere.

### Why

The frame description places the subject in a scene. If the concept description *also* places them in a scene, the model receives two competing scenes and resolves the conflict arbitrarily.

Consider a description that opens: *"A weathered astronaut standing alone on a windswept ridge of rust-colored regolith. His suit is a matte off-white shell scuffed with fine gray dust..."*

The second sentence onward is exactly right. The first sentence is poison. Compile it against a frame that says *"stands menacingly on a red planet as a sandstorm batters his suit; medium shot; left half of frame"* and you have handed the model a ridge and a sandstorm, a solitary figure and a menacing one, and no camera instruction it can trust.

Rewritten correctly:

> A weathered astronaut in a matte off-white suit, a hard shell scuffed with fine gray dust along the forearms and knees. Burnt-orange accent panels at the shoulders. A frayed mission patch stitched over the left chest. Corrugated fabric joints ring the elbows and hips. A bundle of braided cables loops from a chunky life-support pack behind the shoulders down to a control box on the belt.

No ridge, no standing, no light. Just the astronaut.

### By concept type

- **character** — the person or creature. Not what they are doing.
- **setting** — the place itself: architecture, materials, scale, contents, era, state of repair. Not a shot of the place, and no time of day or weather, which the frame controls.
- **prop** — the object: form, material, size, condition, markings. Not who holds it or where it sits.

---

## Description-generation meta-prompts

Sent to `gemini-3.7-flash` with the concept's reference image, `thinking_level: "low"`. Select by concept type.

### Shared preamble

```
You are writing a reference description for a storyboard concept library.
This description will be combined with separate scene descriptions to
generate storyboard frames, so it must describe ONLY the subject's fixed,
recognizable characteristics.

Do NOT describe: pose, action, gesture, expression, background,
environment, setting, weather, time of day, lighting, camera angle, shot
size, framing, composition, or mood. Those are supplied elsewhere and your
description must not conflict with them.

Write flowing prose, not a bulleted list. Do not begin with "This image
shows" or similar. Do not add commentary before or after. Output only the
description.
```

### character

```
Describe the character in this image so that an image generation model
could render the same individual in any scene.

Cover: build and proportions, face and hair, clothing and costume including
materials, colours, and construction, wear and damage, and any distinguishing
marks, insignia, or permanently carried equipment.

Begin with the subject as a noun phrase — "A weathered astronaut in a matte
off-white suit..." — not with an action.

Target 60 to 120 words.
```

### setting

```
Describe the location in this image so that an image generation model could
render the same place from any angle, at any time of day.

Cover: architecture and structure, materials and surfaces, scale, notable
contents or fixtures, era and style, and state of repair or decay.

Describe the place as it permanently is. Omit anything transient — weather,
light, the position of the sun, people or vehicles that happen to be present.

Target 60 to 120 words.
```

### prop

```
Describe the object in this image so that an image generation model could
render the same object in any context.

Cover: form and silhouette, materials and finish, colours, approximate scale
relative to a human hand or body, markings or text, and condition or wear.

Describe the object alone. Omit whatever is holding it, whatever it rests on,
and the surroundings.

Target 40 to 90 words.
```

---

## Frame prompt structure

```
<FORMAT_PREAMBLE>

Reference image 1 — Spaceman (character): <identity-only description>
Reference image 2 — Castle (setting): <identity-only description>
Gobby (prop): <identity-only description>

Scene: <frame.description, verbatim>

<OUTPUT_CONSTRAINTS>
```

Followed by image parts in the same order the "Reference image N" lines appear.

### Constants

```
FORMAT_PREAMBLE:
Generate a single storyboard frame for a film production.

The reference images below establish how specific subjects must look.
Reproduce each referenced subject faithfully — the same face, the same
costume, the same materials — while placing them in the scene described.
```

```
OUTPUT_CONSTRAINTS:
Render exactly one image. Compose it as a single continuous frame with no
panel divisions, borders, captions, or text overlays.
```

The preamble carries no visual style. Style is the user's responsibility, expressed inline in the frame description — that is a deliberate v1 scope decision, not an omission to fix.

---

## Compiler rules

**1. The frame description is inserted verbatim, and last.**
Never paraphrase, expand, reorder, summarize, or "improve" it. It is the user's authored intent. If it is vague, that is the user's problem to solve, not the compiler's.

**2. Enumeration order must match image part order exactly.**
The concept labelled "Reference image 2" must be the second image part. Ordering comes from `frame_concepts.ord`, which comes from the client's array order.

This is the highest-severity failure mode in the system. When labels and images desynchronize, the model attaches the wrong description to the wrong subject — a character wearing the wrong costume, a prop rendered with a building's materials. It presents as the model being unreliable, and nothing about the symptom points at ordering.

**3. Concepts without a reference image are listed by name only.**
Format as `Gobby (prop): <description>` with no "Reference image N" prefix, and do **not** advance the reference index. Only concepts with an actual image part consume a number.

**4. Include the type parenthetical.**
`(character)`, `(setting)`, `(prop)`. It costs a word and it tells the model whether a subject is a figure to place, a space to build, or an object to position.

**5. The compiler is a pure function.**
Inputs to `{ prompt, parts }`. No database, no S3, no network, no clock, no randomness. It must be testable without infrastructure — this is the component most worth testing and the one most likely to break invisibly.

**6. Persist the compiled prompt before the API call.**
Write `compiled_prompt` and `input_snapshot` to the `generations` row first. A failed call whose prompt was never recorded is undiagnosable.

---

## Validation

Run before compiling. Reject with `422` and a specific message.

| Rule | Limit | Reason |
|---|---|---|
| Character concepts per frame | 4 | `gemini-3.1-flash-image` guarantees resemblance for at most 4 |
| Total concepts per frame | 10 | High-fidelity object cap |
| Frame description | Non-empty | Concepts alone do not describe a shot |

Exceeding the character cap does not error upstream — faces blend and drift instead. Catch it locally.

---

## Debugging inconsistency

When a character drifts across frames, check in this order:

1. **Is the reference image actually attached?** A concept with a null `image_key` contributes text only, and text alone will not hold identity. This is the most common cause by a wide margin.
2. **Do the labels match the part order?** Compare `compiled_prompt` against the part array for the failing generation.
3. **Does the description contain scene content?** Grep stored descriptions for `standing`, `sitting`, `walking`, `background`, `lighting`, `shot`, `angle`, `sunset`, `dramatic`. Any hit is a rule violation.
4. **Are there more than four characters?** Validation should prevent this, but confirm.
5. **Is the reference image itself poor?** A cluttered background, extreme angle, or heavy shadow gives the model an ambiguous target. The fix is a better reference, or a canonicalization pass that generates one clean neutral-background plate to use as the anchor.
6. **Is the frame description fighting the reference?** "Wearing a red coat" against a reference in blue forces the model to choose. Frame descriptions should direct action and staging, not restate or contradict appearance.

---

## Worked example

**Concept — Spaceman (character), with reference image:**
> A weathered astronaut in a matte off-white suit, a hard shell scuffed with fine gray dust along the forearms and knees. Burnt-orange accent panels at the shoulders. A frayed mission patch stitched over the left chest. Corrugated fabric joints ring the elbows and hips. A bundle of braided cables loops from a chunky life-support pack behind the shoulders down to a control box on the belt.

**Frame description:**
> Spaceman stands menacingly on a red planet as a sandstorm batters his suit; light is warm and low, the sky is burnt orange; medium shot; Spaceman stands on the left half of the frame; the horizon is at the middle of the frame

**Compiled:**
```
Generate a single storyboard frame for a film production.

The reference images below establish how specific subjects must look.
Reproduce each referenced subject faithfully — the same face, the same
costume, the same materials — while placing them in the scene described.

Reference image 1 — Spaceman (character): A weathered astronaut in a matte
off-white suit, a hard shell scuffed with fine gray dust along the forearms
and knees. Burnt-orange accent panels at the shoulders. A frayed mission
patch stitched over the left chest. Corrugated fabric joints ring the elbows
and hips. A bundle of braided cables loops from a chunky life-support pack
behind the shoulders down to a control box on the belt.

Scene: Spaceman stands menacingly on a red planet as a sandstorm batters his
suit; light is warm and low, the sky is burnt orange; medium shot; Spaceman
stands on the left half of the frame; the horizon is at the middle of the
frame

Render exactly one image. Compose it as a single continuous frame with no
panel divisions, borders, captions, or text overlays.
```

Parts: `[{ type: "text", text: <above> }, { type: "image", mime_type: "image/jpeg", data: <spaceman reference> }]`

Note the clean division: the concept supplies the suit, the frame supplies the planet, the sandstorm, the light, the shot size, and the staging. Neither contradicts the other. That separation is the whole point.
