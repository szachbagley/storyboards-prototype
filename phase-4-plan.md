# Phase 4 Plan — Stories and Frames CRUD, Ordering, Concept Attachment

> Historical implementation record. References to `CLAUDE.md` and `.claude/skills/` describe the original layout. For current contribution instructions, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the skills linked from AGENTS.md.

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 4
**Depends on:** phases 1–3 — all complete
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

Phase 4 builds the authoring surface: stories, the frames inside them, their
order, and the concepts attached to each frame. Nine endpoints, no AI.

Two parts of it are load-bearing far beyond their size:

- **`frame_concepts.ord`.** The array index of `conceptIds` becomes `ord`, and
  `ord` becomes the reference-image enumeration order in the compiled prompt.
  Invariant 5 — the highest-severity failure mode in the system — originates
  here. Phase 5 can only preserve an order that phase 4 records correctly.
- **Position arithmetic.** One of `CLAUDE.md`'s three sanctioned test areas, and
  the thing that makes reordering cheap instead of a full-table rewrite.

**Phase 4 is done when all of the following are true:**

1. `GET/POST/PATCH/DELETE /api/stories` behave per §6; delete cascades to frames.
   `GET /api/stories` returns each story with a cover thumbnail URL, and
   `GET /api/stories/:id` returns one story.
2. `GET /api/stories/:id/frames` returns frames **in position order**, each with
   the selected generation's presigned URL (`null` until phase 6).
3. `POST /api/stories/:id/frames` **appends** using `max(position) + 1000`.
4. `GET /api/frames/:id` includes attached concepts **in `ord` order** and the
   frame's generation history.
5. `PATCH /api/frames/:id` updates any subset of
   `{ description, conceptIds, position }`; `conceptIds` replaces the attachment
   set wholesale with array index becoming `ord`.
6. `DELETE /api/frames/:id` returns `204`.
7. Position helpers are pure, live in `shared/`, and are **tested** for append,
   insert-between, and reorder.
8. Attaching an unknown concept id returns a typed `422`, not a foreign-key
   `500`; duplicate ids in `conceptIds` return `400`.
9. Nested routes under an unknown story return `404`, not an empty list.
10. Typecheck clean; all existing tests plus the new position tests pass.

**Not in phase 4:** the prompt compiler (phase 5), generation and the concept
caps that guard it (phase 6), and every client view (phase 7).

---

## 2. Decisions

### 2.1 Position arithmetic lives in `shared/`, not the server

`TECH_SPEC.md` §5.2 fixes the scheme: `DOUBLE PRECISION`, append at
`max + 1000`, insert at the midpoint. §6 has `PATCH /frames/:id` accept a raw
`position` value — so **the client computes the target position for a reorder**
and the server stores it.

That split creates a trap. If the helpers lived on the server, the server would
use only `appendPosition` and the phase 7 client would re-implement midpoint
logic by hand — two implementations of the ordering scheme, one of them
untested, which is exactly how ordering bugs get in.

**Decision:** the helpers go in **`shared/src/position.ts`** as pure functions,
tested once in `shared/test/position.test.ts`, and used by both sides — the
server for append, the phase 7 client for insert-between and reorder.

```ts
export function appendPosition(currentMax: number | null): number;
export function positionBetween(before: number | null, after: number | null): number;
```

`positionBetween` handles all four cases: both neighbours (midpoint), only an
`after` (insert at head → `after - POSITION_GAP`), only a `before` (append →
`before + POSITION_GAP`), and neither (empty list → `POSITION_GAP`).

**Known limit, measured rather than assumed:** repeated insertion at the same
spot exhausts double precision after **53 consecutive midpoints** starting from
a 1000-unit gap, or **43** from a 1-unit gap. No renormalization pass is built —
reaching it requires 43+ inserts between the same two frames without a single
intervening append. The limit is documented in the module and the tests assert
that a midpoint is *strictly* between its neighbours, so exhaustion would fail
loudly rather than silently collapsing two frames onto one position.

### 2.2 Concept caps are NOT enforced in this phase

`TECH_SPEC.md` §8.3 places the 4-character and 10-total caps on
`POST /frames/:id/generate`, and the compiler skill puts the same validation
"before compiling". Neither places it on attachment.

**Decision:** `PATCH /frames/:id` accepts any number of concepts. Caps are
validated at generation time and land in phase 5/6 alongside the compiler, which
is also where `CLAUDE.md`'s second sanctioned test area belongs.

This is deliberate and spec-faithful, recorded here because "the validation
phase forgot to validate" is the obvious misreading. §8.3's own remedy is a UI
affordance — "the frame editor should surface remaining character slots" — which
is phase 7, not an API rejection.

### 2.3 Wholesale attachment replacement

`conceptIds` replaces the set entirely (§6). In one transaction:

```sql
DELETE FROM frame_concepts WHERE frame_id = $1;

INSERT INTO frame_concepts (frame_id, concept_id, ord)
SELECT $1, c.id, c.ord
FROM unnest($2::uuid[], $3::int[]) AS c(id, ord);
```

- **The `DELETE` must precede the `INSERT` inside one transaction.** The unique
  index on `(frame_id, ord)` means any reordering that reuses an existing `ord`
  collides otherwise. Flagged in the phase 1 notes; this is where it lands.
- **`unnest` with explicit `::uuid[]` and `::int[]` casts** gives a fully
  parameterized multi-row insert with no dynamic SQL. Rehearsed against Postgres
  17 while planning: array order maps to `ord` exactly.
- An empty `conceptIds` array is valid and detaches everything.

### 2.4 Validating concept ids before the insert

An unknown concept id would raise a foreign-key violation (`23503`) and surface
as a `500`.

**Decision:** pre-validate with one `SELECT id FROM concepts WHERE id = ANY($1)`
and compare counts. If any are missing, return `422 unknown_concept` **naming
the offending ids**. This beats catching `23503` and sniffing constraint names:
better message, no dependence on Postgres error-code strings, and the check runs
inside the same transaction so it cannot race a concurrent delete.

Duplicate ids are rejected earlier, by the zod schema (§2.6) — they would
otherwise violate the `(frame_id, concept_id)` primary key and produce a
confusing `500`.

### 2.5 DTOs

`GET /stories/:id/frames` needs only what the grid renders; `GET /frames/:id`
needs everything the editor shows. Two different shapes, deliberately.

```ts
interface StoryDto {
  id, title,
  coverImageUrl: string | null,   // presigned URL, see 2.5.1
  createdAt, updatedAt,
}

// Story frame grid. No concepts -- the grid shows thumbnails only.
interface FrameSummaryDto {
  id, storyId, position, description,
  selectedGenerationId: string | null,
  imageUrl: string | null,        // presigned URL of the selected generation
  createdAt, updatedAt,
}

// Frame editor.
interface FrameDto extends FrameSummaryDto {
  concepts: ConceptDto[],              // in ord order -- invariant 5 starts here
  generations: GenerationSummaryDto[], // newest first (section 12.4 thumbnails)
}

interface GenerationSummaryDto {
  id, status, imageUrl: string | null,
  errorCode: string | null, errorMessage: string | null,
  createdAt, completedAt: string | null,
}
```

#### 2.5.1 The story cover thumbnail

Added at the user's direction (§7). `GET /stories` and `GET /stories/:id` both
carry `coverImageUrl`: the presigned URL of the **first frame's** selected
generation, where "first" means lowest `position`.

One query, no N+1, using a lateral join:

```sql
SELECT s.id, s.title, s.created_at AS "createdAt", s.updated_at AS "updatedAt",
       g.image_key AS "coverImageKey"
FROM stories s
LEFT JOIN LATERAL (
  SELECT f.selected_generation_id
  FROM frames f
  WHERE f.story_id = s.id
  ORDER BY f.position ASC
  LIMIT 1
) ff ON true
LEFT JOIN generations g ON g.id = ff.selected_generation_id
ORDER BY s.created_at DESC
```

`LEFT JOIN LATERAL ... ON true` is what allows a correlated `LIMIT 1` per story
row; a plain join cannot express "one row per story, chosen by that story's own
ordering". Rehearsed against Postgres 17 while planning.

**A known consequence, verified during that rehearsal:** a story whose first
frame has no selected generation yields `null` even when a *later* frame does.
Three fixtures behaved as follows:

| Story | Result |
|---|---|
| Cover on frame 1 | `generations/first.jpg` |
| Cover only on frame 2 | `null` |
| No frames at all | `null` |

This is the literal reading of "first frame as thumbnail" and is what is built.
If phase 7's story grid turns out to look sparse in practice, the fallback is a
one-line change — order the lateral subquery by
`(selected_generation_id IS NULL), position` so it prefers the first frame that
actually has an image. Recorded so that change is a decision rather than a
rediscovery.

Story list order is `created_at DESC`, matching the concepts list from phase 2.

**No frame label field.** §5.2 is explicit that "Frame 1"/"Frame 7" are derived
at render time from position order and are not stored. Adding a `label` or
`index` to the DTO would create a second source of truth that goes stale on
every reorder.

`generations` will be empty and `imageUrl` `null` until phase 6. Both are built
now because §6 specifies them on these endpoints; that is spec compliance, not
speculative scaffolding.

### 2.6 Validation schemas

Added to `shared/src/schemas.ts`:

```ts
export const CreateStorySchema = z.object({ title: z.string().trim().min(1).max(200) });
export const UpdateStorySchema = z.object({ title: z.string().trim().min(1).max(200) });

export const CreateFrameSchema = z.object({ description: z.string().max(5000).optional() });

export const UpdateFrameSchema = z
  .object({
    description: z.string().max(5000).optional(),
    conceptIds: z.array(z.uuid()).optional()
      .refine((ids) => !ids || new Set(ids).size === ids.length, {
        message: "conceptIds must not contain duplicates",
      }),
    position: z.number().finite().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });
```

- `PATCH /stories/:id` takes `{ title }` as **required**, not optional — it is
  the only field, so an empty body is always a mistake.
- `conceptIds` is **uncapped** here, per §2.2.
- `position` must be finite. Verified against Postgres 17 while planning:
  `'NaN'::double precision` is accepted without complaint **and sorts above
  every real value** (`'NaN' > 999999` is true). A `NaN` position would
  therefore pin a frame silently to the end of its story with no error and no
  way to reorder it back. `Infinity` behaves similarly. This is a cheap guard
  against a permanent, confusing data defect.
- Frame `description` may be empty. §6 allows creating a frame with no
  description; the non-empty requirement is a *generation-time* rule (compiler
  skill validation table) and belongs to phase 6.

### 2.7 Appending inside a transaction

`POST /stories/:id/frames` reads `max(position)`, computes with
`appendPosition`, and inserts — all in one transaction.

A single `INSERT ... SELECT COALESCE(max(position),0) + 1000` would be one
round-trip fewer, but it moves the arithmetic into SQL where the phase 7 client
cannot share it and where `CLAUDE.md`'s position-arithmetic tests cannot reach
it. Keeping the pure helper on both sides is worth one extra query.

Concurrent appends to the same story could still compute the same `max` and
produce two frames at one position. Single-user prototype; the ordering would be
arbitrary between those two frames but nothing breaks. Noted, not defended
against.

### 2.8 Layering and new plumbing

Per `CLAUDE.md` (`routes/ → services/ → db/`):

```
routes/stories.ts     stories CRUD (incl. GET /stories/:id) + nested frame list/create
routes/frames.ts      frame read/update/delete
services/stories.ts   orchestration
services/frames.ts    orchestration, attachment replacement, DTO assembly
db/stories.ts         SQL
db/frames.ts          SQL, including frame_concepts and the generations join
```

`db/pool.ts` gains a `withTransaction(fn)` helper — the first phase that needs
one. It acquires a client, `BEGIN`, runs the callback, `COMMIT`, and `ROLLBACK`s
on any throw, always releasing the client.

### 2.9 Not-found semantics

`GET /stories/:id/frames` and `POST /stories/:id/frames` must check the story
exists and return `404` when it does not. An empty array for a nonexistent story
is a silent lie that phase 7 would render as an empty grid.

### 2.10 Testing

**One new committed test file: `shared/test/position.test.ts`** — the second of
`CLAUDE.md`'s three sanctioned areas.

| Case | Assertion |
|---|---|
| Append to an empty story | `appendPosition(null) === POSITION_GAP` |
| Append after existing | `appendPosition(3000) === 4000` |
| Insert between neighbours | strictly between; equals the midpoint |
| Insert at head | `positionBetween(null, 1000) < 1000` |
| Insert at tail | `positionBetween(1000, null) > 1000` |
| Empty list | `positionBetween(null, null) === POSITION_GAP` |
| Reorder | moving a frame between two others yields a position that sorts it there |
| Repeated inserts | ordering is preserved over many consecutive midpoint inserts |
| Precision floor | a midpoint of two adjacent doubles is detectably degenerate |

Sorting assertions compare the **resulting order of a list**, not just the
numbers, because the order is what actually matters.

No tests for stories/frames CRUD handlers — `CLAUDE.md` excludes them
explicitly. Attachment ordering is verified end to end in §5.

---

## 3. Repository layout after phase 4

```
shared/src/
├── position.ts          NEW  appendPosition, positionBetween (pure)
├── schemas.ts           MOD  + story and frame schemas
├── types.ts             MOD  + StoryDto, FrameDto, FrameSummaryDto, GenerationSummaryDto
└── index.ts             MOD  + export * from "./position.js"
shared/test/
└── position.test.ts     NEW  sanctioned test area 2 of 3

server/src/
├── app.ts               MOD  mount both routers
├── db/
│   ├── pool.ts          MOD  + withTransaction
│   ├── stories.ts       NEW
│   └── frames.ts        NEW
├── routes/
│   ├── stories.ts       NEW
│   └── frames.ts        NEW
└── services/
    ├── stories.ts       NEW
    └── frames.ts        NEW
```

No new dependencies.

---

## 4. Step-by-step execution

### Step 1 — `shared/`: position helpers, schemas, DTOs

Write `position.ts`, the new schemas, and the DTOs. Export from `index.ts` and
rebuild.

### Step 2 — `shared/test/position.test.ts`

Write the §2.10 table. Run green, then **mutate** `positionBetween` to return
`before` instead of the midpoint and confirm the ordering assertions fail —
proving the tests have teeth before trusting them.

### Step 3 — `db/pool.ts`: `withTransaction`

### Step 4 — `db/stories.ts` and `db/frames.ts`

Frames SQL of note:

- List by story: `ORDER BY position ASC`, LEFT JOIN `generations` on
  `selected_generation_id` for `image_key`.
- Attached concepts: join `frame_concepts` `ORDER BY ord ASC`. **This ordering
  is invariant 5's origin — never omit the `ORDER BY`.**
- Generation history: `ORDER BY created_at DESC`.
- Attachment replacement: the §2.3 delete-then-`unnest`-insert pair.

### Step 5 — `services/stories.ts` and `services/frames.ts`

DTO assembly with presigned URLs (reusing `getPresignedUrl` from phase 2),
`404`s for missing rows, the §2.4 concept pre-validation, and `withTransaction`
around attachment replacement and appends.

### Step 6 — Routes and mounting

Two routers mounted after auth in `app.ts`, `:id` validated with the existing
`UuidParamSchema`.

---

## 5. Verification

### 5.1 Ordering — the core of the phase

- Create a story, append six frames, confirm `GET /stories/:id/frames` returns
  them in creation order with positions 1000, 2000 … 6000.
- `PATCH` frame 6's position to the midpoint of frames 1 and 2; re-list and
  confirm it now appears second and every other frame is untouched — the point
  of the float scheme is that a reorder rewrites exactly one row.
- Move a frame to the head (below the current minimum) and to the tail.
- Confirm no `position` value is ever `NaN`, and that `PATCH` with
  `position: NaN` or `Infinity` is rejected as `400`.
- Delete a middle frame; confirm the rest keep their order and positions.

### 5.2 Attachment order — invariant 5's origin

- Attach `[C, A, B]` to a frame. `GET /frames/:id` must return concepts in
  exactly that order with `ord` 0,1,2 — **not** alphabetical, not creation
  order, not primary-key order.
- Re-`PATCH` with `[B, C, A]` and confirm the order changes accordingly and the
  row count stays at three, proving delete-then-insert works within the unique
  index on `(frame_id, ord)`.
- `PATCH` with `[]` detaches everything.
- Verify directly in SQL that `ord` matches the array index.

### 5.3 Stories: single read and cover thumbnail

- `GET /stories/:id` returns the story; unknown id returns `404`.
- With no frames, `coverImageUrl` is `null`.
- With frames but no generations, `coverImageUrl` is `null`.
- Insert a succeeded generation for the first frame and confirm
  `coverImageUrl` becomes a working presigned URL that actually loads.
- Reorder so a different frame is first, and confirm the cover follows the new
  first frame rather than the original one.
- Confirm the list endpoint issues **one** query regardless of story count — no
  N+1 from resolving covers.

### 5.4 Failure paths

| Case | Expected |
|---|---|
| Unknown concept id in `conceptIds` | `422 unknown_concept`, offending id named |
| Duplicate ids in `conceptIds` | `400 invalid_input` |
| `PATCH /frames/:id` with `{}` | `400 invalid_input` |
| `POST /stories` with blank title | `400 invalid_input` |
| Frames under an unknown story | `404 not_found` |
| Malformed `:id` anywhere | `400 invalid_input` |
| Any route without a token | `401 unauthorized` |

### 5.5 Cascades

- `DELETE /stories/:id` removes its frames and their `frame_concepts` rows,
  leaving concepts untouched.
- `DELETE /frames/:id` removes its attachments.
- Deleting a **concept** that is attached to frames removes the attachment but
  leaves the frames intact (already proven in phase 1; re-confirm through the
  API now that attachments are reachable).

### 5.6 Regression

Phases 2 and 3 unaffected; typecheck clean; all tests pass; no `500` anywhere.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Attachment order lost → wrong description attached to wrong subject in phase 5 | Explicit `ORDER BY ord` in SQL, non-alphabetical fixture in §5.2 |
| `ord` collision on reorder | Delete-then-insert inside one transaction (§2.3) |
| Unknown concept id surfacing as a `500` | Pre-validation with a named `422` (§2.4) |
| Two implementations of position arithmetic drifting | Single pure module in `shared/`, used by both sides (§2.1) |
| `NaN` position pinning a frame to the end of its story permanently | `z.number().finite()`; Postgres accepts `NaN` and sorts it highest (§2.6) |
| Caps silently unenforced forever | Recorded as deliberate in §2.2 and carried in phase 5/6 scope |
| Float precision exhaustion | Measured at 43–53 inserts (§2.1); tests assert strict betweenness |

---

## 7. Resolved questions

Both raised before execution and answered by the user on 2026-08-19.

**1. `GET /stories/:id` — YES, add it.**
A single-story read absent from §6. It mirrors the existing
`GET /concepts/:id`, and phase 7's `/stories/:id` route needs the title for its
header without loading the entire story list. Returns `StoryDto`, `404` on an
unknown id.

**2. Story cover thumbnail — YES, first frame.**
`StoryDto.coverImageUrl` carries the presigned URL of the first frame's selected
generation. Design, query and the verified null-cases are in §2.5.1.

Both additions go beyond §6 as written. They are recorded here so that a later
reader can tell they were requested rather than assumed, and so the spec's own
table can be updated if it is ever revised.

---

## 8. Explicitly deferred

| Item | Phase |
|---|---|
| Prompt compiler and reference-image enumeration | 5 |
| Concept caps validation (4 characters / 10 total) and its tests | 5–6 |
| Non-empty frame description requirement | 6 (generation-time rule) |
| Generation rows, `selected_generation_id` being non-null, `POST /frames/:id/select-generation` | 6 |
| **Deleting S3 objects for a deleted frame's or story's generations** | 6 — no generation objects can exist yet, but this debt must be picked up there, mirroring the inline best-effort delete established for concepts in phase 2 |
| Frame grid, frame editor, concept picker, drag reorder | 7 |
| Position renormalization pass | Not planned; see the measured limit in §2.1 |

---

## 9. Execution notes

**Defect found and fixed — a phase 1 gap, not a phase 4 one**

`PATCH /frames/:id` with `position: NaN` returned **500**. The root cause was
broader than the field: `NaN` and `Infinity` are not JSON literals, so
`express.json()` throws a `SyntaxError` before any route runs. **Any malformed
JSON body on any endpoint had been returning 500 since phase 1** — phase 4 was
simply the first test to send a body that could not parse.

Fixed in `middleware/errorHandler.ts` by handling body-parser's `type` tag:
`entity.parse.failed` → `400 invalid_input`, `entity.too.large` → `413
payload_too_large`. Verified on `PATCH /frames/:id` and `POST /stories`, so the
fix is general.

The `z.number().finite()` guard was never at fault and does work for the case
that can arrive as JSON: `1e999` parses to `Infinity` and is rejected `400`.

**Verified**

- Append produced 1000…6000; a reorder to `position: 1500` changed **exactly one
  row** — the whole justification for `DOUBLE PRECISION` over a sequence
  integer, confirmed against the database rather than inferred.
- Head and tail moves, and deleting a middle frame, all preserve order.
- **Attachment order**: attaching `[Mike, Zulu, Alpha]` — deliberately differing
  from both alphabetical and creation order — returned exactly that order with
  `ord` 0,1,2 in the database. Re-attaching in a different order worked under
  the `(frame_id, ord)` unique index, and `[]` detaches.
- **Transaction integrity**: after a rejected attach naming an unknown concept,
  the frame's previous attachments were still intact — proving the `DELETE`
  rolled back. Without the transaction this would have silently wiped the set
  before validation failed.
- Cover thumbnail: `null` when only the second frame has a generation (the
  literal rule from §2.5.1), a working presigned URL when the first frame has
  one, and it **follows a reorder** — confirmed by comparing S3 object keys, not
  URL prefixes, which are identical for every object in the bucket.
- All eleven failure paths return their typed code; cascades behave per §5.5;
  phases 2 and 3 unaffected; 34/34 tests; typecheck clean; **zero 5xx responses
  and zero unhandled errors** across the phase.

**Deferred debt now demonstrated rather than theoretical**

After deleting the test story and all its frames, **two generation objects
remained in S3**. This is exactly the cleanup gap recorded in §8: frame and
story deletion cascades the database rows but leaves `generations/{id}.jpg`
orphaned. Cleaned up by hand here. Phase 6 must delete these inline, mirroring
the best-effort concept-object delete from phase 2.

**Mutation testing**

The position tests were checked against three mutations: returning `before`
instead of the midpoint (4 failures), flipping the head-insert sign (2
failures, including the reorder-order assertion), and making `appendPosition`
constant (2 failures). The sign-flip case is the one that justifies asserting on
resulting *order* rather than on numbers — it produces a plausible number and is
only caught by checking where the frame lands.
