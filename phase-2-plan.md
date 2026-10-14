# Phase 2 Plan — Concepts CRUD + S3 Upload with `sharp` Preprocessing

> Historical implementation record. References to `CLAUDE.md` and `.claude/skills/` describe the original layout. For current contribution instructions, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the skills linked from AGENTS.md.

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 2
**Depends on:** phase 1 (schema, config module, auth middleware) — complete
**Written:** 2026-08-18

---

## 1. Goal and exit criteria

Phase 2 delivers the concept library's server side: six endpoints, a private S3
bucket with a least-privilege IAM identity, and the `sharp` preprocessing step
that makes every reference image cheap to send to Gemini later.

Concepts are the anchor of the whole system — the reference images stored here
are what keep a character looking the same in frame 1 and frame 7 — so this
phase is about getting the storage path right, not about volume of code.

**Phase 2 is done when all of the following are true:**

1. A private S3 bucket exists, with Block Public Access fully on.
2. A dedicated IAM user with object-level access to that bucket only, and its
   access key present in `server/.env` and never printed or committed.
3. `npm run typecheck` passes; `npm test` still passes.
4. `POST /api/concepts` creates a concept and returns `201` with the new row.
5. `GET /api/concepts` lists concepts, each with a presigned `imageUrl` (or
   `null` when no image has been uploaded).
6. `GET /api/concepts/:id` returns one concept; unknown id returns `404`.
7. `PATCH /api/concepts/:id` updates any subset of `{ name, type, description }`.
8. `DELETE /api/concepts/:id` returns `204`, removes the row, and removes the
   S3 object.
9. `POST /api/concepts/:id/image` accepts `multipart/form-data`, stores a
   preprocessed JPEG, and returns the concept with a working `imageUrl`.
10. A stored reference image is verifiably: long edge ≤ 1024px, JPEG, EXIF
    stripped, correctly oriented, and opaque.
11. Bad uploads produce typed errors, not 500s: non-image → `415`, corrupt
    image → `400`, oversized → `413`.
12. `GET /api/ping` is gone.

**Not in phase 2:** `POST /concepts/:id/describe` and the description
meta-prompts (phase 3), anything to do with stories, frames, or generations
(phases 4–6), and every client view including the concept grid and the
identity-only textarea placeholder (phase 7).

---

## 2. Decisions

### 2.1 AWS identity — a scoped IAM user, not the root credentials

The CLI in this terminal is authenticated as the **account root**
(`arn:aws:iam::403894226819:root`), and the account holds unrelated production
data (`bearlake-media-prod`). Root access keys in an application `.env` would
give a prototype unlimited authority over that account.

**Decision:** provision a dedicated IAM user, `storyboards-server`, with an
inline policy granting `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/*` and nothing else. Its access key goes in
`server/.env`. Root credentials are used only to provision, never at runtime.

This mirrors the `bearlake-server` user already in the account, so it matches
how this account is evidently already organized.

`s3:ListBucket` is deliberately excluded — the application only ever addresses
objects by a key it computed itself, and never enumerates the bucket.

**This step creates real IAM resources in a live account, so confirm before
running it.** If a scoped user is not wanted, the fallback is root keys in
`.env`, which works but is a materially worse security posture and should be a
deliberate choice rather than a default.

### 2.2 Bucket configuration

| Setting | Choice | Rationale |
|---|---|---|
| Name | `storyboards-prototype-media-<8 hex>` | Bucket names are globally unique; a random suffix avoids both collisions and putting the account ID in a public-facing name |
| Region | `us-east-1` | Matches the CLI default and the account's existing buckets |
| Block Public Access | All four settings on | §9: the bucket stays private; reads are presigned |
| Encryption | SSE-S3, left at the default | Enabled by default on new buckets since 2023; an explicit call would add nothing |
| Versioning | Off | Re-uploading a reference image is intended to replace it |
| CORS | **None** | Uploads route through the backend, and presigned GET URLs are consumed as `<img src>`, which is not a CORS-governed request. §9 calls this out as a benefit of backend uploads — do not add a CORS config "just in case" |
| Lifecycle rules | None | Out of scope |

`create-bucket` in `us-east-1` must **not** pass
`--create-bucket-configuration LocationConstraint=us-east-1`. That is an error
in this one region, and the resulting message is unhelpful.

### 2.3 Object keys

§9 specifies `concepts/{conceptId}/reference.{ext}`. Since preprocessing always
emits JPEG, `{ext}` is always `jpg` and the key is fully deterministic:

```
concepts/{conceptId}/reference.jpg
```

`image_mime` is therefore always `image/jpeg`. The column still earns its place:
phase 5 reads it to populate the Gemini input part's `mime_type`, and reading it
from the row beats hardcoding a literal at that call site.

**Re-upload overwrites the same key.** This is safe and does not serve stale
images: every presigned URL carries a fresh `X-Amz-Date` and signature, so a
re-uploaded concept yields a different URL string and cannot hit a stale browser
cache entry. S3 has been strongly read-after-write consistent since 2020.

### 2.4 The `sharp` pipeline

```ts
sharp(input, { failOn: "error" })
  .rotate()
  .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
  .flatten({ background: "#ffffff" })
  .jpeg({ quality: 85 })
  .toBuffer()
```

Four things here are non-obvious and each fails quietly if omitted:

**`.rotate()` must come first, with no arguments.** §9 says "strip EXIF", and
`sharp` already strips metadata by default. But orientation lives *in* EXIF: a
phone photo is often stored sideways with an orientation tag telling viewers to
turn it. Strip the tag without applying it and the reference image is rotated
90°, which then teaches Gemini that the character lies on their side. Bare
`.rotate()` bakes in the EXIF orientation and then drops the tag.

**`fit: "inside"` with `withoutEnlargement: true`** caps the long edge at 1024
while preserving aspect ratio, and leaves already-small images alone. Passing
plain `.resize(1024, 1024)` would crop to a square and cut off part of the
subject.

**`.flatten()` before `.jpeg()`.** JPEG has no alpha channel. A PNG reference
with a transparent background — a very likely way to upload a prop — composites
onto black without this, producing a black-backgrounded reference. White is the
neutral choice and gives the model a clean plate.

**`failOn: "error"`** makes `sharp` reject a truncated or corrupt file rather
than silently producing a partial image. `sharp`'s default
`limitInputPixels` guard against decompression bombs is left at its default,
which is appropriate here.

`mozjpeg: true` would shrink output further at some CPU cost. Deliberately not
enabled — §9 asks for quality 85 and nothing more.

### 2.5 Upload handling

- **`multer` 2.x with `memoryStorage()`.** Files are capped at 10 MB and go
  straight into `sharp`; a disk round-trip would buy nothing. Version 2.x
  specifically — 1.x is deprecated and carries known advisories.
- **Field name `image`, `limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }`.**
- **The client-supplied MIME type is a hint, not a check.** A cheap
  `mimetype.startsWith("image/")` filter gives a fast `415` for obvious
  mistakes, but the authoritative validation is whether `sharp` can decode the
  bytes. Nothing downstream trusts the declared type.
- **`multer` errors must be translated.** A `MulterError` with code
  `LIMIT_FILE_SIZE` propagates as an ordinary error and would surface as a
  generic `500`. The router wraps the multer middleware and maps
  `LIMIT_FILE_SIZE` → `413 file_too_large`, `LIMIT_FILE_COUNT` /
  `LIMIT_UNEXPECTED_FILE` → `400 invalid_input`. Without this wrapper the size
  limit is invisible to the user.

### 2.6 Write ordering on upload

S3 `PutObject` **first**, then the database `UPDATE`.

If the database write fails after a successful put, the bucket holds an object
at a deterministic key that no row references — harmless, and overwritten by the
next upload for that concept. Reversed, a database row would point at an object
that does not exist, and every later read and every generation including that
concept would fail on a missing key. Prefer the orphan.

### 2.7 Deleting a concept

`DELETE /concepts/:id` removes the row (the schema cascades `frame_concepts`)
and then deletes the S3 object **best-effort**: failures are logged and do not
fail the request, since the row is already gone and the response should reflect
that.

§9 does not mention object cleanup, so this is a judgment call. The reasoning:
there is no orphan sweeper anywhere in this system and none is planned, so
without an inline delete the bucket accumulates unreachable objects forever.
Past generations are unaffected — they store their own output under
`generations/{id}.jpg` and keep a copy of the concept's description in
`input_snapshot`, so deleting a concept's reference image cannot damage them.

### 2.8 API shapes

Concepts are returned as:

```ts
interface ConceptDto {
  id: string;
  name: string;
  type: ConceptType;
  description: string;
  imageUrl: string | null;   // presigned GET, 1h expiry; null until uploaded
  imageMime: string | null;
  createdAt: string;         // ISO 8601
  updatedAt: string;
}
```

`image_key` is **not** exposed. It is an internal storage detail, the client has
no use for it, and `imageUrl: null` already communicates "no image yet".

Status codes: `POST` → `201`; `GET`/`PATCH`/image upload → `200`; `DELETE` →
`204` with no body.

`POST /concepts` takes `{ name, type }` only, per §6. `description` starts empty
and is set through `PATCH` — which is also what phase 3's `/describe` flow
expects, since that endpoint returns text without persisting and the client
commits it separately.

**Presigned URLs expire after an hour** (`PRESIGNED_URL_TTL_SECONDS`, already in
`shared/config.ts`). A page left open longer than that will show broken images
until it refetches. Acceptable for a single-user prototype; noted so it is not
mistaken for a bug later.

### 2.9 Validation

Request schemas move into `shared/src/schemas.ts` — phase 1 deliberately
deferred them until there were routes to use them.

```ts
export const CreateConceptSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(CONCEPT_TYPES),
});

export const UpdateConceptSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(CONCEPT_TYPES).optional(),
    description: z.string().max(5000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export const UuidParamSchema = z.object({ id: z.uuid() });
```

`description` allows the empty string — clearing a description is legitimate —
but `name` does not. The 5000-character ceiling is a sanity bound, not a content
rule; the identity-only rule is enforced by the meta-prompt, the UI placeholder,
and the compiler, never by rejecting user text.

Schemas live in `shared/` so the phase 7 client reuses them, per `CLAUDE.md`.

### 2.10 Dynamic updates without dynamic SQL

`PATCH` accepts any subset of three fields. Rather than building a `SET` clause
by string concatenation, use `COALESCE` with a null for each absent field:

```sql
UPDATE concepts SET
  name        = COALESCE($2, name),
  type        = COALESCE($3::concept_type, type),
  description = COALESCE($4, description),
  updated_at  = now()
WHERE id = $1
RETURNING ...
```

This is safe here precisely because all three columns are `NOT NULL`, so "null"
is unambiguously "not supplied" and can never be a value the user wants to
store. The `::concept_type` cast is required. Verified against Postgres 17
during planning: without it the statement fails at parse time with
`ERROR: COALESCE types text and concept_type cannot be matched`, because a text
parameter cannot be unified with an enum column inside `COALESCE`.

`updated_at = now()` is written explicitly, per the phase 1 convention of no
triggers.

### 2.11 Layering

`CLAUDE.md` requires `routes/ → services/ → db/`. Concretely:

- `routes/concepts.ts` — parse params and body with zod, call the service,
  choose a status code. No SQL, no S3, no `sharp`.
- `services/concepts.ts` — orchestration: existence checks that raise `404`,
  ordering of S3 and database writes, DTO assembly including presigning.
- `services/s3.ts` — the S3 client and the three object operations plus
  presigning. The only module that imports the AWS SDK.
- `services/imagePreprocess.ts` — the `sharp` pipeline. A pure
  `Buffer → Promise<Buffer>` function with no I/O, so it stays trivially
  checkable.
- `db/concepts.ts` — SQL only, returning camelCase-aliased rows.

### 2.12 Environment

`env.ts` gains four variables, promoted from "phase 2" comments to required:
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`.

The SDK's default credential provider chain reads the two AWS key variables
from `process.env` on its own, so they are validated in `env.ts` but not passed
explicitly to the client — validation exists so a missing credential fails at
boot with a clear message instead of on the first upload.

### 2.13 Testing

**No new automated tests in this phase.** `CLAUDE.md` names three areas that
earn tests — prompt compiler, concept caps, position arithmetic — and says
explicitly not to test CRUD handlers. None of phase 2 falls inside that fence.

Instead, §6 below specifies a throwaway verification script that uploads a set
of adversarial images and asserts properties of what actually landed in S3.
It lives in the scratchpad and is not committed. This covers the same ground the
tempting `imagePreprocess` unit test would, and it covers it against real S3
rather than a mock.

---

## 3. AWS provisioning

Run once, from the authenticated terminal. **Confirm §2.1 before running.**

```bash
REGION=us-east-1
BUCKET="storyboards-prototype-media-$(openssl rand -hex 4)"

# us-east-1 takes no LocationConstraint -- passing one is an error.
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws iam create-user --user-name storyboards-server

aws iam put-user-policy --user-name storyboards-server \
  --policy-name storyboards-s3-access \
  --policy-document "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StoryboardsObjectAccess",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BUCKET/*"
    }
  ]
}
JSON
)"

aws iam create-access-key --user-name storyboards-server
```

**Handling the access key.** The secret is shown exactly once. Write it straight
into `server/.env` from the command output without echoing it to the terminal —
it must not end up in scrollback, in the transcript, or in git. `server/.env` is
already gitignored (verified in phase 1).

Verification that the scoping actually works, using the new user's credentials
rather than root:

- `PutObject` into the bucket → succeeds
- `GetObject` from the bucket → succeeds
- `ListBucket` on the bucket → **denied**, which confirms the policy is
  object-scoped rather than blanket access
- `PutObject` into `bearlake-media-prod` → **denied**, which confirms the
  blast radius is limited to this project's bucket

That last check is the one that matters, given what else lives in this account.

---

## 4. Repository layout after phase 2

```
shared/src/
├── schemas.ts                 NEW  zod request schemas
├── types.ts                   MOD  + ConceptDto
└── index.ts                   MOD  + export * from "./schemas.js"

server/src/
├── app.ts                     MOD  mount concepts router; delete /api/ping
├── config/env.ts              MOD  AWS vars promoted to required
├── db/
│   └── concepts.ts            NEW  SQL
├── routes/
│   └── concepts.ts            NEW  6 endpoints + multer wiring
└── services/
    ├── concepts.ts            NEW  orchestration + DTO assembly
    ├── imagePreprocess.ts     NEW  sharp pipeline
    └── s3.ts                  NEW  put / get-signed-url / delete
```

New server dependencies: `sharp` (0.35.x), `multer` (2.2.x),
`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (3.111x.x), plus
`@types/multer` (2.2.x) as a dev dependency — checked during planning, multer
2.2.0 still declares no bundled types.

---

## 5. Step-by-step execution

### Step 1 — Provision AWS (§3)

Create bucket and IAM user, write credentials into `server/.env`, run the four
scoping checks. Record the bucket name in the plan's execution notes.

### Step 2 — Dependencies and environment

Install the four packages into the `server` workspace. Promote the AWS variables
in `server/src/config/env.ts` from commented placeholders to required schema
entries. Add `S3_BUCKET` and a real `AWS_REGION` to `.env.example` with a note
that the values come from §3.

Boot the server once to confirm it still starts, and confirm that removing
`S3_BUCKET` produces the fail-fast message rather than a runtime surprise.

### Step 3 — `shared/src/schemas.ts` and the `ConceptDto` type

Write the three schemas from §2.9 and the DTO from §2.8. Export both from
`index.ts`. Rebuild `shared` and confirm the client and server both still
typecheck.

### Step 4 — `services/s3.ts`

```ts
putObject(key: string, body: Buffer, contentType: string): Promise<void>
getPresignedUrl(key: string): Promise<string>
deleteObject(key: string): Promise<void>
conceptImageKey(conceptId: string): string   // concepts/{id}/reference.jpg
```

One module-scope `S3Client` configured with `region: env.AWS_REGION`.
`getPresignedUrl` uses `getSignedUrl` from `@aws-sdk/s3-request-presigner` with
`expiresIn: PRESIGNED_URL_TTL_SECONDS`.

### Step 5 — `services/imagePreprocess.ts`

The §2.4 pipeline as a single exported function taking a `Buffer` and returning
a `Buffer`. A `sharp` throw becomes `AppError(400, "invalid_image", ...)`.
No I/O, no S3, no database — the same purity discipline the phase 5 prompt
compiler will need, applied here because it costs nothing.

### Step 6 — `db/concepts.ts`

`listConcepts`, `getConceptById`, `insertConcept`, `updateConcept` (the
`COALESCE` statement from §2.10), `deleteConcept` (returns the deleted row's
`imageKey` so the service can clean up S3), `setConceptImage`.

Every `SELECT` aliases to camelCase (`image_key AS "imageKey"`) per the phase 1
convention. `listConcepts` orders by `created_at DESC` — the spec is silent, and
newest-first puts a freshly created concept next to the "+" tile in the phase 7
grid. Recorded as a judgment call, cheap to reverse.

### Step 7 — `services/concepts.ts`

Orchestration and DTO assembly. `toDto` presigns when `imageKey` is non-null and
sets `imageUrl: null` otherwise; the list path presigns in parallel with
`Promise.all`. Missing rows raise `AppError(404, "not_found", ...)`. The upload
path follows §2.6 ordering, and delete follows §2.7.

### Step 8 — `routes/concepts.ts`

Six routes. Bodies parsed with the §2.9 schemas — `.parse()`, letting `ZodError`
reach the phase 1 error handler, which already renders it as `400 invalid_input`
with per-field details. `:id` validated with `UuidParamSchema` so a malformed
UUID returns `400` rather than reaching Postgres and failing as a `500`.

The image route wires multer per §2.5, including the `MulterError` translation
wrapper. A request with no file at all is `415 unsupported_media_type`.

### Step 9 — Mount and clean up

Mount the router in `app.ts` after the auth middleware. **Delete the temporary
`GET /api/ping` route**, which phase 1 marked for removal here.

---

## 6. Verification

### 6.1 API surface

With the server running and `SECRET=$APP_SECRET`:

```bash
# create
curl -sX POST localhost:3001/api/concepts -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' -d '{"name":"Spaceman","type":"character"}'

# list / read / update
curl -s localhost:3001/api/concepts -H "Authorization: Bearer $SECRET"
curl -s localhost:3001/api/concepts/$ID -H "Authorization: Bearer $SECRET"
curl -sX PATCH localhost:3001/api/concepts/$ID -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' -d '{"description":"A weathered astronaut in a matte off-white suit..."}'

# upload
curl -sX POST localhost:3001/api/concepts/$ID/image \
  -H "Authorization: Bearer $SECRET" -F "image=@reference.jpg"

# delete
curl -sX DELETE -o /dev/null -w '%{http_code}\n' localhost:3001/api/concepts/$ID \
  -H "Authorization: Bearer $SECRET"
```

Negative cases, each of which must produce its typed code and not a `500`:

| Request | Expected |
|---|---|
| `POST` with no `name` | `400 invalid_input`, details naming `name` |
| `POST` with `type: "vehicle"` | `400 invalid_input` |
| `PATCH` with `{}` | `400 invalid_input` |
| `PATCH` with `name: ""` | `400 invalid_input` |
| Any route with a non-UUID `:id` | `400 invalid_input` |
| Any route with an unknown UUID | `404 not_found` |
| Every route without a token | `401 unauthorized` |
| `GET /api/ping` | `404 not_found` |

### 6.2 Preprocessing — the part worth real scrutiny

A throwaway script in the scratchpad (not committed) that generates adversarial
inputs with `sharp`, uploads each through the API, downloads the stored object
back through its presigned URL, and asserts on the result:

| Input | Assertion on the stored object |
|---|---|
| 4000×3000 JPEG | format `jpeg`, long edge exactly 1024, aspect ratio preserved |
| 400×300 JPEG | **not** upscaled — still 400×300 |
| PNG with a transparent background | no alpha channel; the transparent region is white, not black |
| JPEG with EXIF orientation 6 (rotated) | pixel dimensions reflect the applied rotation, and no EXIF block remains |
| JPEG with GPS + camera EXIF | no EXIF in the stored object |
| A `.txt` renamed `.jpg` | `400 invalid_image`, nothing written to S3 |
| A truncated JPEG | `400 invalid_image` |
| An 11 MB file | `413 file_too_large` |
| A request with no file part | `415 unsupported_media_type` |

The EXIF-orientation row is the single most valuable check in this phase: it is
the failure that produces a sideways reference image, which would degrade every
frame generated from that concept while looking like a model quality problem
rather than an upload bug.

### 6.3 Storage and lifecycle

```bash
aws s3api list-objects-v2 --bucket "$BUCKET" --query 'Contents[].{Key:Key,Size:Size}'
```

- After upload, exactly one object at `concepts/{id}/reference.jpg`.
- After a second upload to the same concept, still exactly one object, with a
  newer `LastModified` and the new image's dimensions.
- After `DELETE /concepts/:id`, zero objects.
- The presigned URL loads in a browser; the bare `https://<bucket>.s3...` URL
  without a signature returns `403`, confirming the bucket is genuinely private.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| EXIF orientation stripped without being applied → sideways references | `.rotate()` first in the pipeline; explicitly asserted in §6.2 |
| Transparent PNG composited onto black | `.flatten({ background: "#ffffff" })`; asserted in §6.2 |
| `multer` size limit surfacing as a generic `500` | `MulterError` translation wrapper (§2.5); asserted in §6.2 |
| Database row pointing at a nonexistent object | S3 write precedes the database write (§2.6) |
| Root credentials in an application `.env` | Dedicated least-privilege IAM user (§2.1), with the blast radius verified against `bearlake-media-prod` |
| Access key leaking into scrollback or git | Written directly into the gitignored `server/.env`, never echoed (§3) |
| Enum/text mismatch on `PATCH` | Explicit `$3::concept_type` cast (§2.10), verified against Postgres 17 |
| Malformed UUID reaching Postgres as a `500` | `UuidParamSchema` on every `:id` route (§2.8) |

---

## 8. Explicitly deferred

| Item | Phase |
|---|---|
| `POST /concepts/:id/describe` and the type-specific meta-prompts | 3 |
| Stories, frames, ordering, concept attachment | 4 |
| Prompt compiler | 5 |
| Generation pipeline and `generations/{id}.jpg` objects | 6 |
| Concept grid, upload control, description textarea and its identity-only placeholder | 7 |
| Concept reference canonicalization (a clean neutral-background plate) | Out of scope for v1; `TECH_SPEC.md` §3 names it the first lever to pull if consistency disappoints |
| Orphaned-object sweeper, bucket lifecycle rules | Not planned; inline best-effort delete (§2.7) is the whole cleanup story |

---

## 9. Execution notes

Recorded after execution. Where the built code differs from the plan above, the
code is correct and this section says why.

**Provisioned resources**

| Resource | Value |
|---|---|
| Bucket | `storyboards-prototype-media-94733c4f` (us-east-1) |
| IAM user | `arn:aws:iam::403894226819:user/storyboards-server` |
| Inline policy | `storyboards-s3-access` — Put/Get/DeleteObject on that bucket's objects only |

Scoping verified with the new user's own credentials: Put/Get/DeleteObject on
the project bucket ALLOWED; `ListBucket` on it DENIED; `PutObject` on
`bearlake-media-prod` DENIED; account-wide `ListBuckets` DENIED. If this
prototype's key leaks it reaches exactly one bucket and cannot discover that any
others exist.

**Changes from the plan**

| Change | Reason |
|---|---|
| `z.uuid()` is strict about RFC version/variant nibbles | Discovered during step 3: a hand-written placeholder like `11111111-...-111111111111` is rejected as malformed. Correct to keep — every id here comes from `gen_random_uuid()`, which emits conformant v4 — but documented in `schemas.ts` because a `400` on a plausible-looking UUID is otherwise baffling. Test fixtures must use real v4 UUIDs. |
| EXIF orientation fixtures use `withMetadata({ orientation })`, not `withExif({ IFD0: { Orientation } })` | The `withExif` form accepts the string and writes something, but sharp does not read it back as an orientation, so the first version of the check was silently vacuous — it passed while testing nothing. |
| SSE-S3 encryption needed no explicit call | Confirmed already `AES256` on the new bucket, as the plan predicted. |
| IAM propagation requires a retry on first use | A new access key is not immediately usable; a one-shot check produces a false DENIED and sends you debugging a policy that is already correct. |

**Verified beyond the checklist**

- **Counterfactual on `.rotate()`.** Running the same orientation-6 fixture through a pipeline *without* `.rotate()` yields 800x400 pixels with the orientation tag stripped — the exact sideways-reference bug, reproduced on demand. The passing test therefore distinguishes correct from incorrect behaviour rather than merely returning green.
- **Full upload round trip.** A 3000x2000 JPEG tagged orientation 6 with a copyright tag was stored as 683x1024 JPEG, EXIF-free, rotation baked into pixels, retrievable through its presigned URL; the same key without a signature returns `403`, confirming the bucket is genuinely private.
- **Rejected uploads never reach S3.** Object count stayed at 1 across five consecutive upload failures.
- **Re-upload replaces in place.** Still exactly one object, `LastModified` advanced, new dimensions, and a different presigned URL string — so a replaced image cannot be served from a stale cache entry.
- **Delete removes both.** `204`, row gone, S3 object gone, second delete `404`.
- **No `500` was returned at any point.** Status codes observed across the run: 201, 204, 200, 401, 404, 413, 415, 400 — every failure typed.
