# Vercel Deployment Plan — The Client

**Status:** ready to execute
**Scope:** the React client only. The API and database are already live on Railway.
**Depends on:** the Railway deployment — `https://api-production-8d93.up.railway.app`
**Written:** 2026-08-19

---

## 1. Goal and exit criteria

Put the Vite/React client on Vercel as a static SPA that talks to the Railway
API, completing the deployment.

**Done when all of the following are true:**

1. A new Vercel project exists. The two unrelated existing projects
   (`bearlake-web`, `boncom-app`) are untouched.
2. The client builds on Vercel from the monorepo root, with `shared` compiled
   first.
3. `VITE_API_BASE_URL` is baked in as the Railway origin.
4. The site loads over HTTPS and redirects an unauthenticated visit to `/login`.
5. Signing in with the production `APP_SECRET` works — proving cross-origin
   calls from `*.vercel.app` to `*.up.railway.app` succeed.
6. **A hard refresh on a deep link** such as `/concepts/<uuid>` renders the app
   rather than returning 404 — the SPA rewrite works.
7. The full loop works end to end in production: create a concept, upload a
   reference image, generate a description, create a story and frame, attach the
   concept, and generate a frame.
8. No secret is committed; `VITE_API_BASE_URL` is the only client variable and
   it is not a secret.

---

## 2. Decisions

### 2.1 CLI deploy, not the GitHub integration — same reason as Railway

`origin/master` is still at `dc5c0f9 phase 2`; the entire client (phase 7) is
uncommitted. Connecting Vercel to GitHub today would build a repo that has no
`client/src/routes/` at all.

**Decision:** `vercel deploy --prod` from the local working tree. The user has
said GitHub auto-deploy waits until the app is fully deployed and operational,
so this is also the explicitly requested sequencing.

### 2.2 Root directory is the repo root, not `client/`

The obvious move is to point Vercel at `client/`. **That breaks the build.**

`client/` imports `@storyboards/shared`, which resolves through the npm
workspace symlink to `shared/dist`. If Vercel's root directory were `client/`,
the install would have no workspace root, `@storyboards/shared` would not
resolve, and `client/tsconfig.json` — which extends `../tsconfig.base.json` —
would fail to load.

**Decision:** root directory stays the repo root. Vercel installs all three
workspaces from the single lockfile, then builds `shared` and `client` only.

### 2.3 Explicit build configuration in `vercel.json`

Committed configuration rather than dashboard settings, for the same
reproducibility reason as `railway.json`. Field names verified against the
published schema (`https://openapi.vercel.sh/vercel.json`) while planning —
`buildCommand`, `outputDirectory`, `installCommand`, `framework` and `rewrites`
all exist, and `framework` accepts `"vite"`.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "installCommand": "npm install",
  "buildCommand": "npx tsc --build shared && npm run build --workspace=client",
  "outputDirectory": "client/dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

**Why the build command is what it is.** `shared` must be compiled before the
client can import it — phase 1 chose emitting to `dist` precisely so both sides
consume built output. `npx tsc --build shared` uses the project reference and
builds nothing else; `server` is deliberately excluded, since Vercel has no use
for it. The client's own script (`tsc --noEmit && vite build`) then typechecks
and bundles.

`outputDirectory` is `client/dist` because the build runs from the repo root
while Vite writes relative to its own package.

### 2.4 The SPA rewrite is mandatory, not cosmetic

This is the one piece of the deployment that has no local equivalent and will
silently break without attention.

The client uses `BrowserRouter` with real paths — `/concepts/:id`,
`/stories/:id/frames/:frameId`. In development the Vite dev server serves
`index.html` for any unmatched path, so deep links and refreshes work. **Static
hosting does not.** Without a rewrite, a hard refresh on `/concepts/<uuid>`
looks for a file at that path and returns 404.

The catch-all rewrite to `/index.html` fixes it. Assets still resolve because
Vercel matches real files in the output directory before applying rewrites.

Phase 7's walkthrough exercised reload-during-generation and deep-link recovery,
so a 404 here would break behaviour that has already been verified to work
locally. §5 tests it explicitly.

### 2.5 `VITE_API_BASE_URL` is a build-time variable

Vite inlines `import.meta.env.VITE_*` at build time; nothing reads it at
runtime. So it must exist when Vercel builds, not merely when the site is
served.

**Decision:** set it as a **project** environment variable for both `production`
and `preview`, via `vercel env add`, rather than passing `--build-env` per
deploy. A project variable persists, so a later redeploy — or the eventual
GitHub integration — cannot silently produce a build pointing at nothing.

Value: `https://api-production-8d93.up.railway.app` — **no trailing slash**, since
`api.ts` builds URLs as `${BASE}/api${path}`.

It is not a secret. The API origin is discoverable from any browser devtools
panel, and the API is protected by the bearer token, not by obscurity. It will
be embedded in the JavaScript bundle, which is expected and fine.

**`APP_SECRET` is never given to Vercel.** The user types it into the login
screen and it lives in that browser's `localStorage`. Putting it in a client
build variable would ship it to every visitor.

### 2.6 No `.vercelignore`

Adding one **replaces** Vercel's default upload filtering rather than adding to
it, so an incomplete file risks uploading `node_modules/`.

**Decision:** ship no `.vercelignore` and rely on the defaults, then verify at
execution that the uploaded source is small (a few MB, not hundreds). If it is
large, add a complete ignore file rather than a partial one.

Excluding `server/` might seem attractive to shrink the upload, but the single
lockfile references all three workspaces, so removing one breaks `npm install`.

### 2.7 Node version

The root `package.json` declares `engines.node: ">=22"`, and both existing
Vercel projects run 24.x. Vercel historically wants a major like `22.x` and can
reject open-ended ranges.

**Decision:** do not change `engines` — Railway reads the same field and it is
working there. If Vercel rejects the range, set the Node version in the Vercel
**project settings** instead, which keeps the change scoped to the platform that
needs it. Verify at execution rather than pre-emptively editing.

### 2.8 Static only — no serverless functions

The client is a pure SPA. There is no `api/` directory, no server-side
rendering, and nothing for Vercel to run at request time. Everything dynamic
happens on Railway.

This matters for one reason: **nothing on Vercel holds a credential.** The
build produces static files, and the only sensitive value in the whole client
flow — the app secret — is typed by the user at runtime.

### 2.9 CORS needs no change

`app.ts` uses permissive `cors()` because authentication is a bearer token in a
header rather than a cookie, so a hostile origin cannot make an authenticated
request on the user's behalf. The new Vercel origin is therefore already
allowed. Recorded so that a cross-origin failure during §5 is recognised as
something else — a wrong `VITE_API_BASE_URL`, most likely — rather than sending
someone to edit CORS.

### 2.10 Production deploy directly

`vercel deploy --prod --yes` deploys straight to production. There is no
existing traffic to protect and no staging environment in this prototype, so a
preview-then-promote dance would add ceremony without value. The preview
environment still gets `VITE_API_BASE_URL` (§2.5) so that any future preview
build works.

---

## 3. What gets created

| Resource | Name | Notes |
|---|---|---|
| Vercel project | `storyboards-prototype` | New; existing two untouched |
| Production domain | `storyboards-prototype*.vercel.app` | Auto-assigned |
| Env var | `VITE_API_BASE_URL` | production + preview |

New file in the repo: `vercel.json`. A `.vercel/` directory is created locally
for project linkage — **check it is gitignored**, and add it if not.

---

## 4. Step-by-step execution

### Step 1 — Write `vercel.json`

Per §2.3. Confirm it parses as JSON.

### Step 2 — Confirm `.vercel/` will not be committed

`.gitignore` currently has no `.vercel` entry. Add one before linking, so the
local project-linkage directory never enters the repo.

### Step 3 — Create and link the project

```bash
vercel link --yes --project storyboards-prototype
vercel project ls          # confirm bearlake-web and boncom-app are intact
```

### Step 4 — Set `VITE_API_BASE_URL`

```bash
printf 'https://api-production-8d93.up.railway.app' | vercel env add VITE_API_BASE_URL production
printf 'https://api-production-8d93.up.railway.app' | vercel env add VITE_API_BASE_URL preview
vercel env ls
```

Confirm no trailing slash.

### Step 5 — Deploy to production

```bash
vercel deploy --prod --yes
```

Watch for: `npm install` resolving all three workspaces, `tsc --build shared`
succeeding, `vite build` emitting to `client/dist`, and the deployment
reporting the output directory correctly.

If the build fails on the Node version, apply §2.7's remedy.

### Step 6 — Verify (§5)

---

## 5. Verification

Let the production URL be `$SITE` and the Railway origin `$API`.

### 5.1 The site loads and routes

- `GET $SITE` returns `200` and serves the app shell.
- Visiting `$SITE/concepts` while signed out lands on `/login` (client-side
  `RequireAuth`).
- **`GET $SITE/concepts/<any-uuid>` directly returns `200`, not `404`.** This is
  the §2.4 rewrite. Test with `curl` for the status code *and* in a browser for
  a hard refresh on a real deep link.
- A static asset (`/assets/index-*.js`) returns `200` with a JavaScript content
  type — proving the rewrite did not swallow real files.

### 5.2 The bundle points at the right API

Fetch the built JavaScript and confirm the Railway origin is present and that
no stale `localhost:3001` string survives:

```bash
curl -s $SITE/assets/index-*.js | grep -c 'api-production-8d93.up.railway.app'   # >= 1
curl -s $SITE/assets/index-*.js | grep -c 'localhost:3001'                       # 0
```

This catches a missing or wrong build variable before any manual clicking.

### 5.3 Cross-origin auth

In a browser: sign in with the production `APP_SECRET`. A successful sign-in
proves the browser made a cross-origin `GET /api/concepts` with an
`Authorization` header and got `200` — CORS, HTTPS and the token path all at
once. Confirm the console shows no CORS or mixed-content errors.

### 5.4 The full loop against production

Driven in the browser, mirroring the phase 7 walkthrough but against the
deployed stack:

1. Create a `character` concept; upload a reference image.
2. **Generate description** — proves the Gemini text call through the deployed API.
3. Create a story; add a frame; attach the concept; write a scene description.
4. **Generate frame** — expect the elapsed timer, then a 16:9 image. One billed
   generation.
5. Reload the frame page mid-generation and confirm it resumes polling rather
   than showing idle — this exercises both the phase 7 resume logic and the
   §2.4 rewrite on a deep link.
6. Delete the story and the concept afterwards, leaving production clean.

### 5.5 Hygiene

- `git status` shows only `vercel.json` added (plus the `.gitignore` line);
  `.vercel/` is ignored.
- No secret appears in the repo or in the built bundle: grep the deployed
  JavaScript for the app secret and for `AKIA` / `AQ.` prefixes — all must be
  absent.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Deploying the phase-2 tree with no client | CLI deploy from the working tree (§2.1) |
| Root directory `client/` breaking workspace resolution | Root stays the repo root (§2.2) |
| Deep links 404 on refresh | Catch-all rewrite to `/index.html`, tested explicitly (§2.4, §5.1) |
| Build variable missing → bundle calls `localhost` | Project-level env var, asserted by grepping the bundle (§2.5, §5.2) |
| Shipping `APP_SECRET` to every visitor | Never set as a Vercel variable; typed by the user at runtime (§2.5) |
| `.vercel/` committed | Add the gitignore entry before linking (§3, Step 2) |
| An incomplete `.vercelignore` uploading `node_modules` | Ship none; verify upload size instead (§2.6) |
| Node version range rejected | Set it in project settings, not `engines` (§2.7) |
| Chasing CORS when the real fault is the API URL | CORS already permissive and safe; check the bundle first (§2.9, §5.2) |

---

## 7. Explicitly out of scope

| Item | Note |
|---|---|
| GitHub auto-deploy for either platform | Deferred by the user until the app is fully deployed and operational |
| Custom domain | Not needed for a prototype |
| Analytics, Speed Insights, Web Vitals | Not requested; each adds a script to the bundle |
| Preview deployments per branch | Environment variable is set so they would work, but none are created |
| Tightening CORS to the Vercel origin | Safe as-is with bearer auth (§2.9); would become worth doing if cookies were ever introduced |
| Separating local and production S3 buckets | Noted during the Railway deployment; unchanged here |

---

## 8. Execution notes

**Deployed**

| Resource | Value |
|---|---|
| Project | `storyboards-prototype` under `szachbagleys-projects` |
| Production URL | `https://storyboards-prototype.vercel.app` |
| Build | `npx tsc --build shared && npm run build --workspace=client` → `client/dist` |
| Env | `VITE_API_BASE_URL` set for production and preview |

`bearlake-web` and `boncom-app` confirmed intact.

**§2.7 did not bite.** Vercel assigned Node 24.x, which satisfies
`engines: ">=22"`, so `package.json` was left alone.

**Deployment Protection resolved itself correctly.** The deployment-specific URL
302s to Vercel SSO, but the production alias is public — Vercel's Standard
Protection gates preview/deployment URLs and leaves production open. No setting
needed changing, which is the better outcome: nothing was weakened to make the
app reachable.

**`vercel link` edited `.gitignore`, and one edit was harmful**

It appended `.vercel` and `.env*`. Both duplicated rules this repo already had —
but `.env*` landed **after** the `!.env.example` negation, and later patterns
win, so `.env.example` (a tracked file that must stay committable) would have
become ignored. Both lines were removed and the full matrix re-verified:
`.env.example` committable; `server/.env`, `client/.env.local`, the root
`.env.local` Vercel created, and `.vercel/` all ignored.

`vercel link` also wrote a root `.env.local` holding a `VERCEL_OIDC_TOKEN`. It
is ignored, absent from `git status`, and inert for this app — Vite reads
`client/.env.local` and the server reads `server/.env`.

**Verified in production**

- SPA rewrite: `/`, `/concepts`, `/concepts/<uuid>` and
  `/stories/<uuid>/frames/<uuid>` all return `200` and serve the app shell;
  `/assets/index-*.js` still returns real JavaScript, so the catch-all does not
  swallow files.
- Bundle: the Railway origin appears once; **zero** occurrences of
  `localhost:3001` or `undefined/api`.
- **No secret in the bundle**: the app secret, `AKIA…` and `AQ.…` all absent —
  the payoff for never giving `APP_SECRET` to Vercel.
- Cross-origin auth: signing in from `*.vercel.app` against `*.up.railway.app`
  works, proving CORS preflight with an `Authorization` header, HTTPS both ends,
  and the bearer path.
- Full loop in the browser: concept created, reference image uploaded,
  description generated, story and frame created, concept attached, frame
  generated — identity carried through and every staging directive honoured.
- **Reload mid-generation on a deep link**: exercised the SPA rewrite and the
  phase 7 resume-polling logic in one action; the app came back and showed the
  finished frame plus its history thumbnail.
- Production data deleted afterwards; the six remaining S3 objects are the
  local-testing artifacts identified during the Railway deployment.

**A mistake I made, and the correction**

The Railway recap published an `APP_SECRET` that was **wrong** — I transcribed
it by hand instead of reading the file, and the first character differed
(`L…` rather than `R…`). It surfaced immediately here: the browser login failed
with `401` while `curl` using the file succeeded.

The correct value is `Rx7mRU6WtkRRLcVp5cA5HRqkbrF6PxM4JL28irEqWm8=`, confirmed
by a `200` from the API. The lesson is narrow and worth keeping: print secrets
from their source, never retype them.
