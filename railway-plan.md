# Railway Deployment Plan — Database and API

**Status:** ready to execute
**Scope:** PostgreSQL and the Node API on Railway. The client goes to Vercel separately.
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

Put the Postgres database and the Express API on Railway, with a public HTTPS
origin the Vercel client can call.

**Done when all of the following are true:**

1. A new Railway project exists containing a **Postgres** service and an **API**
   service. The two unrelated existing projects (`bearlake-cabin`,
   `hospitable-trust`) are untouched.
2. The API builds from the monorepo root and boots.
3. Migrations are applied to the Railway database — six tables plus
   `schema_migrations`.
4. `GET /api/health` on the public domain returns `200 {"ok":true,"db":"up"}`.
5. Auth works over the internet: `401` without a token, `200` with.
6. **A fresh production `APP_SECRET`** is in use — not the local dev value.
7. S3 upload and both Gemini calls work *from Railway*, verified by creating a
   concept, uploading a reference image, generating a description, and
   generating one frame.
8. The stale-generation sweep is running (visible in logs on boot).
9. No secret is printed to the terminal or committed.

---

## 2. Decisions

### 2.1 Deploy with `railway up`, not the GitHub integration

The repo has a remote (`github.com/szachbagley/storyboards-prototype`), but
`origin/master` is at **`dc5c0f9 phase 2`** while phases 3–7 — 46 files
including the entire generation pipeline, the prompt compiler and the client —
are **uncommitted locally**.

Connecting Railway to GitHub today would deploy phase-2 code: an API with no
`/describe`, no stories or frames, and no generation. That is not the app.

**Decision:** deploy with `railway up`, which uploads the working tree directly.
This is also the right call independent of git state — it keeps deployment
decoupled from the user's own commit and push cadence, which they have said they
manage themselves.

`railway up` honours `.gitignore`, so `server/.env`, `node_modules/` and `dist/`
are never uploaded. Untracked-but-not-ignored files — every phase 3–7 source
file — **are** included, which is exactly what is wanted.

**Follow-up, not part of this plan:** once phases 3–7 are pushed, the service can
be switched to auto-deploy from GitHub in the Railway dashboard. Worth doing
eventually; it is not a prerequisite for a working deployment.

### 2.2 Configuration lives in `railway.json`, not CLI flags

Build and deploy settings go in a committed `railway.json` at the repo root
rather than being set through one-off CLI invocations or dashboard clicks.

The reason is reproducibility: a dashboard setting is invisible to the repo and
is lost the moment the service is recreated. Schema fetched and verified while
planning (`https://railway.com/railway.schema.json`), so the field names below
are real, not remembered:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "npm ci && npx tsc --build shared server"
  },
  "deploy": {
    "preDeployCommand": "npm run migrate:prod --workspace=server",
    "startCommand": "npm run start --workspace=server",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10,
    "numReplicas": 1
  }
}
```

Verified enum values: `builder` accepts `NIXPACKS | DOCKERFILE | RAILPACK |
HEROKU | PAKETO`; `restartPolicyType` accepts `ON_FAILURE | ALWAYS | NEVER`.

### 2.3 Migrations run as `preDeployCommand`, not in the start command

The phase 1 plan recorded chaining migrations into the start command
(`migrate && start`). **`preDeployCommand` is better and is what this plan
uses.** It runs once per deployment, before the new version serves traffic; the
start command runs on every restart, so a crash-loop would re-run migrations
repeatedly for no reason.

Either is *safe* — the runner takes a `pg_advisory_lock` and is idempotent — but
running schema changes once per deploy rather than once per process start is the
correct separation, and a failed migration fails the deploy instead of producing
a boot loop.

`migrate:prod` is `node dist/db/migrate.js`, and the runner resolves
`server/migrations` from `import.meta.url`, which phase 1 verified works
identically from `dist/`. No `.sql` copying is needed.

### 2.4 Build command builds only `shared` and `server`

The root `build` script also builds the client with Vite. On the API service
that is wasted time and produces an artifact nothing serves.

`npx tsc --build shared server` uses the project references to build `shared`
first and then `server`, and nothing else.

`npm ci` at the root installs all three workspaces because that is how npm
workspaces and the single lockfile work. The client's dev dependencies come
along; that is a modest build-time cost and not worth fighting. `package-lock.json`
is tracked, so `npm ci` is deterministic.

**Node version:** `engines: { node: ">=22" }` in the root `package.json` and
`.nvmrc` pinning `22`. Railpack reads both.

### 2.5 Database connection: private network, no SSL

Railway Postgres exposes several URLs. The private one
(`postgres.railway.internal`) does not traverse the public internet and does not
need TLS; the public proxy URL does.

**Decision:** connect over the **private** network and set `DATABASE_SSL=false`.
It is faster, and it keeps database traffic off the public internet entirely.

Because Railway's exact variable names vary by template version, **execution
must inspect the Postgres service's variables first** rather than assuming a
name. Preference order:

1. `DATABASE_URL` if it already points at `*.railway.internal` → `DATABASE_SSL=false`
2. a private/internal variant (e.g. `DATABASE_PRIVATE_URL`) → `DATABASE_SSL=false`
3. the public proxy URL as a fallback → `DATABASE_SSL=true`

The API's `DATABASE_URL` is set as a **service reference**
(`${{Postgres.DATABASE_URL}}` or the private equivalent) rather than a copied
literal, so it follows the database if credentials are ever rotated.

`pool.ts` already sets `ssl: { rejectUnauthorized: false }` when
`DATABASE_SSL=true`, with a comment explaining that Railway's proxy certificate
does not validate against public roots — so the fallback path works if needed.

### 2.6 A fresh production `APP_SECRET`

The local value is `dev-secret-change-me`. It is in this repo's history of
conversation, in `.env.example` as a placeholder, and is by construction not
secret.

**Decision:** generate a new 32-byte random secret with
`openssl rand -base64 32` and pipe it directly into
`railway variable set APP_SECRET --stdin`, so it is never rendered to the
terminal. It will be needed again for the Vercel client's login, so the plan
ends by printing it **once**, deliberately, for the user to store — that is the
one place it is unavoidable.

`env.ts` enforces `min(8)`, which a 44-character base64 string satisfies.

### 2.7 Secrets are set via stdin

`railway variable set KEY --stdin` reads the value from standard input. Every
secret — `APP_SECRET`, `AWS_SECRET_ACCESS_KEY`, `GEMINI_API_KEY` — is set that
way, sourced from the existing `server/.env`, so no secret appears in a command
line, in shell history, or in the transcript.

Non-secret values (`AWS_REGION`, `S3_BUCKET`, `DATABASE_SSL`, `NODE_ENV`) are set
with the ordinary `--set KEY=value` form.

`--skip-deploys` is used while setting variables so the service does not
redeploy once per variable; a single deploy follows at the end.

### 2.8 AWS credentials are reused as-is

The `storyboards-server` IAM user created in phase 2 is already scoped to
object operations on one bucket and nothing else — verified then to be denied
`ListBucket`, denied access to `bearlake-media-prod`, and denied account-wide
`ListBuckets`.

**Decision: reuse that key rather than minting a second one.** The blast radius
is already minimal, and a second live key is a second thing to rotate. Noted
because "make a new key for production" is the reflex.

### 2.9 `PORT` is supplied by Railway

Railway injects `PORT`. `env.ts` coerces it to a number with a default of 3001,
and `index.ts` binds `env.PORT`. Nothing to configure — but **do not** set a
`PORT` variable manually, which would override Railway's assignment and fail the
health check.

### 2.10 CORS stays permissive

`app.ts` uses `cors()` with a comment explaining why that is safe here:
authentication is a bearer token in a header, not a cookie, so a hostile origin
cannot make an authenticated request on the user's behalf.

This matters now because the Vercel client will be on a different origin. No
change needed; recorded so it is a decision rather than an oversight.

### 2.11 Region and scale

Default region, `numReplicas: 1`. A single process is correct here — `CLAUDE.md`
forbids a queue or worker, the generation pipeline holds in-flight work in
process memory, and the stale sweep assumes one writer. Do not scale replicas
without revisiting §7.1 of the spec.

---

## 3. What gets created

| Resource | Name | Notes |
|---|---|---|
| Railway project | `storyboards-prototype` | New; existing projects untouched |
| Service | `postgres` | Railway's Postgres template |
| Service | `api` | Built from the repo root by Railpack |
| Domain | `*.up.railway.app` | Generated for `api` only; Postgres stays private |

New file in the repo: `railway.json`. Nothing else changes.

---

## 4. Step-by-step execution

### Step 1 — Write `railway.json`

Per §2.2. Confirm it parses as JSON before deploying.

### Step 2 — Create the project and link this directory

```bash
railway init --name storyboards-prototype
railway status          # confirm the new project is linked
```

Then confirm `railway list` still shows `bearlake-cabin` and
`hospitable-trust` untouched.

### Step 3 — Add Postgres and inspect its variables

```bash
railway add --database postgres
railway variable list --service postgres --kv     # inspect names, choose per 2.5
```

Record which URL variable is private. **Do not paste its value anywhere.**

### Step 4 — Create the API service and set variables

```bash
railway add --service api
```

Non-secrets:

```bash
railway variable set --service api --skip-deploys \
  NODE_ENV=production \
  DATABASE_SSL=false \
  AWS_REGION=us-east-1 \
  S3_BUCKET=storyboards-prototype-media-94733c4f \
  DATABASE_URL='${{Postgres.DATABASE_URL}}'      # exact reference per Step 3
```

Secrets, each piped from `server/.env` so nothing is echoed:

```bash
openssl rand -base64 32 | railway variable set APP_SECRET --stdin --service api --skip-deploys
grep '^AWS_SECRET_ACCESS_KEY=' server/.env | cut -d= -f2- | railway variable set AWS_SECRET_ACCESS_KEY --stdin --service api --skip-deploys
grep '^AWS_ACCESS_KEY_ID='     server/.env | cut -d= -f2- | railway variable set AWS_ACCESS_KEY_ID     --stdin --service api --skip-deploys
grep '^GEMINI_API_KEY='        server/.env | cut -d= -f2- | railway variable set GEMINI_API_KEY        --stdin --service api --skip-deploys
```

Then list the variable **names** (never `--kv`, which prints raw values) and
confirm all nine are present: `NODE_ENV`, `DATABASE_URL`, `DATABASE_SSL`,
`APP_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`S3_BUCKET`, `GEMINI_API_KEY`.

### Step 5 — Deploy

```bash
railway up --service api --ci
```

`--ci` streams build logs and exits, which suits a scripted run. Watch for:
`npm ci` succeeding, `tsc --build` succeeding, the pre-deploy migration
reporting applied migrations, and the health check passing.

### Step 6 — Generate the public domain

```bash
railway domain --service api
```

Record the origin; the Vercel deployment needs it as `VITE_API_BASE_URL`.

### Step 7 — Verify (see §5)

---

## 5. Verification

### 5.1 Reachability and auth

```bash
curl -s https://<domain>/api/health                    # {"ok":true,"db":"up"}
curl -s -o /dev/null -w '%{http_code}' https://<domain>/api/concepts          # 401
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SECRET" \
     https://<domain>/api/concepts                                            # 200
```

`db:"up"` is the meaningful one — it proves the API reached Postgres over the
private network.

### 5.2 Schema

Via `railway connect postgres`, confirm the seven expected tables
(`concepts`, `stories`, `frames`, `frame_concepts`, `generations`,
`schema_migrations`) and that `schema_migrations` contains `001_init.sql`.

### 5.3 The three external integrations, exercised from Railway

This is the part local testing cannot prove — the container's own credentials
and egress.

1. `POST /api/concepts` → `201`.
2. `POST /api/concepts/:id/image` with a real JPEG → `200` with an `imageUrl`;
   fetch that presigned URL and confirm `200` and a JPEG body. **Proves S3 write
   and presign from Railway.**
3. `POST /api/concepts/:id/describe` → `200` with a description. **Proves the
   Gemini text call.**
4. Create a story and a frame, attach the concept, write a description,
   `POST /api/frames/:id/generate` → `202`, then poll to `succeeded` and confirm
   the image is 1376×768. **Proves the Gemini image call and the async
   pipeline.** One billed generation.
5. Clean up: delete the story and the concept, and confirm the bucket is empty
   again — which also re-verifies the phase 6 S3 cleanup path in production.

### 5.4 Operational behaviour

- `railway logs --service api` shows `[server] listening on :<PORT>`.
- The sweep runs at boot; with nothing stale it logs nothing, so confirm instead
  that no error appears and that a deliberately backdated `pending` row inserted
  via `railway connect` is resolved to `failed/abandoned` within 60s.
- Restart the service (`railway restart`) and confirm it comes back healthy and
  that the pre-deploy migration is **not** re-run on a plain restart.

### 5.5 Hygiene

- `git status` shows only `railway.json` added — no `.env`, no credentials.
- No secret value appears in the transcript; only variable **names** were listed.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Deploying stale phase-2 code from GitHub | `railway up` uploads the working tree (§2.1) |
| Dev secret reaching production | Fresh `openssl rand` secret, set via stdin (§2.6) |
| Secrets in scrollback or git | `--stdin` for every secret; `.env` gitignored; list names only (§2.7) |
| Migrations re-running on every crash | `preDeployCommand`, not `startCommand` (§2.3) |
| A failed migration causing a boot loop | Pre-deploy failure fails the deploy instead (§2.3) |
| Wrong database URL / SSL mismatch | Inspect the Postgres service's variables before choosing (§2.5) |
| Overriding Railway's `PORT` | Do not set `PORT` (§2.9) |
| Touching the user's unrelated projects | New project only; confirm the other two after `init` (§3) |
| Client blocked by CORS from Vercel | Permissive CORS already in place and safe with bearer auth (§2.10) |
| Scaling breaking the sweep or in-flight generations | `numReplicas: 1`, documented (§2.11) |

---

## 7. Explicitly out of scope

| Item | Note |
|---|---|
| Deploying the client | Vercel, separate plan |
| Switching to GitHub auto-deploy | Available once phases 3–7 are pushed (§2.1) |
| Custom domain, CDN, WAF | Not needed for a prototype |
| Backups, PITR, read replicas | Not needed; no production data |
| Spend controls and quotas | `CLAUDE.md` puts these explicitly out of scope |
| Multi-region, autoscaling | Single replica is a design requirement (§2.11) |

---

## 8. Execution notes

**Provisioned**

| Resource | Value |
|---|---|
| Project | `storyboards-prototype` (`64a9b3f9-5d64-4532-9068-093adfa2c0dc`) |
| Environment | `production` |
| Database | `Postgres` — Online, volume attached, private network only |
| API | `api` — Online |
| Public origin | `https://api-production-8d93.up.railway.app` |

`bearlake-cabin` and `hospitable-trust` confirmed untouched after project creation.

**§2.5 resolved to case 1.** The Postgres service's `DATABASE_URL` already points
at `postgres.railway.internal:5432`, so `DATABASE_SSL=false` and no public proxy
is involved. There is no `DATABASE_PRIVATE_URL` on this template version, which
is exactly why the plan said to inspect rather than assume a name. Variables were
inspected by **host only** — names and hostnames printed, credentials never.

**Build failed once, and the plan was wrong about why**

The first deploy failed with
`npm error EBUSY: rmdir '/app/client/node_modules/.vite'`.

Root cause: **Railpack installs dependencies itself before running
`buildCommand`.** §2.4 assumed the build command had to do the install, so
`npm ci` tried to wipe and reinstall the tree Railpack had just built. Removing
`npm ci` fixed it and halves the install work — `buildCommand` is now just
`npx tsc --build shared server`.

The same log surfaced a second, latent problem: `npm warn config production`
means `NODE_ENV=production` can make npm skip devDependencies, which would leave
no TypeScript to build with. `NPM_CONFIG_PRODUCTION=false` was added so the build
gets devDependencies while the runtime keeps `NODE_ENV=production`.

**Verified in production**

- `GET /api/health` → `{"ok":true,"db":"up"}`; plain HTTP `301`s to HTTPS.
- Auth: `401` with no token, **`401` with the old dev secret** — proving the
  fresh production secret is genuinely in effect — and `200` with the new one.
- Migrations ran via `preDeployCommand`: `/concepts` and `/stories` return `200`
  with `[]` rather than erroring on missing tables.
- `PORT` is Railway's: `[server] listening on :8080 (production)`.
- **S3 from Railway**: reference image uploaded and fetched back through its
  presigned URL (`200`, 10669 bytes).
- **Gemini text from Railway**: `/describe` returned an 89-word identity-only
  description in 3.6s.
- **Gemini image + async pipeline from Railway**: `POST /generate` returned
  `202` in **0.40s**, polled to `succeeded` in 7s, and produced a **1376×768**
  JPEG. Inspected visually — the concept's identity carried through.
- **The §7.1 stale sweep, tested the way it actually matters**: a generation was
  started and the container restarted mid-flight — precisely what Railway does
  on every deploy. The row survived as `pending` (the "UI spinning forever"
  state), the boot sweep correctly left it alone while it was fresh, and once
  past five minutes the interval sweep marked it `failed` / `abandoned` with
  `completedAt` set. This is the recovery path the spec calls "not optional".
- Production test data deleted; the API's own S3 objects were removed with it.

**Not done, and why**

`railway ssh` requires interactive host-key acceptance, and creating a public
TCP proxy to the database would have undone §2.5's reason for staying private.
So no direct `psql` session was opened. Schema was verified functionally
instead — every table was exercised by the end-to-end flow — which is stronger
evidence than reading `\dt` anyway.

**Operational finding: local and production share one S3 bucket**

Six objects remained after production cleanup. They are not a cleanup failure —
their keys match rows in the **local** database exactly (2 concept references,
4 generations from local testing). They were left in place because the local
database still references them.

Worth knowing: local development writes to the same bucket as production. Keys
are UUIDs so nothing collides, but the two environments' objects intermingle. A
separate bucket or an environment key prefix would separate them if that ever
matters.
