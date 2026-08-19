# Phase 7 Plan — Client Views in Route Order

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 7 — the final item
**Depends on:** phases 1–6 — all complete
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

Six routes, two tabs, and the generate-until-good loop the whole project exists
to support. The API is finished; this phase puts a face on it.

Two parts carry weight beyond their size:

- **The concept description placeholder** is the *second* of the three places
  the identity-only rule is enforced (§8.2). The other two shipped in phases 3
  and 5. If the placeholder does not state the rule, users write scene content
  into descriptions and every frame made from that concept degrades silently.
- **Generation history (§12.4)** is the guard on the app's core loop. The spec
  names a worse result overwriting a better one as "the most likely source of
  user frustration."

**Phase 7 is done when all of the following are true:**

1. All six routes from §12.1 render, with two persistent tabs — Concepts and
   Stories — on every authenticated view.
2. `/login` stores the secret in `localStorage`; every request carries
   `Authorization: Bearer <secret>`; a `401` clears storage and returns to
   `/login` (§10).
3. `/concepts` shows a grid with a **leading** "+" tile; `/stories` likewise.
4. `/concepts/:id` has the reference image, upload control, description textarea
   **whose placeholder states the identity-only rule**, and "Generate
   Description".
5. "Generate Description" writes straight into an empty field, but **confirms
   before replacing** existing content, and only commits on confirmation (§12.2).
6. `/stories/:id` shows frames in position order with a **trailing** "+" tile,
   labelled "Frame 1…N" **derived at render time** from order.
7. `/stories/:id/frames/:frameId` renders the four generation states — idle,
   generating with an elapsed timer, succeeded, failed — per §12.3.
8. The failed state shows the §8.6 message with a retry action, and for
   `safety_blocked` keeps the description editable in place.
9. Generation history renders as thumbnails; selecting one calls
   `select-generation`; regenerating appends rather than replaces (§12.4).
10. The concept picker preserves attachment order and **surfaces remaining
    character slots** (§8.3).
11. Concepts, stories and frames can each be **deleted** from their view, behind
    an inline confirmation.
12. Frames can be **reordered** in the story grid with move-left / move-right
    controls, and the derived "Frame N" labels follow immediately.
13. `npm run build` succeeds; typecheck clean; the 67 server/shared tests still
    pass.

---

## 2. Decisions

### 2.1 Routing: `react-router-dom`

`CLAUDE.md` forbids "an ORM, a state management library, or a component
library." A router is none of those, and it is the one piece of infrastructure
this client genuinely needs: six routes, two of them parameterised, one nested
two levels deep.

**Decision: `react-router-dom` 7.x.** Hand-rolling would mean writing path
matching, `pushState` navigation, a `popstate` listener and link interception —
roughly 80 lines of code I would then have to get right, against one boring
dependency that every React developer already understands. Browser back/forward
bugs are user-visible and tedious to chase.

Recorded as a judgment call rather than assumed. If it is unwanted, the swap is
contained to `main.tsx` and the route definitions.

Nothing else is added. State is `useState`/`useEffect`, data fetching is
`fetch`, styling is one hand-written stylesheet.

### 2.2 The API client

One module, `src/api.ts`:

- Base URL from `import.meta.env.VITE_API_BASE_URL`.
- Reads the secret from `localStorage` on each request.
- Adds `Authorization: Bearer <secret>`.
- Parses `ApiErrorBody` (the shape every non-2xx response uses since phase 1)
  and throws a typed `ApiError` carrying `status`, `code`, `message`.
- **On `401`: clear `localStorage` and redirect to `/login`** (§10). Handled
  centrally so no view has to think about it.

Typed helpers return the shared DTOs — `ConceptDto`, `StoryDto`,
`FrameSummaryDto`, `FrameDto`, `GenerationSummaryDto` — so the client and server
cannot disagree about response shapes.

`multipart/form-data` for the image upload must **not** set `Content-Type`
manually; the browser has to add the boundary. A comment will say so, because
setting it is the natural mistake and produces a confusing `415` from multer.

### 2.3 Auth state

A small `AuthContext` holding the secret and `login` / `logout`. Backed by
`useState` seeded from `localStorage` — React state, not a state library.

A `RequireAuth` wrapper redirects to `/login` when there is no secret. The
login screen validates the secret by calling an authenticated endpoint
(`GET /concepts`) and only stores it on success, so a wrong secret is reported
immediately instead of on the next navigation.

### 2.4 Data fetching

No cache, no query library. Each view fetches what it needs in `useEffect` and
holds `{ data, loading, error }` in local state. A tiny `useApi` helper removes
the repetition.

At this scale — one user, a handful of records — refetching on navigation is
simpler and more predictable than any cache, and it means the frame view always
reflects what the server actually has after a generation.

### 2.5 Generation polling

A `useGenerationPolling(generationId)` hook:

- Polls `GET /generations/:id` every `POLL_INTERVAL_MS` (2s, from `shared`).
- Stops on a terminal status.
- Gives up at `CLIENT_POLL_CEILING_MS` (105s) with a client-side timeout state.
  That constant is deliberately longer than the server's 90s deadline so the
  server's classified error arrives first and the user sees an actionable
  message rather than a generic client timeout.
- Tracks **elapsed seconds** for the §12.3 timer. The spec is explicit that
  10–40s is normal and "silence reads as failure."
- Cleans up its interval on unmount.

**On mount the frame view resumes an in-flight generation.** `GET /frames/:id`
returns generation history newest-first, so if the newest is `pending` the view
starts polling it. Without this, a page reload during a generation leaves the UI
stuck in `idle` while a real generation completes invisibly — and pressing
Generate again would just return `409`.

### 2.6 The identity-only placeholder — enforcement point 2

Per §8.2, and varying by concept type as the skill specifies (settings get "the
place, not a shot of the place"):

```
character  Physical appearance, costume, materials, colours, wear, distinguishing
           marks. NOT pose, action, expression, environment, lighting, camera
           angle or mood — the frame description supplies those.

setting    Architecture, materials, scale, contents, era, state of repair.
           Describe the place as it permanently is, not a shot of it — no
           weather, time of day or lighting.

prop       Form, materials, colours, scale, markings, condition. The object
           alone — not what holds it, and not its surroundings.
```

Short help text sits under the textarea saying the same thing in one line, so
the rule survives the user typing (a placeholder disappears on first keystroke).

### 2.7 Concept picker and the character budget

The frame editor shows two lists: attached concepts **in order**, and available
concepts to add.

- Clicking an available concept **appends** it — attachment order is the array
  order, which becomes `ord`, which becomes the reference-image enumeration
  order. The attached list shows its index explicitly (`1.`, `2.`, `3.`) so the
  ordering is visible rather than implicit.
- Each attached concept has a remove control, and move-up / move-down controls
  so the order can be changed. Ordering matters to output quality, so being able
  to see and change it is part of the picker, not an extra feature.
- **Remaining character slots are surfaced**: "Characters 2 / 4" and
  "Concepts 5 / 10", turning red at the cap. §8.3 asks for exactly this rather
  than "letting a user attach nine and receive slop."
- A concept with no reference image is marked, because the compiler skill names
  a missing reference image as the most common cause of character drift.

### 2.8 Confirmation is inline — never `window.confirm`

Three places need a confirmation: replacing an existing description (§12.2), and
deleting a concept, story or frame (§2.9).

**Decision: all of them use an inline two-step control** — the button swaps into
"Really delete?" / "Cancel" in place — and the client never calls
`window.confirm`, `alert` or `prompt`.

Two reasons, and the second is not obvious:

1. A native modal is a jarring interruption for something as ordinary as
   replacing a text field.
2. **A native dialog blocks the page's event loop and freezes browser
   automation entirely.** Since §5 verifies this phase by driving Chrome, a
   `window.confirm` anywhere in the delete or overwrite path would make the
   walkthrough impossible to complete — the very flows that most need checking.

### 2.9 Delete controls

Added at the user's direction (§7). One delete control per detail view:

| View | Action | After |
|---|---|---|
| `/concepts/:id` | `DELETE /concepts/:id` | back to `/concepts` |
| `/stories/:id` | `DELETE /stories/:id` | back to `/stories` |
| `/stories/:id/frames/:frameId` | `DELETE /frames/:id` | back to `/stories/:id` |

Each behind the inline confirmation from §2.8, and each stating what will be
lost, because two of the three cascade: deleting a story removes its frames and
every generation under them, and deleting a frame removes its generations. The
server deletes the corresponding S3 objects (phase 6), so this is genuinely
irreversible — the confirmation text should say so rather than being a generic
"Are you sure?".

Deleting a concept that is attached to frames detaches it and leaves those
frames intact — verified at the database level in phase 1 and through the API in
phase 4 — so its confirmation does not need to threaten frame loss.

### 2.10 Frame reordering

Added at the user's direction (§7). Move-left / move-right controls on each tile
in the story grid — not drag-and-drop, which is a substantially larger feature
for a proof of concept.

The arithmetic uses `positionBetween` from `shared/`, the pure function built
and tested in phase 4 precisely so the client and server could share one
implementation of the ordering scheme. This is the caller it was written for.

For a frame at index `i` in the position-ordered array:

```ts
// left: land between the two frames that currently precede it
positionBetween(frames[i - 2]?.position ?? null, frames[i - 1]!.position)

// right: land between the two frames that currently follow it
positionBetween(frames[i + 1]!.position, frames[i + 2]?.position ?? null)
```

Then `PATCH /frames/:id { position }` and refetch. Move-left is disabled on the
first tile, move-right on the last.

**Only one row is written per move** — that is the entire reason `position` is a
`DOUBLE PRECISION` rather than a sequence integer (§5.2), and phase 4 confirmed
it against the database. The `Frame N` labels are derived from array order
(§2.11), so they renumber themselves with no extra work.

### 2.11 Saving text fields

Descriptions autosave on blur with a `PATCH`, showing a small "Saved" marker.
The wireframe shows no Save button and §12.1 lists none.

Exception: the frame description is **also** saved before a generation starts,
so pressing "Generate Frame" straight after typing cannot generate from a stale
description. That is a real hazard of blur-based saving, and generation is the
expensive operation.

### 2.12 Frame labels are derived, never stored

`Frame 1`, `Frame 7` come from the index in the position-ordered array at render
time (§5.2). No label is stored, sent, or cached — a second source of truth
would go stale on the first reorder.

### 2.13 Styling

One hand-written `index.css`. The wireframe is stark: a header with two tabs,
tile grids, a back chevron, plain controls. The client should be clean, legible
and unstyled-looking rather than designed — this is a proof of concept and
elaborate styling would be scope the spec does not ask for.

Practical requirements only: a responsive tile grid, 16:9 image containers so
frames do not jump as images load, visible focus states, and a disabled style
for buttons that are busy.

### 2.14 Testing

**No automated client tests.** `CLAUDE.md`: "Everything else is exercised by
using the app," and it names only three test areas, none of which is the client.

Verification is a **driven browser walkthrough** of the full flow with
screenshots (§5), which is the honest way to check a UI and catches things a
DOM test would not — layout collapse, an image that never loads, a spinner that
never resolves.

---

## 3. Repository layout after phase 7

```
client/src/
├── main.tsx                    MOD  router + AuthProvider
├── index.css                   NEW  the whole stylesheet
├── api.ts                      NEW  fetch wrapper, typed calls, 401 handling
├── auth.tsx                    NEW  AuthContext, RequireAuth
├── hooks.ts                    NEW  useApi, useGenerationPolling
├── components/
│   ├── Layout.tsx              NEW  header, two tabs, <Outlet/>
│   ├── TileGrid.tsx            NEW  shared grid + "+" tile
│   ├── ImageTile.tsx           NEW  16:9 image or placeholder
│   └── ConfirmButton.tsx       NEW  inline two-step confirm (never window.confirm)
└── routes/
    ├── Login.tsx               NEW
    ├── Concepts.tsx            NEW  grid + inline create
    ├── ConceptDetail.tsx       NEW  upload, description, generate description
    ├── Stories.tsx             NEW  grid + inline create
    ├── StoryDetail.tsx         NEW  frame grid, trailing "+"
    └── FrameEditor.tsx         NEW  the generate loop
```

`App.tsx` (the phase 1 health-check scaffold) is deleted.

New dependency: `react-router-dom`. No changes to `shared/` or the server.

---

## 4. Step-by-step execution

Built in the route order §13 prescribes.

### Step 1 — Foundation

`api.ts`, `auth.tsx`, `hooks.ts`, `index.css`, `Layout.tsx`, and the router in
`main.tsx`. Delete `App.tsx`.

### Step 2 — `/login`

Secret entry, validation against a real endpoint, redirect to `/concepts`.

### Step 3 — `/concepts` and `/concepts/:id`

Grid with leading "+" and inline create (`{ name, type }`), then the detail view:
image, upload, description with the §2.6 placeholder, "Generate Description"
with the §12.2 overwrite confirmation, and the delete control (§2.9).

`ConfirmButton` is written here and reused by every later confirmation.

### Step 4 — `/stories` and `/stories/:id`

Story grid with cover thumbnails and a delete control, then the frame grid in
position order with a trailing "+" that appends a frame and navigates to it,
plus the move-left / move-right reorder controls (§2.10).

### Step 5 — `/stories/:id/frames/:frameId`

The largest view: image, description, concept picker (§2.7), "Generate Frame",
the four states (§12.3), history thumbnails and selection (§12.4), and the frame
delete control (§2.9).

### Step 6 — Polish pass

Loading and empty states, disabled buttons during in-flight work, error banners,
and the back chevron on detail views.

---

## 5. Verification — a driven browser walkthrough

Run the real API and client, and drive Chrome through the whole flow,
screenshotting each view. Budget **two billed generations**.

1. **Login** — wrong secret shows an error and does not store; correct secret
   lands on `/concepts`. Reloading stays logged in.
2. **Concepts** — create a `character` and a `setting`; upload a reference image
   to each; confirm the placeholder states the identity-only rule; use "Generate
   Description" on an empty field (writes straight in), then again on a filled
   field (**confirms first**, and cancelling leaves the text untouched).
3. **Stories** — create a story; confirm the grid tile appears.
4. **Story detail** — add three frames; confirm they render as "Frame 1/2/3" in
   position order with a trailing "+".
5. **Frame editor** — attach both concepts, confirm the order is visible and the
   character counter reads "1 / 4"; write a scene description; **Generate**.
   - Confirm the generating state shows an elapsed timer that advances.
   - Confirm the image appears on success and the story grid tile updates.
6. **History** — generate a second time; confirm both thumbnails appear, the
   selected one is marked, **the displayed image does not change on its own**,
   and clicking the other thumbnail switches it.
7. **Failure** — enter a prohibited description and generate; confirm the failed
   state shows a rephrase-oriented message with the description still editable
   in place, and a retry action.
8. **Reload during generation** — start a generation, reload the page, confirm
   the view resumes polling rather than showing idle.
9. **Reordering** — in the story grid, move the third frame left twice and
   confirm it becomes Frame 1, that the other tiles keep their images and
   contents, and that the labels renumber. Confirm in SQL that **only the moved
   frame's `position` changed**. Move a frame to the far right too, and confirm
   move-left is disabled on the first tile and move-right on the last.
10. **Deleting** — delete a frame from its editor and confirm the story grid
    renumbers; delete a concept that is attached to a frame and confirm the
    frame survives with the concept detached; delete a story and confirm it
    disappears from the grid. Confirm each control requires the inline second
    click, and that **cancelling deletes nothing**.
11. **401 handling** — corrupt the stored secret, reload, confirm the client
    returns to `/login`.
12. **Build** — `npm run build` succeeds and typecheck is clean.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Placeholder omitted → enforcement point 2 silently missing | Explicit exit criterion and walkthrough step |
| "Generate Description" clobbering hand-tuned text | Confirmation before replace; cancel path tested (§5.2) |
| A reload during generation stranding the UI | Resume polling from the newest pending generation (§2.5) |
| Regeneration appearing to replace the current image | History thumbnails plus an explicit check that the image does not change on its own (§5.6) |
| Frame labels drifting from order | Derived at render time, never stored (§2.9) |
| Attachment order invisible to the user | Numbered attached list with move controls (§2.7) |
| Setting `Content-Type` on the upload | Comment in `api.ts`; the browser must set the boundary |
| Client timeout pre-empting the server's error | `CLIENT_POLL_CEILING_MS` (105s) > server deadline (90s) |
| A native `confirm()` freezing the automated walkthrough | Inline two-step confirmation everywhere (§2.8) |
| An accidental delete losing generations irreversibly | Inline confirmation naming what cascades (§2.9) |
| Reorder rewriting every row | `positionBetween` writes one row; asserted in SQL (§5.9) |

---

## 7. Resolved question

**Delete controls and frame reordering — YES to both**, answered by the user on
2026-08-19. Specified in §2.9 and §2.10, exercised in §5.9 and §5.10.

Both go beyond §12.1's route table, which lists neither, and are recorded here
so a later reader can tell they were requested rather than assumed. Reordering
in particular finally gives `positionBetween` — written and tested in phase 4
for exactly this purpose — its intended caller.

---

## 8. Explicitly deferred

| Item | Status |
|---|---|
| Deploying the client to Vercel and the API to Railway | Not part of §13 item 7; notes recorded in the phase 1 plan |
| Drag-and-drop frame reordering | Out of scope — move-left / move-right covers reordering at a fraction of the complexity (§2.10) |
| Concept rename / retype in the UI | §12.1 lists only image, description and Generate Description |
| Export, PDF, contact sheet | Explicitly out of scope for v1 |
| Optimistic updates, caching, offline | Refetch-on-navigation is correct at this scale (§2.4) |

---

## 9. Execution notes

### Walkthrough results

Every §5 step passed, driven through Chrome:

- **Login** — wrong secret rejected with "That secret was not accepted." and nothing stored; correct secret lands on `/concepts`; `RequireAuth` bounces an unauthenticated `/concepts` to `/login`.
- **The identity-only placeholder renders, and differs by type** — the `character` variant lists appearance and excludes pose/lighting/camera; the `setting` variant says "Describe the place as it permanently is, not a shot of it". Enforcement point 2 is live.
- **§12.2 both paths** — generating into an empty field wrote straight in; generating over existing text raised the inline confirmation showing the draft for comparison, and **"Keep mine" left the original untouched**.
- **Generation states** — idle, then "Generating… 5s" advancing to 6s with "10 to 40 seconds is normal", then the image.
- **§12.4** — a second generation added a thumbnail while the **selected image did not change on its own**; clicking the other thumbnail switched it.
- **Concept picker** — order visible as `1. Spaceman`, `2. Old Keep`; budget reading "Characters 1 / 4 · Total 2 / 10"; move controls disabled at the ends.
- **Reordering** — two move-lefts took the third frame to the front, labels renumbered, and SQL confirmed **only the moved row was written** (the others still held 1000 and 2000).
- **Failed state** — a prohibited description produced a "Content filter" heading, a rephrase message, a Retry action, and the description still editable in place.
- **Deletes** — the inline confirmation armed and cancelled cleanly; deleting a concept attached to a frame detached it while **both frames and both generations survived**.
- **401** — corrupting the stored secret and reloading returned to `/login`.
- Build succeeds; typecheck clean; 67/67 tests; **zero 5xx and zero unhandled errors** across the whole walkthrough.

### Changed during execution

| Change | Reason |
|---|---|
| Tile images use `object-fit: contain`, not `cover` | `cover` cropped a portrait concept reference down to a band of its middle, hiding the legs and top of the head. Concept references have arbitrary aspect ratios. |
| Removed a stray `eslint-disable` directive | The project has no linter; replaced with a comment explaining why that effect keys on `status` alone. |

### Defect found in phase 6 code, fixed here

Cleanup left **one orphaned S3 object**. Tracing it showed it was not from this phase: deleting a frame or story collects its generation image keys *before* deleting the rows, so a generation still **in flight** has no key yet — and when its background task later writes to S3, the object is orphaned with no row referencing it and no sweeper to find it.

`markSucceeded` now reports whether the row still existed, and `runGeneration`
deletes the object it just wrote when the row has vanished. Roughly five lines,
and it closes a hole that silently accumulates paid-for objects.

Found only because the object count was checked at the end rather than assumed
to be zero.

### Observations

- **Screenshots can lag the DOM.** A frame thumbnail appeared blank in two consecutive screenshots; `complete: true`, `naturalWidth: 1376` and a correct bounding box proved the image was loaded and painted, and a later screenshot showed it. Worth knowing before chasing a rendering bug that is a capture artifact.
- **Batched coordinates go stale.** Coordinates in a `browser_batch` refer to the layout *before* the batch ran, so a scroll mid-batch invalidates every later click. One generate click missed this way — harmlessly, since it fired nothing.
