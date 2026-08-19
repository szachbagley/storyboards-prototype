# Phase 1 Plan — Schema, Migrations, Config Module, Auth Middleware

**Status:** ready to execute
**Corresponds to:** `TECH_SPEC.md` §13 build order, item 1
**Written:** 2026-08-18

---

## 1. Goal and exit criteria

Phase 1 delivers the foundation every later phase sits on: a working monorepo, a
migrated database matching `TECH_SPEC.md` §5, the single shared constants module
required by invariant 9, and the shared-secret auth middleware from §10.

**Phase 1 is done when all of the following are true:**

1. `npm install` at the repo root succeeds and links three workspaces.
2. `npm run typecheck` passes with zero errors under TypeScript strict mode.
3. `npm run migrate --workspace=server` applies `001_init.sql` against a local
   Postgres and is a no-op on a second run.
4. `npm run dev` starts the API and the client shell concurrently.
5. `GET /api/health` returns `200 {"ok":true,"db":"up"}` without a token.
6. `GET /api/ping` returns `401` with no token, `401` with a wrong token, and
   `200` with `Authorization: Bearer $APP_SECRET`.
7. `npm test` runs and the auth middleware unit tests pass.
8. The client shell renders the health-check result fetched from the API,
   proving CORS and `VITE_API_BASE_URL` wiring.

**Not in phase 1:** any concept/story/frame/generation route, S3, `sharp`,
Gemini, the prompt compiler, the stale sweep, and all real client views.
Those land in phases 2–7. Explicit deferral list in §9.

---

## 2. Decisions

Each decision below is a thing that would otherwise get re-litigated mid-build.
Rationale included where the choice is not obvious.

### 2.1 Tooling

| Decision | Choice | Rationale |
|---|---|---|
| Package manager | npm workspaces | `CLAUDE.md` commands already use `--workspace=`. No new tool. |
| Node version | `>=22`, `.nvmrc` = `22` | Local machine is on 23.7.0, which satisfies it. Railway pins from `engines`. |
| Module system | ESM everywhere (`"type": "module"`) | `@google/genai` and the modern ecosystem are ESM-first. |
| TS module resolution | `NodeNext` for `shared` + `server`, `Bundler` for `client` | NodeNext means relative imports carry a `.js` extension. Ugly but zero runtime surprise. |
| Server dev runner | `tsx watch` | No bundler needed for a Node API. |
| Server build | `tsc --build` → `dist/`, run with `node dist/index.js` | Boring and debuggable on Railway. |
| HTTP framework | **Express 5** | Stable, minimal, and — unlike Express 4 — it forwards rejected async handlers to the error middleware, which removes a whole class of hand-rolled `asyncHandler` wrappers. |
| Validation | `zod` (in `shared/`) | Required by `CLAUDE.md`; client reuses the same schemas. |
| DB driver | `pg` with parameterized queries | No ORM, per `CLAUDE.md`. |
| Test runner | `vitest` | Fast, TS-native, no config to speak of. |
| Concurrency for `npm run dev` | `concurrently` | Root script fans out to three workspaces. |

### 2.2 How `shared/` is consumed

`shared` is a real workspace package named `@storyboards/shared` that **compiles
to `shared/dist`**, with `exports`/`types` pointing at the built output.

- `server` resolves it through the npm workspace symlink → `dist`.
- `client` (Vite) resolves it the same way.
- Typechecking uses **TypeScript project references** (`composite: true`), so
  `tsc --build` figures out ordering on its own.
- The root `predev` script builds `shared` once before the watchers start, so
  the first `npm run dev` cannot race on a missing `dist`.

Rejected alternative: pointing `exports` at `src/*.ts`. Vite would cope, but
`tsx` does not transpile TypeScript found inside `node_modules`, so the server
would break at runtime. Not worth the trap.

### 2.3 Config module (invariant 9)

All application constants live in **`shared/src/config.ts`**. They are code, not
environment variables (§11). Environment variables are a separate concern and
live in `server/src/config/env.ts`.

Two constants deserve explanation because they resolve open questions raised
during spec review:

**`GENERATION_DEADLINE_MS = 90_000`** — this is a *total* budget for one
generation attempt including any `rate_limited` retries, not a per-HTTP-call
timeout. A single `AbortController` created when the background task starts
governs the whole thing. This matters: with a per-call timeout, the worst case
(90s + backoff + 90s + backoff + 90s) is ~4m40s, which brushes up against the
5-minute stale sweep in §7.1 and would cause a still-running generation to be
falsely marked `abandoned`. A total budget caps wall-clock at ~90s and makes
`timeout` and `abandoned` mean genuinely different things.

**`CLIENT_POLL_CEILING_MS = 105_000`** — deliberately *longer* than the server
deadline. §12.3 says 90s, but if the client gives up at exactly the moment the
server does, the user sees a generic client-side timeout instead of the server's
classified error from the §8.6 taxonomy. 15s of slack means the client almost
always renders the real, actionable error. Recorded here as an intentional
deviation from the spec's number, not an oversight.

Full contents in §5.2.

### 2.4 Database conventions

- **Postgres 16+.** `gen_random_uuid()` is built in since PG13; no `pgcrypto`
  extension line is needed. Do not add one.
- **`updated_at` is set explicitly** in each `UPDATE` statement
  (`SET ..., updated_at = now()`), not by a trigger. Triggers are unspecified DB
  machinery and this project has one writer. The cost is remembering the clause;
  the db layer is small enough that this is fine.
- **snake_case in the database, camelCase in the API.** The mapping happens in
  the SQL itself via quoted aliases — `SELECT image_key AS "imageKey"` — so no
  transformation layer exists and row objects are already DTO-shaped. Decide
  this now; retrofitting it later touches every query.
- **`generations.error_code` stays `TEXT`**, per §5. The permitted values are
  constrained by the `GenerationErrorCode` union in `shared/`, not by a DB enum.
  Error taxonomies churn; migrating an enum for that is friction with no payoff.
- **No `CHECK` constraints for content rules** (non-empty title, etc.). Those are
  boundary validations and belong to zod.
- **Migrations never auto-run at boot.** They run as an explicit command. The
  Railway start command chains them (§7.3).

### 2.5 Auth (§10)

- Header: `Authorization: Bearer <APP_SECRET>`.
- Comparison: **SHA-256 both sides, then `crypto.timingSafeEqual` on the two
  32-byte digests.** `timingSafeEqual` throws on length mismatch, so comparing
  raw secrets requires a length check that itself leaks the secret's length.
  Hashing to a fixed width sidesteps both problems and satisfies `CLAUDE.md`'s
  "equal-length buffers" requirement by construction.
- Applied to every `/api/*` route **except** `/api/health`.
- Failure → `401 { "error": { "code": "unauthorized", "message": "..." } }`.
- The secret is read once at boot and its digest cached at module scope.

### 2.6 CORS

The client is on Vercel and the API on Railway, so CORS is mandatory from day
one. Use the `cors` package with default (permissive) origin.

This is safe here specifically because authentication is a bearer token in a
header and **not** a cookie — a hostile origin cannot make an authenticated
request on the user's behalf, because the browser will not attach the token for
it. Add a one-line comment in the code saying so, otherwise it reads as
carelessness.

### 2.7 Error handling

- `AppError extends Error` carrying `status: number` and `code: string`.
- One terminal error middleware serializes everything to
  `{ error: { code, message, details? } }`.
- `ZodError` → `400` with `code: "invalid_input"` and a `details` array of
  `{ path, message }`.
- Unknown throws → `500` with `code: "internal_error"` and a generic message;
  the real error is logged server-side and never sent to the client.

Note the deliberate overlap: `invalid_input` is also a *generation* `error_code`
in §8.6. Same word, two contexts (HTTP response vs. persisted generation row).
That is fine and intentional — do not invent a second name for it.

---

## 3. Repository layout after phase 1

```
storyboards-prototype/
├── package.json                 # workspaces + root scripts
├── tsconfig.base.json           # compiler options shared by all workspaces
├── tsconfig.json                # solution file: references shared + server
├── vitest.config.ts
├── .gitignore
├── .nvmrc
├── .env.example
├── CLAUDE.md  TECH_SPEC.md  phase-1-plan.md  Storyboards.{pdf,png}
│
├── shared/
│   ├── package.json             # @storyboards/shared, exports ./dist
│   ├── tsconfig.json            # composite
│   └── src/
│       ├── index.ts             # re-exports config + types
│       ├── config.ts            # INVARIANT 9 lives here
│       └── types.ts             # domain unions + DTO shapes
│
├── server/
│   ├── package.json
│   ├── tsconfig.json            # composite, references ../shared
│   ├── .env                     # gitignored
│   ├── migrations/
│   │   └── 001_init.sql
│   ├── src/
│   │   ├── index.ts             # bootstrap + graceful shutdown
│   │   ├── app.ts               # express assembly
│   │   ├── config/env.ts        # zod-validated process.env
│   │   ├── db/
│   │   │   ├── pool.ts
│   │   │   └── migrate.ts       # runner + CLI entry
│   │   ├── lib/AppError.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── errorHandler.ts
│   │   │   └── requestLogger.ts
│   │   └── routes/health.ts
│   └── test/
│       └── auth.test.ts
│
└── client/
    ├── package.json
    ├── tsconfig.json            # Bundler resolution, noEmit
    ├── vite.config.ts
    ├── index.html
    ├── .env.local               # gitignored
    └── src/
        ├── main.tsx
        └── App.tsx              # scaffold only: pings /api/health
```

The `client/` tree in phase 1 is **scaffold, not feature work**. It exists so
`npm run dev` runs both halves as `CLAUDE.md` documents, and so CORS gets
verified against a real browser now rather than in phase 7. Login, routing, and
all real views stay in phase 7.

---

## 4. Step-by-step execution

### Step 0 — initialize git *(optional, recommended)*

`git init` and commit the existing docs before generating files, so the phase-1
diff is reviewable. The repo is currently not under version control.

### Step 1 — root scaffolding

**`package.json`**

```jsonc
{
  "name": "storyboards-prototype",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "server", "client"],
  "engines": { "node": ">=22" },
  "scripts": {
    "predev": "npm run build --workspace=shared",
    "dev": "concurrently -n shared,server,client -c gray,blue,magenta \"npm:dev:shared\" \"npm:dev:server\" \"npm:dev:client\"",
    "dev:shared": "npm run dev --workspace=shared",
    "dev:server": "npm run dev --workspace=server",
    "dev:client": "npm run dev --workspace=client",
    "build": "tsc --build && npm run build --workspace=client",
    "typecheck": "tsc --build && tsc --noEmit -p client",
    "test": "vitest run",
    "migrate": "npm run migrate --workspace=server"
  },
  "devDependencies": {
    "concurrently": "^9",
    "typescript": "^5.7",
    "vitest": "^3"
  }
}
```

Install the latest published version of each dependency rather than pinning to
these exact majors if npm offers newer — but do not downgrade.

**`tsconfig.base.json`**

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

`noUncheckedIndexedAccess` is on deliberately. The prompt compiler in phase 5
indexes into parallel arrays of text lines and image parts, and invariant 5 says
a desync there is the highest-severity failure in the system. Making the
compiler prove its indexing is worth the friction everywhere else.

`verbatimModuleSyntax` means type-only imports must be written
`import type { X } from "..."`.

**`tsconfig.json`** (solution file, no files of its own)

```jsonc
{ "files": [], "references": [{ "path": "./shared" }, { "path": "./server" }] }
```

`client` is intentionally outside the reference graph — it is `noEmit` and Vite
owns its build, so it is typechecked separately.

**`.gitignore`**

```
node_modules/
dist/
*.tsbuildinfo
.env
.env.local
.DS_Store
```

**`.nvmrc`** → `22`

**`.env.example`** — documents every variable from §11 with phase annotations:

```sh
# --- required from phase 1 ---
DATABASE_URL=postgres://postgres:postgres@localhost:5432/storyboards
DATABASE_SSL=false          # true for Railway's external connection string
APP_SECRET=dev-secret-change-me
PORT=3001

# --- required from phase 2 (S3) ---
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
S3_BUCKET=

# --- required from phase 3 (Gemini) ---
GEMINI_API_KEY=

# --- client (client/.env.local) ---
VITE_API_BASE_URL=http://localhost:3001
```

**`vitest.config.ts`** — `include: ["server/test/**/*.test.ts", "shared/test/**/*.test.ts"]`.

### Step 2 — `shared/` package

**`shared/package.json`**

```jsonc
{
  "name": "@storyboards/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc --build",
    "dev": "tsc --build --watch --preserveWatchOutput"
  },
  "dependencies": { "zod": "^4" }
}
```

**`shared/tsconfig.json`** — extends the base, `rootDir: "src"`, `outDir: "dist"`,
`include: ["src"]`.

**`shared/src/config.ts`** — the invariant-9 module:

```ts
// Application constants. These are code, not deployment configuration —
// see TECH_SPEC.md §11. Nothing here belongs in an environment variable.

// --- Gemini models (see the gemini-nano-banana skill; these are current as of
// August 2026 and pre-2026 training data has them wrong) ---
export const IMAGE_MODEL = "gemini-3.1-flash-image" as const;
export const DESCRIPTION_MODEL = "gemini-3.7-flash" as const;

// gemini-3.7-flash accepts only low | medium | high — "minimal" is rejected.
export const DESCRIPTION_THINKING_LEVEL = "low" as const;

// --- Image output (TECH_SPEC.md §8.5) ---
export const ASPECT_RATIO = "16:9" as const;
// Case-sensitive. "1k" is rejected outright by the API.
export const IMAGE_SIZE = "1K" as const;
export const IMAGE_MIME_TYPE = "image/jpeg" as const;

// --- Reference image budget (TECH_SPEC.md §8.3) ---
export const MAX_CHARACTER_CONCEPTS = 4;
export const MAX_TOTAL_CONCEPTS = 10;

// --- Generation timing ---
// Total wall-clock budget for one generation task, retries included. Kept well
// under STALE_GENERATION_AGE_MS so a live task is never swept as abandoned.
export const GENERATION_DEADLINE_MS = 90_000;
export const RATE_LIMIT_MAX_RETRIES = 2;
export const RATE_LIMIT_BACKOFF_MS = [2_000, 8_000] as const;
export const POLL_INTERVAL_MS = 2_000;
// Longer than the server deadline on purpose, so the client renders the
// server's classified error instead of its own generic timeout.
export const CLIENT_POLL_CEILING_MS = 105_000;

// --- Stale generation sweep (TECH_SPEC.md §7.1) ---
export const STALE_GENERATION_AGE_MS = 5 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;

// --- Frame ordering (TECH_SPEC.md §5.2) ---
export const POSITION_GAP = 1000;

// --- Uploads and storage (TECH_SPEC.md §9) ---
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const REFERENCE_IMAGE_MAX_EDGE = 1024;
export const REFERENCE_IMAGE_JPEG_QUALITY = 85;
export const PRESIGNED_URL_TTL_SECONDS = 3600;
```

**`shared/src/types.ts`** — domain unions plus the taxonomy:

```ts
export const CONCEPT_TYPES = ["character", "setting", "prop"] as const;
export type ConceptType = (typeof CONCEPT_TYPES)[number];

export const GENERATION_STATUSES = ["pending", "succeeded", "failed"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

// TECH_SPEC.md §8.6. Persisted in generations.error_code as TEXT.
export const GENERATION_ERROR_CODES = [
  "safety_blocked",
  "rate_limited",
  "timeout",
  "invalid_input",
  "upstream_error",
  "abandoned",
] as const;
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
```

**`shared/src/index.ts`** — `export * from "./config.js"; export * from "./types.js";`

Deliberately absent: per-entity zod request schemas. They arrive alongside the
routes that use them (phases 2 and 4). Writing them now is scaffolding ahead of
need, which `CLAUDE.md` asks us not to do. The `zod` dependency is declared now
because `shared` is where they will live.

### Step 3 — migration `001_init.sql`

Create `server/migrations/001_init.sql` containing **exactly** the DDL from
`TECH_SPEC.md` §5, in this order: the two enum types, `concepts`, `stories`,
`frames` + its index, `frame_concepts` + its unique index, `generations` + its
two indexes, then the deferred `ALTER TABLE frames ADD CONSTRAINT
frames_selected_generation_fk`.

Points to get right:

- The `frames.selected_generation_id` foreign key **must** come last. `frames`
  is created before `generations`, so the constraint cannot be inline. This is
  a circular reference resolved by ordering, not an oversight in the spec.
- `generations_pending_idx` is a **partial** index
  (`WHERE status = 'pending'`). It serves both the §7.1 sweep and the §7.2
  409-on-duplicate check. Do not drop the `WHERE` clause.
- `frames.position` is `DOUBLE PRECISION`, not `INTEGER`. §5.2 depends on
  midpoint insertion.
- No `schema_migrations` table here — the runner owns that (Step 4).
- The file is applied inside a transaction by the runner, so it needs no
  `BEGIN`/`COMMIT` of its own.

Add a header comment naming the spec section, and inline comments only where the
schema is non-obvious (the deferred FK, the partial index, why position is a
float). No comments that restate the DDL.

### Step 4 — `server/` package and database plumbing

**`server/package.json`**

```jsonc
{
  "name": "@storyboards/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc --build",
    "start": "node dist/index.js",
    "migrate": "tsx src/db/migrate.ts",
    "migrate:prod": "node dist/db/migrate.js"
  },
  "dependencies": {
    "@storyboards/shared": "*",
    "cors": "^2",
    "dotenv": "^17",
    "express": "^5",
    "pg": "^8",
    "zod": "^4"
  },
  "devDependencies": {
    "@types/cors": "^2",
    "@types/express": "^5",
    "@types/node": "^22",
    "@types/pg": "^8",
    "tsx": "^4"
  }
}
```

**`server/tsconfig.json`** — extends base, `rootDir: "src"`, `outDir: "dist"`,
`include: ["src"]`, `references: [{ "path": "../shared" }]`.

**`server/src/config/env.ts`**

Load `dotenv` (from `server/.env`) then validate with zod. Fail fast at boot,
printing every missing variable at once rather than the first one.

```ts
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  APP_SECRET: z.string().min(8),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});
```

Phase-gating: only variables the current phase actually uses are required. S3
variables become required in phase 2 and `GEMINI_API_KEY` in phase 3 — add them
to this schema *then*, so a phase-1 developer can boot without AWS credentials.
Leave a comment in the file marking where they go.

Export a frozen `env` object. Never read `process.env` anywhere else.

**`server/src/db/pool.ts`**

```ts
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Railway's external connection string terminates TLS at a proxy with a cert
  // that does not validate against the public roots.
  ssl: env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Without this, an error on an idle pooled client is an unhandled 'error' event
// and takes the process down.
pool.on("error", (err) => console.error("[db] idle client error", err));

export function query<T extends QueryResultRow>(text: string, params?: unknown[]) { ... }
```

`max: 5` is generous for one user on one process and stays well inside Railway's
default connection limit.

**`server/src/db/migrate.ts`**

A ~70-line runner. Behaviour:

1. `CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY,
   applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
2. Take `pg_advisory_lock(<fixed bigint constant>)` for the duration. Two
   simultaneous deploys then serialize instead of racing.
3. Read `new URL("../../migrations", import.meta.url)`. This resolves to
   `server/migrations` from both `src/db/` and `dist/db/`, so the same code path
   works in dev and in production without copying `.sql` files into `dist`.
4. Filter to `.sql`, sort lexicographically — hence zero-padded numeric
   prefixes (`001_`, `010_`) so ordering stays correct past nine migrations.
5. For each unapplied file: `BEGIN`, run the file, insert the filename into
   `schema_migrations`, `COMMIT`. Roll back and rethrow on failure.
6. Log each applied filename, and `"no pending migrations"` when there are none.
7. Release the lock, end the pool, `process.exit(0)`; on error log and
   `process.exit(1)`.

Runs as a CLI only. Nothing imports it at boot.

### Step 5 — errors, middleware, health route

**`server/src/lib/AppError.ts`**

```ts
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}
```

**`server/src/middleware/auth.ts`** — the §10 implementation:

```ts
import { createHash, timingSafeEqual } from "node:crypto";

const expectedDigest = createHash("sha256").update(env.APP_SECRET).digest();

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const match = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
  if (!match) throw new AppError(401, "unauthorized", "Missing bearer token");

  // Compare fixed-width digests rather than the raw secrets: timingSafeEqual
  // throws on a length mismatch, and guarding that with a length check would
  // itself leak the secret's length.
  const providedDigest = createHash("sha256").update(match[1]!).digest();
  if (!timingSafeEqual(providedDigest, expectedDigest)) {
    throw new AppError(401, "unauthorized", "Invalid credentials");
  }
  next();
}
```

Export the middleware from a factory taking the expected secret
(`createRequireAuth(secret)`) so the unit test can supply its own without
touching env, and export a default instance bound to `env.APP_SECRET` for the
app to mount.

**`server/src/middleware/requestLogger.ts`** — one line per request on `finish`:
method, path, status, duration in ms. No logging library.

**`server/src/middleware/errorHandler.ts`** — Express 5 four-arg terminal
handler. Order of checks: `AppError` → status/code/message/details; `ZodError` →
`400 invalid_input` with `details` = `[{ path, message }]`; anything else → log
the real error, respond `500 internal_error` with a generic message. Never leak
a stack trace or a raw upstream string to the client.

**`server/src/routes/health.ts`** — `GET /api/health`, unauthenticated. Runs
`SELECT 1`. Returns `200 { ok: true, db: "up" }`, or `503 { ok: false, db:
"down" }` if the query throws. Railway's healthcheck points here.

**`server/src/app.ts`** — assembly, in this exact order:

1. `cors()` — permissive, with the comment from §2.6.
2. `express.json({ limit: "1mb" })`.
3. `requestLogger`.
4. `/api/health` (before auth).
5. `requireAuth` mounted on `/api`.
6. `GET /api/ping` → `{ ok: true }`. A deliberate throwaway that makes the auth
   boundary testable with curl in phase 1. **Delete it in phase 2** once real
   authenticated routes exist.
7. 404 fallthrough → `AppError(404, "not_found", ...)`.
8. `errorHandler` last.

**`server/src/index.ts`** — bootstrap:

1. Import `env` (validates and fails fast).
2. `app.listen(env.PORT)`, log the bound port.
3. `SIGTERM`/`SIGINT` → stop accepting connections, `await pool.end()`, exit.
   Railway sends `SIGTERM` on every deploy; this is also where the phase-6
   sweep interval will be cleared.

### Step 6 — client scaffold

`npm create vite@latest client -- --template react-ts`, then trim it to:

- `client/package.json` — add `"@storyboards/shared": "*"` as a dependency.
- `client/tsconfig.json` — extends the base but overrides
  `moduleResolution: "Bundler"`, `module: "ESNext"`, `lib: ["ES2023", "DOM",
  "DOM.Iterable"]`, `jsx: "react-jsx"`, `noEmit: true`, `composite: false`.
- `client/.env.local` → `VITE_API_BASE_URL=http://localhost:3001`.
- `client/src/App.tsx` — fetches `${import.meta.env.VITE_API_BASE_URL}/api/health`
  on mount and renders the JSON. Nothing else. Delete the Vite demo CSS,
  counter, and logos.

This is the CORS and env-wiring smoke test. Do not build routing, a login
screen, or an API client here — phase 7 owns all of that.

### Step 7 — tests

`server/test/auth.test.ts`, using the `createRequireAuth(secret)` factory with
stub `req`/`res`/`next` objects:

1. Correct token → `next()` called once, no throw.
2. Wrong token of the **same length** → throws `AppError` with status 401.
3. Wrong token of a **different length** → throws `AppError` 401, and
   specifically does not throw a `RangeError` from `timingSafeEqual`. This is
   the case the digest-hashing exists to handle, so it is the case worth
   pinning.
4. Missing or malformed `Authorization` header → throws `AppError` 401.

`CLAUDE.md` limits tests to three areas and auth is not one of them. This
exception is deliberate and narrow: the middleware is security-relevant, it is a
pure function, and case 3 guards a real crash-shaped failure. No other phase-1
code gets tests.

---

## 5. Local Postgres

The fastest path for local development:

```bash
docker run --name storyboards-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=storyboards -p 5433:5432 -d postgres:17
```

Host port 5433 is used because 5432 was already occupied on the development
machine by a non-Docker Postgres. Any Postgres 16+ works — Homebrew, Postgres.app, or a Railway dev database.
Set `DATABASE_URL` in `server/.env` accordingly, and `DATABASE_SSL=true` only
when pointing at Railway's external connection string.

---

## 6. Verification checklist

Run in order. Every item should pass before phase 2 begins.

```bash
npm install
npm run typecheck                       # zero errors

cp .env.example server/.env             # then edit DATABASE_URL + APP_SECRET
npm run migrate --workspace=server      # applies 001_init.sql
npm run migrate --workspace=server      # "no pending migrations"
```

Schema spot-checks in `psql`:

```sql
\dt                                     -- concepts, stories, frames,
                                        -- frame_concepts, generations,
                                        -- schema_migrations
\d frames                               -- position is double precision;
                                        -- frames_selected_generation_fk present
\d generations                          -- generations_pending_idx is partial
select unnest(enum_range(null::concept_type));       -- character setting prop
select unnest(enum_range(null::generation_status));  -- pending succeeded failed
```

API checks with the server running (`npm run dev`):

```bash
curl -s localhost:3001/api/health                     # 200 {"ok":true,"db":"up"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/api/ping         # 401
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer wrong' localhost:3001/api/ping               # 401
curl -s -H "Authorization: Bearer $APP_SECRET" localhost:3001/api/ping   # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/api/nope         # 404
```

```bash
npm test                                # auth tests pass
```

Finally, open the Vite dev server in a browser and confirm the page renders the
health JSON — that is the CORS check, and it will not fail from `curl`.

Also confirm graceful shutdown: `Ctrl-C` the server and check that it logs the
shutdown path rather than dying silently.

---

## 7. Deployment notes (recorded now, executed later)

Not part of phase 1 execution, but decided here so phase 1 does not have to be
revisited.

**7.1 Railway build:** `npm ci && npm run build --workspace=shared && npm run
build --workspace=server`.

**7.2 Railway healthcheck path:** `/api/health`.

**7.3 Railway start command:** `npm run migrate:prod --workspace=server && npm
run start --workspace=server`. Migrations run on deploy, before the process
serves traffic, guarded by the advisory lock.

**7.4 Vercel:** root directory `client`, build `npm run build`, with
`VITE_API_BASE_URL` set to the Railway origin. The workspace root install must
run so `@storyboards/shared` resolves — Vercel handles npm workspaces natively
when the project root is set correctly.

---

## 8. Risks and how phase 1 addresses them

| Risk | Mitigation in this plan |
|---|---|
| `shared` not built → cryptic module-not-found on first `npm run dev` | Root `predev` builds it once before watchers start |
| `.sql` files missing from `dist` in production | Runner resolves `migrations/` relative to `import.meta.url`, which lands on `server/migrations` from both `src/` and `dist/` |
| Two deploys migrating concurrently | `pg_advisory_lock` around the whole run |
| `timingSafeEqual` throwing on a length mismatch | Compare SHA-256 digests, always 32 bytes; pinned by test case 3 |
| Idle Postgres client error crashing the process | `pool.on("error")` handler |
| Constants drifting into call sites | Everything in `shared/src/config.ts` from day one, before there are any call sites to drift into |
| Retry backoff colliding with the 5-minute sweep | `GENERATION_DEADLINE_MS` is a total budget across retries, not per-call |

---

## 9. Explicitly deferred

Do not build these in phase 1, even though phase 1 touches the files they will
eventually live in.

| Item | Phase |
|---|---|
| Concepts CRUD, S3 client, `sharp` preprocessing, presigned URLs | 2 |
| `POST /concepts/:id/describe`, description meta-prompts | 3 |
| Stories/frames CRUD, `POSITION_GAP` arithmetic, concept attachment | 4 |
| `promptCompiler.ts` and its tests | 5 |
| Generation pipeline, stale sweep, error classification, `AbortController` deadline | 6 |
| Login screen, routing, real client views, generation polling | 7 |
| Per-entity zod request schemas | With their routes (2 and 4) |
| `GET /api/ping` | Delete in phase 2 |

Two things worth writing down for phase 4, discovered while reading the schema:
`frame_concepts` has a unique index on `(frame_id, ord)`, so replacing a frame's
attachment set wholesale must `DELETE` then `INSERT` inside one transaction —
reusing `ord` values in the other order will collide. And `PATCH /frames/:id`
takes `conceptIds` as an ordered array whose index becomes `ord`, which is the
array that ultimately drives invariant 5. The ordering contract starts there.

---

## 10. Execution notes

Recorded after execution. Where the built code differs from the plan above, the
code is correct and this section says why.

| Change | Reason |
|---|---|
| Postgres runs on host port **5433** | 5432 was already occupied on the development machine by a non-Docker Postgres. Reflected in 5 and `.env.example`. |
| `middleware/auth.ts` exports **only** `createRequireAuth(secret)` | The plan also called for a bound default instance, but that requires importing `env`, whose module-level validation calls `process.exit(1)`. Importing auth would then have that as a side effect, and the unit test would depend on a configured `.env`. `app.ts` binds the factory instead. |
| 404 fallthrough uses a pathless `app.use(...)` | Express 5 uses path-to-regexp v8, which rejects the bare `'*'` path string Express 4 accepted. |
| `client` declares no `typescript` dependency | The Vite template pinned `~6.0.2` against the root's `^5.9.3`, which would have put two TypeScript majors in one repo. The client inherits the root compiler; verified there is exactly one `typescript` in the tree. |
| `oxlint`, `@types/node`, and the demo assets were removed from the client template | Tooling the project did not ask for, plus an `@types/node@^24` that conflicted with the server's `^22`. |
| Client build is `tsc --noEmit && vite build` | The template's `tsc -b` does not fit a `noEmit`, non-composite project. |
| `npm install` was run incrementally, not once at the end | npm tolerates workspace entries pointing at directories that do not exist yet, so each workspace was verified as it landed. |

Verified beyond the plan's checklist, because these behaviours are load-bearing
for later phases:

- **Migration DDL is provably identical to `TECH_SPEC.md` 5** — extracted, comment- and whitespace-normalized, and diffed rather than eyeballed.
- **Cascade behaviour.** Deleting a story cascades to frames, attachments and generations but leaves concepts; deleting a concept detaches it while leaving frames and past generations intact; deleting a generation nulls `frames.selected_generation_id`; duplicate `(frame_id, ord)` is rejected. The concept-deletion result answers the second open question in `TECH_SPEC.md` 15.
- **Migration rollback.** A deliberately broken migration left no partial table, was not recorded in `schema_migrations`, exited non-zero, and released the advisory lock.
- **Database loss and recovery.** Stopping Postgres returns `503` from `/api/health`; the process survives (the `pool.on("error")` handler) and returns to `200` unaided once the database is back.
- **Auth mutation test.** Replacing the digest comparison with a raw-buffer one makes the suite fail with `RangeError: Input buffers must have the same byte length` — the exact crash the fixed-width digests prevent.
- **Production path.** `node dist/index.js` and `node dist/db/migrate.js` both work, confirming the `import.meta.url` migrations lookup resolves from `dist/` and not just from `src/`.
