# Phase 5 Plan — The Prompt Compiler

> Historical implementation record. References to `CLAUDE.md` and `.claude/skills/` describe the original layout. For current contribution instructions, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the skills linked from AGENTS.md.

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 5
**Depends on:** phases 1–4 — all complete
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

`CLAUDE.md` calls the compiler "the interesting surface of the project and the
one component worth real tests." `TECH_SPEC.md` §13 puts it deliberately
*before* the generation pipeline, because it is cheap to test in isolation and
expensive to debug through a live API.

Phase 5 therefore ships **one pure module and its tests. No routes, no database
changes, no network.** Nothing calls the compiler until phase 6.

Everything it produces fails silently when wrong. A desynchronized enumeration
does not error — it hands the model the wrong description for a subject, and the
symptom is "the model is unreliable."

**Phase 5 is done when all of the following are true:**

1. `server/src/services/promptCompiler.ts` exports a **pure** function: inputs
   in, `{ prompt, parts }` out. No database, no S3, no network, no clock, no
   randomness.
2. `FORMAT_PREAMBLE` and `OUTPUT_CONSTRAINTS` are transcribed **verbatim** from
   the `storyboard-prompt-compiler` skill, with a fidelity test proving byte
   equality — the phase 3 precedent.
3. The compiled prompt matches the skill's structure exactly: preamble, concept
   lines, `Scene:` line, constraints.
4. **Enumeration order matches image part order**, proven by a test that maps
   each `Reference image N` line back to the Nth image part.
5. Concepts with no reference image are listed by name only and **do not consume
   a reference index**.
6. The frame description is inserted **verbatim** — not trimmed, reordered,
   paraphrased, or otherwise touched.
7. The type parenthetical `(character)` / `(setting)` / `(prop)` is present on
   every concept line.
8. Validation rejects >4 character concepts, >10 total concepts, and an empty
   frame description with `422` and a specific message.
9. The skill's **worked example** is reproduced.
10. Typecheck clean; all existing tests plus the new compiler tests pass.

---

## 2. Decisions

### 2.1 Purity, and what that forces on the caller

`CLAUDE.md`: "must be a pure function. Inputs in, `{ prompt: string, parts:
InputPart[] }` out. No database access, no S3 calls, no network, no clock."

The consequence is that **the compiler cannot fetch reference images.** The
caller — phase 6's generation service — reads each concept's bytes from S3 and
passes base64 in. That is the right split: fetching is I/O and belongs to the
pipeline; assembling is logic and belongs here.

```ts
export interface CompilerConcept {
  id: string;
  name: string;
  type: ConceptType;
  description: string;
  /** null when the concept has no reference image. */
  imageBase64: string | null;
  imageMimeType: string | null;
}

export interface CompilerInput {
  frameDescription: string;
  /** Already in frame_concepts.ord order. The compiler preserves it and does
   *  not sort. */
  concepts: CompilerConcept[];
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data: string };

export interface CompiledPrompt {
  prompt: string;
  parts: InputPart[];
}
```

The compiler **never sorts** its input. Ordering is established by
`frame_concepts.ord` in phase 4 and preserved end to end; re-sorting here would
silently override the user's chosen order.

### 2.2 Constants come from the skill mechanically

Same technique as the phase 3 meta-prompts, for the same reason: hand-typing
risks dropping a clause, and the text contains an em-dash.

Verified while planning — the skill's `### Constants` section holds exactly two
fenced blocks, each with a label line (`FORMAT_PREAMBLE:` / `OUTPUT_CONSTRAINTS:`)
followed by the body:

```
FORMAT_PREAMBLE   5 body lines, contains an em-dash
OUTPUT_CONSTRAINTS 2 body lines, ASCII only
```

Extraction strips the label line. A fidelity test re-parses `SKILL.md` at test
time and asserts byte equality, including the guard against vacuous passing that
phase 3 established.

The preamble deliberately carries **no visual style**. §8.4 and the skill both
state this is a v1 scope decision, not an omission: the user supplies style
inline in the frame description. Do not add a style clause.

### 2.3 The enumeration algorithm

This is the part where a bug is invisible. Verified formatting from the skill:

```
Reference image 1 — Spaceman (character): <description>
Reference image 2 — Castle (setting): <description>
Gobby (prop): <description>
```

The separator is an **em-dash** `—` (U+2014) surrounded by single spaces.

```ts
let referenceIndex = 0;
for (const concept of input.concepts) {
  const label = `${concept.name} (${concept.type})`;
  const body  = concept.description.trim() ? `${label}: ${concept.description}` : label;

  if (concept.imageBase64) {
    referenceIndex += 1;
    lines.push(`Reference image ${referenceIndex} — ${body}`);
    imageParts.push({
      type: "image",
      mime_type: concept.imageMimeType ?? IMAGE_MIME_TYPE,
      data: concept.imageBase64,
    });
  } else {
    lines.push(body);
  }
}
```

Two properties hold by construction, and both are tested rather than assumed:

- **The index advances only when an image part is pushed.** They increment in
  the same branch, so `Reference image N` and `imageParts[N-1]` cannot diverge.
  A concept without an image consumes no number.
- **Image parts are appended in the order the lines are emitted**, so the Nth
  labelled line and the Nth image part refer to the same concept.

### 2.4 Empty concept descriptions

A real and common case, not an edge case: concepts are created with
`description: ''` (phase 2), and a user may attach one before writing or
generating a description.

**Decision:** emit the label without a trailing colon —
`Reference image 1 — Spaceman (character)` — rather than
`Reference image 1 — Spaceman (character): ` with a dangling colon and space.
The concept is still included and still contributes its reference image, which
is what actually carries identity; the skill is explicit that text supplements
images rather than replacing them.

### 2.5 The frame description is inserted verbatim — including whitespace

Rule 1 of the skill and invariant 6 of `CLAUDE.md`: never paraphrase, expand,
reorder, summarize, or "improve" it.

**Decision: no trimming either.** Validation checks
`frameDescription.trim().length > 0` for emptiness, but the string inserted is
the original, untrimmed. Trimming is a small modification, and the rule is
absolute; a compiler that trims today is a compiler someone extends to
"normalize" tomorrow. A test asserts byte-identical passthrough of a description
containing newlines, double spaces, unicode, and markdown-like punctuation.

Concept descriptions are likewise inserted as stored — `.trim()` is used only to
*test* for emptiness in §2.4, never to alter what is emitted.

### 2.6 Section assembly

```ts
const sections: string[] = [FORMAT_PREAMBLE];
if (lines.length > 0) sections.push(lines.join("\n"));
sections.push(`Scene: ${input.frameDescription}`);
sections.push(OUTPUT_CONSTRAINTS);
const prompt = sections.join("\n\n");
```

Concept lines are joined by single newlines; sections by blank lines. When a
frame has no concepts at all the block is omitted entirely rather than leaving a
double blank line — a frame with no attached concepts is legal (it is just a
text-to-image prompt) and should not produce ragged whitespace.

`parts` is `[{ type: "text", text: prompt }, ...imageParts]` — text first, per
the skill and the Gemini part-ordering rule.

### 2.7 Validation lives with the compiler and runs first

The skill: "Validation — run before compiling. Reject with `422`."

| Rule | Limit | Code |
|---|---|---|
| Character concepts per frame | 4 | `too_many_characters` |
| Total concepts per frame | 10 | `too_many_concepts` |
| Frame description | non-empty | `empty_frame_description` |

Limits come from `MAX_CHARACTER_CONCEPTS` and `MAX_TOTAL_CONCEPTS` in
`shared/config.ts`; no literals at the call site.

`compileFramePrompt` calls `validateFrameForGeneration` first, so it is
impossible to compile an invalid frame by taking a different code path. The
validator is also exported separately so phase 6 can surface the same errors
before doing any S3 work, and so it can be tested in isolation.

Throwing `AppError` from a pure function is still pure — no I/O, no clock. Each
message names the actual numbers ("5 character concepts attached, at most 4 are
supported") because §8.3 asks for a clear message and a bare limit is not one.

This is the **second** of `CLAUDE.md`'s three sanctioned test areas, deferred
here from phase 4 as planned.

### 2.8 What phase 5 deliberately does not do

- **No route, no service wiring, no database access.** §13 sequences the
  compiler before the pipeline on purpose. Wiring it now would mean debugging
  compilation through a live, billed API — exactly what the ordering avoids.
- **No `previous_interaction_id`.** `CLAUDE.md` forbids it in v1.
- **No style handling.** §2.2.
- **No scene-word linting of concept descriptions.** Declined in phase 3 and
  still out of scope.

---

## 3. Repository layout after phase 5

```
server/src/services/
└── promptCompiler.ts        NEW  constants, validation, compile -- pure

server/test/
└── promptCompiler.test.ts   NEW  sanctioned areas 2 (caps) and 3 (compiler)
```

No new dependencies. No changes to `shared/`, routes, services wiring, or the
database.

---

## 4. Step-by-step execution

### Step 1 — Generate `promptCompiler.ts`

Extract the two constants mechanically from `SKILL.md` (§2.2), then write the
types (§2.1), the validator (§2.7), and the compile function (§2.3, §2.6).

### Step 2 — Write `promptCompiler.test.ts`

Per §5. Run green.

### Step 3 — Mutation-check the tests

Before trusting them, confirm each of these breaks the suite:

| Mutation | Must fail |
|---|---|
| Advance `referenceIndex` for imageless concepts too | enumeration/index tests |
| Push image parts in reverse order | the invariant 5 mapping test |
| `input.concepts.slice().sort(byName)` before the loop | order preservation test |
| `frameDescription.trim()` in the Scene line | verbatim passthrough test |
| Drop the type parenthetical | parenthetical test + worked example |
| Change one character of a constant | fidelity test |
| Cap comparison `>` instead of `>=` (off-by-one) | caps boundary tests |

A test suite for this component is worth nothing unless it can distinguish these
from correct behaviour — they are precisely the mistakes a plausible refactor
would introduce.

---

## 5. Verification — the test plan

### 5.1 Constant fidelity

Byte equality of `FORMAT_PREAMBLE` and `OUTPUT_CONSTRAINTS` against the skill's
fenced blocks, re-parsed at test time, plus a "did we actually parse the skill"
guard so a moved file cannot make the assertions vacuously compare `""` to `""`.

### 5.2 Invariant 5 — enumeration order matches part order

The single most important test in the project.

Each concept in the fixture gets a **unique sentinel base64 string**, so an image
part can be traced back to the concept it came from. The test then parses the
compiled prompt for every `Reference image N — <Name>` line and asserts that
`parts[N]` (parts[0] being the text part) carries that concept's sentinel.

Run it over several arrangements, including ones where imageless concepts appear
first, last, and interleaved:

```
[A(img), B(img), C(img)]                -> 1:A 2:B 3:C
[A(no), B(img), C(img)]                 -> B is 1, C is 2, A unnumbered
[A(img), B(no), C(img)]                 -> A is 1, C is 2, B unnumbered
[A(no), B(no)]                          -> no numbered lines, no image parts
```

This is an executable statement of the invariant rather than a spot check.

### 5.3 Structure and formatting

- Order of sections: preamble, concept lines, `Scene:`, constraints.
- Em-dash separator `—`, not a hyphen.
- Type parenthetical present for all three types.
- Imageless concepts carry no `Reference image N` prefix.
- Empty concept description yields no dangling colon (§2.4).
- A frame with no concepts omits the block and leaves no double blank line.
- `parts[0]` is the text part and equals `prompt`.

### 5.4 Verbatim passthrough

A frame description containing leading/trailing whitespace, internal newlines,
double spaces, semicolons, em-dashes and non-ASCII text must appear in the
compiled prompt **byte-identical**. Assert with `toContain` on the exact
original string, not a normalized form.

### 5.5 The worked example

The skill supplies a complete worked example — one character concept with a
reference image, a frame description, and the expected compiled output.

**Rehearsed while planning:** the expected block is byte-different from what the
compiler produces, because the skill wraps it for markdown readability, but
after collapsing whitespace runs the two are **identical**, and both are exactly
**1068 characters**. The only difference is newlines substituted for spaces —
so the normalization is a minimal, well-understood transformation, not a lossy
workaround.

The test therefore asserts normalized equality and additionally asserts equal
character counts, which together prove nothing was added, dropped, or reordered.

### 5.6 Validation caps

| Case | Expected |
|---|---|
| 4 character concepts | passes |
| 5 character concepts | `422 too_many_characters`, message names 5 and 4 |
| 10 total concepts | passes |
| 11 total concepts | `422 too_many_concepts` |
| Empty frame description | `422 empty_frame_description` |
| Whitespace-only frame description | `422 empty_frame_description` |
| 4 characters + 6 props (10 total) | passes — the two caps are independent |
| `compileFramePrompt` on invalid input | throws before producing a prompt |

Boundary cases are tested at both the limit and one past it, because an
off-by-one here silently degrades output rather than erroring.

### 5.7 Purity

Confirmed by construction and by the test file itself: the tests import the
module and run with no database, no network, and no environment — if the module
acquired an import-time dependency on `env` or the pool, the suite would fail to
load. That is a real guard, not a formality: `services/gemini.ts` and
`services/s3.ts` both read `env` at module scope.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Enumeration desync — wrong description attached to wrong subject | Index and part pushed in the same branch (§2.3); sentinel-traced mapping test (§5.2); mutation check |
| Constants drifting from the skill | Mechanical extraction + byte-equality test (§5.1) |
| A future refactor sorting or de-duplicating concepts | Order-preservation test; mutation check adds a sort and expects failure |
| "Helpful" trimming of the frame description | Verbatim test with whitespace-laden input (§5.4) |
| Off-by-one in the caps | Both-sides-of-the-boundary tests (§5.6) |
| Compiler acquiring an I/O dependency later | Tests run with no environment; such an import breaks the suite (§5.7) |

---

## 7. Explicitly deferred

| Item | Phase |
|---|---|
| Wiring the compiler into `POST /frames/:id/generate` | 6 |
| Reading concept image bytes from S3 into base64 | 6 |
| Writing `compiled_prompt` and `input_snapshot` before the API call | 6 |
| Surfacing remaining character slots in the editor | 7 |
| Style handling, `previous_interaction_id`, concept canonicalization | Not in v1 |

---

## 8. Execution notes

**Delivered exactly as scoped:** one pure module and its tests. No routes, no
services wiring, no database or `shared/` changes. `promptCompiler.ts` is
imported by nothing but its own test file — phase 6 wires it.

**Verified**

- Constants extracted mechanically (272 and 127 chars) and byte-identical to the
  skill; fidelity test carries the anti-vacuous guard.
- The skill's **worked example** is reproduced. As rehearsed during planning, the
  compiled output differs from the skill's block only by markdown line wrapping:
  collapsing whitespace makes them identical, and both are exactly 1068
  characters, so nothing was added, dropped or reordered.
- **Purity confirmed empirically**, not just asserted: the compiled module's only
  imports are `@storyboards/shared` and `../lib/AppError.js`, and it loads with
  no environment, database or network. Since `services/gemini.ts` and
  `services/s3.ts` both read `env` at module scope, an accidental import of
  either would break the test suite at load time.
- Deterministic across 100 calls, and it does not mutate its input.

**Mutation results (§4 Step 3)**

| Mutation | Tests failed |
|---|---|
| Advance the reference index for imageless concepts | 2 |
| Reverse image part order | 4 |
| Sort concepts by name | **1** |
| Trim the frame description | 2 |
| Drop the type parenthetical | 12 |
| Change one character of `FORMAT_PREAMBLE` | 2 |
| Off-by-one in the character cap | 2 |
| Hyphen instead of em-dash | 6 |

**The sort mutation is the finding worth keeping.** It failed only the
order-preservation test and slipped past all five invariant 5 mapping tests —
correctly so. Sorting reorders the lines *and* the image parts together, so the
label-to-part correspondence stays internally consistent; what it destroys is
the user's chosen `ord`. The mapping tests prove internal consistency; only a
test pinning specific names to specific indices catches a reordering that is
internally consistent but wrong. Relying on the invariant 5 tests alone would
have let a plausible "sort these for tidiness" refactor ship silently. Keep both.

**Deviation from the plan**

The em-dash is written into the generated source as the escape `—` rather
than a literal. The generator emits TypeScript through a Python f-string, where
a literal `—` is one encoding hop from mojibake; the escape is unambiguous.
Runtime output is a real em-dash, asserted by a test that also rejects a hyphen.
