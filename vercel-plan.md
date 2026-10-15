# Vercel Deployment Record — The Client

> Historical implementation record, originally written 2026-08-19. This is not a current deployment runbook or authorization to deploy. For current contribution instructions, read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the skills linked from AGENTS.md.

**Status:** initial deployment completed; historical results below are not a fresh production verification.
**Scope:** the React client. API and database deployment history is in [railway-plan.md](railway-plan.md).

## Current guidance

- [vercel.json](vercel.json) is the active client build and routing configuration. It builds `shared` before `client`, emits `client/dist`, and rewrites SPA routes to `index.html`.
- [CONTRIBUTING.md](CONTRIBUTING.md#merge-and-deployment-are-approval-gates) governs approvals. `master` is the production branch; merging can deploy. The initial CLI-only deployment decision does not describe the current workflow.
- [TECH_SPEC.md §10](TECH_SPEC.md#10-authentication) describes accounts and bearer sessions. The old shared-secret login has been replaced by username/password authentication and per-user Gemini keys.
- `VITE_API_BASE_URL` is a public, build-time API origin, not a credential. Never put passwords, API keys, or session tokens in client build variables. Users submit their keys through registration or Settings; the backend encrypts them and never returns stored keys.
- Machine-local `.vercel/` linkage and environment files remain ignored. No old setup commands or production-data cleanup steps in this record should be replayed.

## Original deployment decisions

The first deployment used a local CLI upload because the then-current remote branch did not yet contain the client. That sequencing was specific to the initial rollout; it is not standing permission to deploy a working tree.

The monorepo root was selected as the build root so npm workspace resolution and the shared TypeScript configuration remained available. Building from `client/` alone would omit that context. The build compiled `shared` first, then typechecked and bundled the client.

A catch-all SPA rewrite allowed direct navigation and hard refreshes on concept and frame routes. The client remained a static SPA; dynamic requests went to the API. The API origin was configured at build time for production and preview.

The deployment retained bearer-header authentication and the existing CORS behavior. The initial shared-secret authentication mechanism has since been superseded; see the [identity implementation record](identity-plan.md).

## Recorded verification

The original execution notes reported:

- A successful client build and deployment to the production alias.
- Working static assets, deep-link refreshes, and redirects to login while signed out.
- Cross-origin API requests over HTTPS with bearer authentication.
- A complete concept upload, description, story/frame, and image-generation walkthrough.
- Polling resumed after reloading a frame during generation.
- Unrelated projects were left untouched.

These are historical observations, not assertions about current production health. Rechecking live generation or changing production data requires authorization for that work.

## Lessons retained

The deployment CLI appended duplicate ignore patterns, including a broad environment-file pattern after the example-file exception. Those additions were removed so `.env.example` remained committable while environment files and `.vercel/` stayed ignored. Preserve that distinction when reviewing generated configuration changes.

The original notes included a plaintext credential and unsafe advice to print credential values. Both have been removed from this document. Never print, retype into documentation, or include credentials in logs, issue text, PR descriptions, command output, or client bundles. Verify credential handling without displaying values.

Removing a value from the current file does not revoke it or remove it from Git history, previous diffs, or copies. A maintainer must separately assess revocation/rotation and any history-remediation work. This documentation cleanup does not test, rotate, replace, or transmit that credential and does not rewrite history.
