# Identity Management Plan — Accounts, Sessions, and Per-User Gemini Keys

> Historical implementation record. References to `CLAUDE.md` and `.claude/skills/` describe the original layout. For current contribution instructions, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the skills linked from AGENTS.md.

**Status:** ready to execute
**Written:** 2026-09-03
**Supersedes:** the single shared-secret auth described in `TECH_SPEC.md` §10

---

## 1. What changes

Today the app is single-user: one `APP_SECRET` unlocks everything, no table
carries an owner, and one server-side `GEMINI_API_KEY` pays for every call.

After this work:

- People **register** with a username, a password, and **their own Gemini API key**.
- They **sign in** with username and password; a session token replaces the shared secret.
- They see **only their own** concepts, stories, frames and generations.
- Every Gemini call is billed to **the calling user's key**, not the server's.
- `APP_SECRET` and the server-side `GEMINI_API_KEY` are **removed**.

This is the debt `TECH_SPEC.md` §10 recorded as "a schema migration plus a
backfill, not a configuration change." It is now being paid.

### 1.1 Existing prohibitions to remove

`CLAUDE.md` currently says, under **Things not to do**:

> Do not add multi-user support, a users table, or `user_id` columns. Auth is one shared secret.

and `TECH_SPEC.md` §3 lists multi-user accounts as out of scope, with §10
recording the missing `user_id` as accepted debt.

**Those prohibitions are withdrawn by this plan.** Phase 7 rewrites both
documents so a future session reads the current intent rather than a rule the
codebase deliberately breaks. Leaving them stale is not an option — the next
person to read `CLAUDE.md` would find it forbidding the architecture in front of
them.

### 1.2 Production data

The user has confirmed the live data (5 concepts, 2 stories) is **test data that
can be wiped**. The migration therefore starts from an empty set: `user_id` is
`NOT NULL` from the first migration, with no nullable-then-tighten dance, no
adoption logic, and no orphan rows.

The wipe is done **through the existing API** rather than in SQL, because
`DELETE /stories/:id` and `DELETE /concepts/:id` already remove the S3 objects
(phases 2 and 6). A raw `TRUNCATE` would leave every reference image and
generated frame orphaned in the bucket.

---

## 2. Decisions

### 2.1 Sessions: opaque tokens in the database, not JWTs

**Decision: a `sessions` table holding random opaque tokens, sent as
`Authorization: Bearer <token>`.**

Three reasons, in order of weight:

1. **Revocability.** A JWT cannot be invalidated before it expires. Sign-out,
   password change, and "this key leaked" all need real revocation, and a row
   you can `DELETE` gives it for free.
2. **No new dependency.** No `jsonwebtoken`, no key rotation story, no
   algorithm-confusion footguns. `crypto.randomBytes` and a table.
3. **The transport does not change.** The client already sends
   `Authorization: Bearer` and stores its credential in `localStorage`. Keeping
   a header-based scheme preserves the CORS reasoning documented in `app.ts` —
   permissive `cors()` is safe *because* the credential is a header, not a
   cookie. Switching to cookies would force `SameSite=None`, an explicit origin
   allowlist, `credentials: true`, and CSRF protection, since the client
   (Vercel) and API (Railway) are different origins.

**Token shape:** 32 random bytes, base64url-encoded (43 characters).

**Stored hashed.** The database keeps `sha256(token)`, never the token itself,
so a database dump does not yield live sessions. This is the same reasoning as
password hashing, applied to bearer credentials. Lookup hashes the incoming
token and matches on the hash column.

**Expiry:** `SESSION_TTL_DAYS = 30`, stored as an absolute `expires_at` and
checked on every request. Expired rows are deleted by the existing sweeper
(§2.9), not left to accumulate.

**Trade-off accepted:** `localStorage` is readable by injected script, so an XSS
bug would expose a session token. The app renders no user-supplied HTML and
React escapes by default; the current design already stores a shared secret the
same way, so this is not a regression. Recorded rather than hidden.

### 2.2 Passwords: `scrypt` from `node:crypto`

**Decision: `crypto.scrypt`, no dependency.**

`bcrypt` and `argon2` are the usual answers, but both are native modules that
must compile on Railway's builder. `scrypt` is a memory-hard KDF built into
Node, needs no build step, and the codebase already reaches for `node:crypto`
for its timing-safe comparison.

**Parameters:** `N=16384, r=8, p=1`, 16-byte random salt, 64-byte derived key.
`128 * N * r` is 16 MB, comfortably under Node's 32 MB default `maxmem`, so no
`maxmem` override is needed and the call cannot fail on a memory guard.

**Stored format:** `scrypt$16384$8$1$<salt-b64>$<hash-b64>` — self-describing, so
parameters can be raised later without a flag day; verification reads them from
the stored string.

**Verification uses `crypto.timingSafeEqual`** on the derived keys, matching the
existing rule in `CLAUDE.md` about never comparing secrets with `===`.

**Policy:** minimum length 10, no composition rules. Length beats character-class
theatre, and NIST has recommended against forced complexity since 2017.

### 2.3 Failed-login throttling — new, and justified

The old credential was 32 bytes of entropy. A human-chosen password is not, and
the API is on the public internet.

**Decision: per-account lockout.** `users.failed_attempts` and
`users.locked_until`. After `MAX_LOGIN_ATTEMPTS = 10` consecutive failures, the
account is locked for `LOGIN_LOCKOUT_MINUTES = 15`. A successful login resets the
counter.

This is roughly fifteen lines and it is not scope creep: it exists specifically
because this change *lowers* credential entropy. Lock state is per-account, not
per-IP, so it needs no request-level middleware or store.

**Locked accounts return the same generic failure** as a wrong password (§2.7).

### 2.4 The user's Gemini key: encrypted at rest, never returned

Users hand over a live, billable API key. It must not sit in the database as
plaintext, and it must never travel back to a browser.

**Decision: AES-256-GCM**, with a server-side master key in a new
`ENCRYPTION_KEY` environment variable (32 bytes, base64).

- Columns: `gemini_key_ciphertext BYTEA`, `gemini_key_iv BYTEA`, `gemini_key_tag BYTEA`.
- A fresh 12-byte IV per encryption. GCM's auth tag means tampering is detected
  rather than silently decrypting to garbage.
- Decrypted only in `services/gemini.ts`, at the moment of a call.

**Never returned by any endpoint.** `GET /auth/me` exposes
`hasGeminiKey: boolean` and `geminiKeyHint` (last 4 characters) so the settings
screen can show *something* without shipping the key. There is no "reveal key"
endpoint; the user re-enters a new key to change it.

**Validated on save.** When a key is set or replaced, the server makes one cheap
`gemini-3.7-flash` call before storing it. A typo is caught in the settings
screen, not on the user's first frame generation forty seconds in.

**`ENCRYPTION_KEY` loss means every stored key is unrecoverable.** That is
acceptable — users re-enter their keys — but it must be a real secret, generated
once with `openssl rand -base64 32`, and never rotated casually.

### 2.5 Ownership model: `user_id` on the two root tables only

**Decision: `concepts.user_id` and `stories.user_id`, both `NOT NULL`. Frames
and generations are scoped transitively.**

- A frame belongs to a story, which has an owner.
- A generation belongs to a frame, which belongs to a story, which has an owner.

Denormalizing `user_id` onto frames and generations would make queries shorter,
at the cost of four places the owner can drift out of sync. With one source of
truth per row, drift is impossible. The extra join is two lines and a
non-issue at this scale.

Concretely:

```sql
-- frame ownership
FROM frames f JOIN stories s ON s.id = f.story_id
WHERE f.id = $1 AND s.user_id = $2

-- generation ownership
FROM generations g
JOIN frames f  ON f.id = g.frame_id
JOIN stories s ON s.id = f.story_id
WHERE g.id = $1 AND s.user_id = $2
```

**`ON DELETE CASCADE` from `users`**, so deleting an account removes its data.
No account-deletion endpoint is being built (§8), but the constraint keeps the
schema honest.

**Cross-user attachment is rejected.** `PATCH /frames/:id { conceptIds }` already
validates that every id exists; that check becomes user-scoped, so attaching
another account's concept fails with the existing `422 unknown_concept` rather
than succeeding and leaking a description into a prompt.

### 2.6 Another user's resource returns `404`, not `403`

**Decision: unauthorized access to an existing row is indistinguishable from a
row that does not exist.**

A `403` confirms the id is real, which turns any endpoint into an existence
oracle. Since ownership is enforced by adding `AND user_id = $n` to the query,
the row simply does not come back, and the existing `not_found` path handles it
with no special-casing. The secure behaviour is also the one that requires the
least code.

### 2.7 Login failures are generic

`POST /auth/login` returns one message — "Invalid username or password" — for an
unknown username, a wrong password, and a locked account. Distinguishing them
tells an attacker which usernames exist.

Registration is necessarily different: "that username is taken" is unavoidable
and is not a meaningful leak for this app.

### 2.8 Registration is open, with an optional gate

The user asked for self-service registration. Worth stating plainly, because it
is the security consequence of this change: **removing `APP_SECRET` takes the app
from "nobody without the secret can get in" to "anyone on the internet can create
an account."** Each account brings its own Gemini key, so cost is not the
exposure — but the app becomes publicly registerable.

**Decision: open registration by default, with an optional `SIGNUP_CODE`
environment variable.** If `SIGNUP_CODE` is unset, registration is open, exactly
as described. If it is set, `POST /auth/register` requires a matching
`signupCode`. Roughly six lines, no behavioural change when unset.

**Recommended:** set `SIGNUP_CODE` for the cutover deploy and unset it once you
have registered. Not required.

### 2.9 Session cleanup reuses the existing sweeper

`services/sweep.ts` already runs on boot and every 60s to mark abandoned
generations. It gains a second statement deleting sessions past `expires_at`.

No new interval, no new process. The sweeper's existing "log only when something
happened" behaviour is preserved so it stays silent in normal operation.

### 2.10 Gemini client construction moves per-call

`services/gemini.ts` currently holds `const ai = new GoogleGenAI({})` at module
scope, reading `GEMINI_API_KEY` from the environment. That singleton must go.

**Decision: both exported functions take an `apiKey` and construct a client for
the call.** Construction is local object setup with no network I/O, so
per-request construction costs nothing measurable, and a cache keyed by key
material would be a place for one user's client to be handed to another.

The plaintext key exists only as a local variable for the duration of the call.
It is never logged — the existing log lines print `interaction.id`, latency and
byte counts, and must stay that way.

### 2.11 A rejected user key is its own error code

`GENERATION_ERROR_CODES` gains **`invalid_api_key`**.

Phase 3 established that a bad key produces `AuthenticationError` with
`status: 401`, which the current classifier folds into the generic 4xx branch and
reports as `invalid_input` → "The AI service rejected the request." That was
right when the key was the operator's problem. Now it is the *user's* key, and
the honest message is "Your Gemini API key was rejected — update it in
Settings."

`classifyGeminiError` must test 401/403 **before** the generic 4xx branch, since
401 would otherwise be caught by it.

### 2.12 S3 keys are unchanged

Keys stay `concepts/{conceptId}/reference.jpg` and `generations/{id}.jpg`,
without a user segment. Ids are v4 UUIDs, the bucket blocks public access, and
every read is a presigned URL generated only after an ownership-checked query.
Adding a user prefix would buy no isolation and would break every existing key
format for no benefit.

### 2.13 Environment variable changes

| Variable | Change |
|---|---|
| `APP_SECRET` | **removed** |
| `GEMINI_API_KEY` | **removed** — every call now uses the caller's key |
| `ENCRYPTION_KEY` | **added**, required, 32 bytes base64 |
| `SIGNUP_CODE` | **added**, optional |

Everything else (`DATABASE_URL`, `DATABASE_SSL`, AWS four, `PORT`, `NODE_ENV`)
is unchanged.

Timing values are **not** environment variables. Per invariant 9 they live in
`shared/src/config.ts`: `SESSION_TTL_DAYS`, `MIN_PASSWORD_LENGTH`,
`MAX_LOGIN_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`, `USERNAME_MIN/MAX_LENGTH`.

---

## 3. Schema — migration `002_identity.sql`

```sql
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  gemini_key_ciphertext BYTEA,
  gemini_key_iv         BYTEA,
  gemini_key_tag        BYTEA,
  gemini_key_hint       TEXT,
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Zach" and "zach" must not be two accounts.
-- Login therefore also looks up by lower(username).
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

CREATE TABLE sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Test data is being discarded (section 1.2). Deleting through stories and
-- concepts lets the existing FK cascades clear frames, frame_concepts and
-- generations. S3 objects are removed beforehand, via the API, in phase 8.
DELETE FROM stories;
DELETE FROM concepts;

ALTER TABLE concepts ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE stories  ADD COLUMN user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX concepts_user_idx ON concepts (user_id, created_at DESC);
CREATE INDEX stories_user_idx  ON stories  (user_id, created_at DESC);
```

The two composite indexes match the exact ordering the list endpoints already
use (`ORDER BY created_at DESC`), so the added `WHERE user_id = $1` does not
turn a sorted index scan into a sort.

`gemini_key_*` columns are nullable: a user exists before a key is validated,
and a key can in principle be cleared. Application code treats a missing key as
"cannot generate" (§4, phase 5).

---

## 4. Phases

Each phase ends in a state where the repo typechecks and the existing test suite
passes. Phases 1–7 are local; phase 8 is production.

---

### Phase 1 — Shared foundations and the migration

**Step 1.1** — `shared/src/config.ts`: add
`SESSION_TTL_DAYS = 30`, `MIN_PASSWORD_LENGTH = 10`,
`USERNAME_MIN_LENGTH = 3`, `USERNAME_MAX_LENGTH = 32`,
`MAX_LOGIN_ATTEMPTS = 10`, `LOGIN_LOCKOUT_MINUTES = 15`.
Each with a comment saying why the number is that number.

**Step 1.2** — `shared/src/types.ts`:
- Add `"invalid_api_key"` to `GENERATION_ERROR_CODES` (§2.11).
- Add `UserDto { id, username, hasGeminiKey, geminiKeyHint, createdAt }`.
  **No key material, no password hash, no lockout state.**
- Add `AuthResponse { token, user: UserDto }`.

**Step 1.3** — `shared/src/schemas.ts`:
```ts
RegisterSchema  = { username, password, geminiApiKey, signupCode? }
LoginSchema     = { username, password }
UpdateMeSchema  = { password?, geminiApiKey? }   // .refine at least one
```
Username: trimmed, 3–32 chars, `^[a-zA-Z0-9_-]+$` — no spaces, no unicode
lookalikes, which keeps case-insensitive uniqueness meaningful.
Password: `MIN_PASSWORD_LENGTH`–200 characters, no composition rules.
Gemini key: non-empty, trimmed, max 200.

**Step 1.4** — `server/migrations/002_identity.sql` exactly as §3.

**Step 1.5** — Apply locally and verify: `users` and `sessions` exist, the
case-insensitive unique index rejects `Zach`/`zach`, `concepts`/`stories` carry
a `NOT NULL user_id` with a cascading FK, and the composite indexes are present.

---

### Phase 2 — Credential services

Three new pure-ish modules, each with no HTTP and no route knowledge.

**Step 2.1** — `server/src/services/password.ts`
```ts
hashPassword(plain: string): Promise<string>          // scrypt$N$r$p$salt$hash
verifyPassword(plain: string, stored: string): Promise<boolean>
```
Parameters and format per §2.2. `verifyPassword` parses parameters out of the
stored string, derives with the same settings, and compares with
`timingSafeEqual`. A malformed stored hash returns `false` rather than throwing —
a corrupt row must not 500 the login endpoint.

**Step 2.2** — `server/src/services/sessionToken.ts`
```ts
generateSessionToken(): string      // 32 random bytes, base64url
hashSessionToken(token: string): string   // sha256 hex
```

**Step 2.3** — `server/src/services/secretBox.ts`
```ts
encryptSecret(plain: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer }
decryptSecret(parts): string
keyHint(plain: string): string     // last 4 characters
```
AES-256-GCM with the key from `env.ENCRYPTION_KEY` (§2.4). Decryption failure
throws a typed `AppError(500, "decryption_failed", …)` — it means the
`ENCRYPTION_KEY` changed, which is an operator problem, not a user one.

**Step 2.4** — `server/src/config/env.ts`: remove `APP_SECRET` and
`GEMINI_API_KEY`; add `ENCRYPTION_KEY` (required, must base64-decode to exactly
32 bytes — validate the length, not just the presence) and `SIGNUP_CODE`
(optional).

**Step 2.5** — Tests: `server/test/credentials.test.ts` (see §6).

---

### Phase 3 — Auth routes and the middleware swap

**Step 3.1** — `server/src/db/users.ts`
`insertUser`, `findByUsernameLower`, `findById`, `updatePassword`,
`updateGeminiKey`, `recordFailedAttempt`, `resetFailedAttempts`.

**Step 3.2** — `server/src/db/sessions.ts`
`insertSession`, `findValidSessionByTokenHash` (joins `users`, checks
`expires_at > now()`), `deleteSession`, `deleteSessionsForUser`,
`deleteExpiredSessions`.

**Step 3.3** — `server/src/services/auth.ts`
- `register` — enforce `SIGNUP_CODE` when set; reject a taken username with
  `409 username_taken`; **validate the Gemini key before creating the row**;
  hash the password; insert user; create session. All inside one transaction so
  a failed key validation leaves no half-made account.
- `login` — look up by `lower(username)`; if locked, fail generically; verify;
  on failure increment attempts and possibly lock; on success reset counters,
  delete expired sessions for that user, create a new one.
- `logout` — delete the current session row.
- `updateMe` — change password (which **revokes all other sessions**, keeping
  the current one) and/or replace the Gemini key (validated first).

**Step 3.4** — `server/src/middleware/auth.ts` — replace `createRequireAuth`
entirely. The new `requireAuth`:
reads the bearer token → hashes it → looks up a valid session → attaches
`req.user` → `401 unauthorized` on any miss. Delete the shared-secret path;
`env.APP_SECRET` no longer exists.

Typing: augment Express's `Request` with `user?: AuthUser` in a
`server/src/types/express.d.ts`, so handlers read `req.user` under strict mode
without casts. A small helper `requireUser(req)` returns the user or throws,
keeping `req.user!` out of every handler.

**Step 3.5** — `server/src/routes/auth.ts`
| Method | Path | Auth |
|---|---|---|
| `POST` | `/auth/register` | public |
| `POST` | `/auth/login` | public |
| `POST` | `/auth/logout` | required |
| `GET` | `/auth/me` | required |
| `PATCH` | `/auth/me` | required |

**Step 3.6** — `server/src/app.ts` — mount the auth router **before**
`requireAuth`, alongside the health route, so register and login are reachable
unauthenticated. Everything else stays behind the middleware.

---

### Phase 4 — Scope every data path to the owner

The highest-risk phase: a single missing `WHERE user_id` silently exposes one
account's work to another, with no error anywhere.

**Step 4.1** — `db/concepts.ts` — every function takes `userId`.
`listConcepts(userId)`, `getConceptById(id, userId)`, `insertConcept(userId, …)`,
`updateConcept(id, userId, …)`, `deleteConcept(id, userId)`,
`setConceptImage(id, userId, …)`.

**Step 4.2** — `db/stories.ts` — same treatment, including the cover-thumbnail
lateral join, whose outer query gains `WHERE s.user_id = $1`.

**Step 4.3** — `db/frames.ts` — every query joins `stories` and filters on
`s.user_id` (§2.5): `listFramesByStory`, `getFrameById`, `listFrameConcepts`,
`listFrameGenerations`, `maxPositionInStory`, `insertFrame`,
`updateFrameFields`, `deleteFrame`.
`findExistingConceptIds` gains `AND user_id = $2` so cross-user attachment fails.

**Step 4.4** — `db/generations.ts` — `getGenerationById`, `hasPendingForFrame`,
`imageKeysForFrame`, `imageKeysForStory`, `setSelectedGeneration` all scope via
the frame → story → user chain. `markSucceeded`, `markFailed` and `sweepStale`
stay unscoped: they act on a generation the server itself created and are never
reachable from a request.

**Step 4.5** — Services thread `userId` from `req.user` through to the db layer.
No service invents an owner; it is always the authenticated caller.

**Step 4.6** — Routes pass `requireUser(req).id` into every service call.

**Step 4.7** — Verification: the ownership matrix in §6.2. Do not skip it.

---

### Phase 5 — Per-user Gemini key through the pipeline

**Step 5.1** — `services/gemini.ts` — delete the module-scope client. Both
`describeImage` and `generateImage` take `apiKey` and construct
`new GoogleGenAI({ apiKey })` inside the call (§2.10). Add
`validateApiKey(apiKey): Promise<boolean>` — one minimal `gemini-3.7-flash`
call — used by registration and by key updates.

**Step 5.2** — `services/geminiErrors.ts` — classify `401`/`403` as
`invalid_api_key` **before** the generic 4xx branch, with a message pointing at
Settings (§2.11).

**Step 5.3** — `services/concepts.ts` `describeConcept` — load the caller's key,
decrypt, pass it down. If the user has no key stored, fail with
`422 no_api_key` and a message telling them to add one in Settings, rather than
letting an empty string reach Google.

**Step 5.4** — `services/generation.ts` — same, with one ordering requirement:
**resolve and decrypt the key before inserting the `pending` row.** A user with
no key must be rejected outright, not left with a `pending` generation that
immediately fails. This mirrors the existing rule that validation runs before
any billed work.

The decrypted key is passed into the background task as an argument; it is never
written to `input_snapshot`, never logged, and never returned in an error.

---

### Phase 6 — Client

**Step 6.1** — `client/src/api.ts` — rename the storage key to
`storyboards.session`; add `register`, `login`, `logout`, `getMe`, `updateMe`.
The existing central `401` handler already clears storage and bounces to
`/login`, which now correctly covers an expired or revoked session.

**Step 6.2** — `client/src/auth.tsx` — the context holds `{ token, user }`
rather than a bare secret. On mount with a stored token, call `GET /auth/me` to
rehydrate the user (and detect a dead session immediately). `RequireAuth` waits
for that check rather than flashing the app shell.

**Step 6.3** — `client/src/routes/Login.tsx` — username and password fields, a
generic error on failure, and a link to `/register`.

**Step 6.4** — `client/src/routes/Register.tsx` (new) — username, password,
confirm password, Gemini API key, and `signupCode` **only when the server says
it is required** (a `403 signup_code_required` response reveals it; simplest is
to always show an optional field labelled "Invite code, if you were given one").
Include a short line on where to get a Gemini key, linking to
`https://aistudio.google.com/apikey`. Client-side length checks mirror the zod
rules so the obvious mistakes never reach the server.

**Step 6.5** — `client/src/routes/Settings.tsx` (new) — shows the username, the
Gemini key state (`•••• 1a2b` or "not set"), a form to replace the key, a form
to change the password, and Sign out. Replacing a key shows the server's
validation failure inline, so a bad key is caught here.

**Step 6.6** — `client/src/components/Layout.tsx` — the two tabs stay; add the
username and a Settings link on the right.

**Step 6.7** — `client/src/main.tsx` — add `/register` and `/settings` routes.
`/register` is public, `/settings` is behind `RequireAuth`.

---

### Phase 7 — Documentation: withdraw the prohibitions

Not optional bookkeeping. Both documents currently forbid what the code now
does.

**Step 7.1** — `CLAUDE.md`
- **Delete** "Do not add multi-user support, a users table, or `user_id`
  columns. Auth is one shared secret."
- Replace the auth bullet with the new rule: *"Auth is username/password with
  opaque session tokens. Never compare secrets with `===`; use
  `crypto.timingSafeEqual`."*
- Add invariants: **10.** every query touching user data filters by the
  authenticated user; **11.** Gemini calls use the caller's key, never a
  server-wide one; **12.** a user's API key is encrypted at rest and never
  returned by any endpoint.
- Update the "What this is" opening — it says "single-user".
- Update the Testing section with the new sanctioned area (§6.1).

**Step 7.2** — `TECH_SPEC.md`
- §3: move multi-user accounts from "out of scope" to in scope.
- §5: add `users` and `sessions`, and the `user_id` columns.
- §10: rewrite from shared secret to accounts and sessions; remove the "known
  debt" paragraph, which this work discharges.
- §11: update the configuration table for the variable changes in §2.13.
- §8.6: add `invalid_api_key` to the error taxonomy.

**Step 7.3** — `.env.example` — drop `APP_SECRET` and `GEMINI_API_KEY`; add
`ENCRYPTION_KEY` and a commented `SIGNUP_CODE`, with a note that each user now
supplies their own Gemini key through the UI.

---

### Phase 8 — Deployment

Order matters: S3 objects must be deleted **before** the migration drops the rows
that name them.

**Step 8.1 — Wipe production data through the API, while the old auth still
works.** Using the current `APP_SECRET`, `DELETE` every story and then every
concept. This removes generated frames and reference images from S3 along the
way, because those delete paths already do so (phases 2 and 6). Confirm the
bucket is empty afterwards; anything left is an orphan to remove by hand.

**Step 8.2 — Generate `ENCRYPTION_KEY`** with `openssl rand -base64 32` and set
it on the Railway `api` service via `railway variable set ENCRYPTION_KEY --stdin`
so it never enters scrollback. Optionally set `SIGNUP_CODE` for the cutover.

**Step 8.3 — Remove the retired variables** from Railway: `APP_SECRET` and
`GEMINI_API_KEY`. Do this **after** step 8.1, since the wipe authenticates with
`APP_SECRET`.

**Step 8.4 — Deploy the API**: `railway up --service api --ci`. The
`preDeployCommand` applies `002_identity.sql`. Watch for the migration line and a
passing health check.

**Step 8.5 — Deploy the client**: `vercel deploy --prod --yes`. No new
environment variable is needed — `VITE_API_BASE_URL` is unchanged.

**Step 8.6 — Register the first account** through the deployed UI, with a real
Gemini API key. This is also the first end-to-end test of registration and key
validation.

**Step 8.7 — Verify in production** per §6.3.

**Step 8.8 — Unset `SIGNUP_CODE`** if you set it and want open registration.

---

## 5. Rollback

The migration is destructive (it drops the test data and adds `NOT NULL`
columns), so rollback is not a `DOWN` migration.

- **Before step 8.4** — nothing has changed on the server; redeploying the
  previous commit is a complete rollback.
- **After step 8.4** — the safe path forward is fixing forward. A true revert
  would need `ALTER TABLE … DROP COLUMN user_id`, dropping `users` and
  `sessions`, and restoring `APP_SECRET` and `GEMINI_API_KEY`. Write that
  three-statement `003_rollback.sql` **before** deploying, keep it unapplied,
  and delete it once production is confirmed healthy.

Since the data being destroyed is disposable test data, the practical blast
radius of a bad deploy is "register again", not "lost work".

---

## 6. Testing and verification

### 6.1 One new committed test area

`CLAUDE.md` sanctions three areas, plus the meta-prompt fidelity area added in
phase 3 of the original build. This adds a fifth:

**Credential handling** — `server/test/credentials.test.ts`:

| Case | Assertion |
|---|---|
| Hash then verify | round-trips true |
| Wrong password | false |
| Two hashes of the same password | differ (salt is random) |
| Malformed stored hash | returns false, does not throw |
| Session token | 43 chars, base64url, distinct across calls |
| Token hashing | deterministic, and the hash is not the token |
| Gemini key encrypt/decrypt | round-trips exactly |
| Two encryptions of the same key | differ (fresh IV) |
| Tampered ciphertext | throws, never returns plaintext |
| `keyHint` | last 4 characters only, never more |

These are pure functions with no I/O, and they are the kind of thing that fails
**silently and catastrophically** — a broken verify that returns `true`, or an
encrypt that round-trips the wrong value, would not surface as an error. That is
the same standard the existing sanctioned areas were chosen by.

Then **mutation-check the suite**: make `verifyPassword` return `true`
unconditionally, and make `encryptSecret` reuse a fixed IV. Both must fail. A
credential test that cannot detect those is worthless.

### 6.2 Ownership isolation — scripted verification, not committed tests

Proving isolation needs a live database and two accounts, which puts it outside
the unit-test policy. It runs as a scripted matrix during phase 4, the same way
earlier phases verified database behaviour.

Register **user A** and **user B**. A creates a concept, a story, a frame, and
attaches the concept. Then, as B, assert **every** one of these returns `404` or
`422` and **never** A's data:

| Attempt as B | Expected |
|---|---|
| `GET /concepts` | does not include A's concept |
| `GET /concepts/:aId` | `404` |
| `PATCH /concepts/:aId` | `404` |
| `DELETE /concepts/:aId` | `404` |
| `POST /concepts/:aId/image` | `404` |
| `POST /concepts/:aId/describe` | `404` |
| `GET /stories` | does not include A's story |
| `GET /stories/:aId` | `404` |
| `GET /stories/:aId/frames` | `404` |
| `POST /stories/:aId/frames` | `404` |
| `GET /frames/:aId` | `404` |
| `PATCH /frames/:aId` | `404` |
| `DELETE /frames/:aId` | `404` |
| `POST /frames/:aId/generate` | `404` |
| `GET /generations/:aId` | `404` |
| `PATCH` B's own frame attaching **A's** concept id | `422 unknown_concept` |
| `POST /frames/:bId/select-generation` with A's generation | `404` or `422` |

Then confirm the converse: A still sees everything of A's. An isolation bug that
also breaks the owner's access would otherwise look like a pass.

### 6.3 Production verification

1. `GET /api/health` → `200 {"ok":true,"db":"up"}`.
2. The old `APP_SECRET` as a bearer token → `401`. The shared secret is dead.
3. Register through the UI; confirm a bad Gemini key is **rejected at
   registration** with a clear message.
4. Sign in, sign out, sign in again. Confirm sign-out invalidates the old token
   (replay it with `curl` → `401`).
5. Full loop on the new account: concept → upload → describe → story → frame →
   generate. **This proves the user's own key is paying for the calls**, since
   the server no longer has one.
6. Change the password in Settings; confirm other sessions are revoked and the
   current one survives.
7. Register a second account and re-run a spot-check of §6.2 against production.
8. Confirm `GET /auth/me` returns **no key material** — only `hasGeminiKey` and
   the 4-character hint.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| A missing `WHERE user_id` silently leaks data | Ownership matrix over every endpoint (§6.2); `404` not `403` (§2.6) |
| Cross-user concept attachment leaking a description into a prompt | `findExistingConceptIds` scoped by user (§4, step 4.3) |
| A user's API key stored or logged in plaintext | AES-256-GCM at rest; decrypted only at the call site; never in `input_snapshot`, logs, or responses (§2.4, §2.10) |
| `ENCRYPTION_KEY` lost or changed | Documented as unrecoverable; users re-enter keys; generated once and treated as a real secret (§2.4) |
| Password brute force over the public internet | Per-account lockout (§2.3) |
| Username enumeration | Generic login failure (§2.7) |
| Session token stolen from a database dump | Tokens stored as `sha256` (§2.1) |
| A stale session outliving a password change | Password change revokes all other sessions (§3, step 3.3) |
| App becomes publicly registerable | Stated plainly; optional `SIGNUP_CODE` (§2.8) |
| A user with no key getting a `pending` generation that always fails | Key resolved before the `pending` row is inserted (§5, step 5.4) |
| Stale docs forbidding the new architecture | Phase 7 rewrites `CLAUDE.md` and `TECH_SPEC.md` (§1.1) |
| S3 orphans from the wipe | Delete through the API, which already cleans S3, before the migration (§8, step 8.1) |

---

## 8. Explicitly out of scope

| Item | Why |
|---|---|
| Email addresses, verification, password reset | No mail provider; a forgotten password is a manual database fix at this size |
| OAuth / social login | Username and password is what was asked for |
| Roles, permissions, sharing, teams | Every user sees exactly their own data; nothing more was requested |
| Account deletion in the UI | The `ON DELETE CASCADE` exists; no endpoint until asked |
| Per-user quotas or spend controls | `CLAUDE.md` keeps these out of scope, and each user now pays for their own calls |
| Migrating existing production data to an owner | It is disposable test data and is being wiped (§1.2) |
| Refresh tokens / sliding expiry | A 30-day absolute session is enough; re-login is cheap |
| Rate limiting beyond login lockout | No general request throttling until there is a reason |

---

## 9. Verified while planning

Claims that would fail only at runtime, checked before being written down.

**`scrypt` parameters fit under Node's default memory guard.** `N=16384, r=8`
needs `128 · N · r` = **16 MB**, against a 32 MB default `maxmem` — so no
`maxmem` override is required and the call cannot fail on the guard. Deriving a
64-byte key took **24 ms**, which is the per-login cost: slow enough to matter
against offline cracking, fast enough to be invisible in a login request.

**The stored-hash format round-trips.** Parsing `scrypt$N$r$p$salt$hash`,
re-deriving with the parsed parameters, and comparing with `timingSafeEqual`
returns `true` for the right password and `false` for the wrong one.

**AES-256-GCM behaves as §2.4 assumes.** Encrypt/decrypt round-trips a
Gemini-shaped key exactly, and flipping a single bit of ciphertext makes
decryption **throw** rather than return garbage — the auth tag is doing its job.

**A session token is 43 characters** of base64url from 32 random bytes.

**A `lower(username)` unique index rejects case variants.** Inserting `Zach`
then `zach` fails with a duplicate-key error, so §3's index genuinely prevents
two accounts differing only in case.

**The migration's statement order is required, not stylistic.** `ALTER TABLE …
ADD COLUMN user_id UUID NOT NULL` against a table with rows fails with
`column "user_id" of relation … contains null values`. The `DELETE FROM stories`
and `DELETE FROM concepts` statements in §3 must therefore come **before** the
`ALTER` statements — which is the order given, but it is worth knowing the
migration would abort rather than silently produce a nullable column if they
were reordered.

---

## 10. Execution notes

Written after the plan shipped. Records where execution diverged from §4 and
what the verification actually found, so the plan is not read later as though it
had predicted everything correctly.

### Divergences from the plan

**`server/test/auth.test.ts` was deleted, not updated.** It exercised
`createRequireAuth`, the shared-secret factory that §1 removes outright. There
was nothing in it to carry forward. `credentials.test.ts` (24 tests) replaces it
as the fifth sanctioned test area.

**Ownership isolation was verified against a live database, not by unit tests.**
§6 called for this and it was the right call: the failure mode is a missing
`WHERE user_id`, which no unit test over a mocked layer would catch. The matrix
ran 16 checks from a second account against every resource of the first — all
`404` or `422 unknown_concept`, never `403` — plus the converse, confirming the
first account had not lost access to its own work. It was re-run against
production after deployment.

**Frames and generations are scoped transitively.** §3 puts `user_id` on
`concepts` and `stories` only. Ownership of a frame is therefore
frame → story → user, and every frame and generation query carries that join.
This is load-bearing and easy to drop; it is now invariant 10 in `CLAUDE.md`.

### Found after deployment

**Login leaked which usernames exist, via timing.** Not anticipated anywhere in
this plan. An unknown username returned as soon as the user lookup missed, while
a known username with a wrong password paid the 24 ms scrypt derivation measured
in §9. The generic error message hid *which* check failed; the clock did not.

Measured against production over the public internet, n=24 interleaved, before
the fix: unknown usernames answered **35.9 ms faster at the minimum**, 34.9 ms
at p25, 38.0 ms at the median. Agreement across all three estimators is what
distinguishes a real signal from network jitter — a first attempt at n=4 gave a
*negative* median gap, because jitter over the public internet is far larger
than the effect being measured.

Fixed in `9d1df37` by verifying against a throwaway hash derived once at
startup, using the same scrypt parameters so the work matches rather than
merely approximating a delay. After: **+9.1 ms min, +5.9 ms p25, +2.1 ms
median** — inside the noise band, and no longer consistent across estimators.

A residual remains: the known-username path also writes a failed-attempt row
that the unknown path does not. That is a far smaller channel than a full key
derivation, and it is not currently distinguishable from noise, but it is the
next thing to look at if this is ever revisited.

**Lesson for §9-style spikes.** §9 measured that scrypt costs 24 ms and treated
that as a cost question. It is also a *timing-channel* question, and the plan
did not ask whether that cost was observable from outside. Any per-user branch
whose two sides do measurably different amounts of work is a side channel,
whether or not the error messages agree.
