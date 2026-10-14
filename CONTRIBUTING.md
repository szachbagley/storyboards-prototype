# Contributing

Use GitHub Issues to define work and pull requests to review it. Read [AGENTS.md](AGENTS.md) and [TECH_SPEC.md](TECH_SPEC.md) before changing application behavior; this guide complements their architecture and testing guidance.

Maintainers can track work on the private [Development Work project](https://github.com/users/szachbagley/projects/2). Project access is separate from repository access; public contributors can work through repository issues and PRs without access to that board.

## Define one outcome

Create one issue per independently reviewable outcome using the Work item form. Capture the problem, scope and exclusions, acceptance criteria, verification plan, dependencies and decisions, and deployment considerations. For bugs, include reproduction steps and expected versus actual behavior. Split unrelated outcomes and link prerequisites.

Issues, PRs, and their attachments are public. Never paste credentials, private user data, or sensitive logs. A private Project does not make its public repository issues private.

## Move work through the stages

- **Backlog:** Captured for triage; not yet committed to implementation.
- **Ready:** Scope, acceptance criteria, verification, priority, and owner are clear; blocking decisions are resolved.
- **In progress:** Implementation is underway on a feature branch with a linked draft PR.
- **Review:** The PR is ready for maintainer review and includes test evidence and risks.
- **Done:** Acceptance criteria are verified and the approved change is merged. If delivery includes deployment, confirm that separately before calling delivery complete.

Use a separate **Blocked** flag, keeping the current stage. Record the blocker, responsible person, and next action on the issue. Clear the flag when resolved.

Priorities:

- **P0:** Critical incident requiring immediate attention.
- **P1:** High priority; address before normal work.
- **P2:** Normal priority; the default for planned work.
- **P3:** Low priority; useful when higher-priority work permits.

When using a GitHub Project, use its Status, Priority, and Blocked fields for current planning. The form records initial values in the issue body; it does not automatically synchronize Project fields. Update fields explicitly during triage and whenever work changes. Without a Project, keep a short current status note in the issue body.

## Implement and review

1. Agree on the issue's scope and acceptance criteria before implementation.
2. Create a feature branch from the latest `master`, for example `feat/123-short-outcome` or `fix/123-short-outcome`. Do not commit directly to `master`.
3. Open a draft PR early and link the issue with `Closes #123` when the PR will fully resolve it. Use a non-closing reference for partial work.
4. Keep the diff focused. Record verification evidence, known gaps, risks, and deployment impact in the PR template.
5. Mark the PR ready for review only when it is reviewable. Address review findings and repeat affected checks after changes.
6. Obtain explicit maintainer approval before merging. An implementation request alone does not authorize merge or deployment.

## Verify the change

Use the commands and testing scope documented in [AGENTS.md](AGENTS.md). Current root commands include `npm run typecheck`, `npm test`, and `npm run build`. Run checks relevant to the change and record exact results. Explain any skipped checks; never describe an unrun check as passing.

For UI changes, include manual evidence for the affected flow and relevant failure, cancellation, and repeat-action cases. Follow the existing testing guidance for ownership isolation and external-service behavior. Do not use real credentials or private data in public evidence.

For documentation-only changes, inspect the final diff and links; for Issue forms, check YAML and GitHub form schema. Application tests may be marked not applicable with a reason.

## Merge and deployment are approval gates

`master` is the production branch with automatic deployment configured. Treat merging as potentially deploying, even when a provider's path filters may skip a documentation-only change. Review migrations, environment changes, rollout, and rollback before requesting approval.

These templates document the process; they do not enforce branch protection or automate approvals. Templates become available through GitHub's normal repository flow after they are merged into the default branch. After an approved merge of template changes, verify the New issue form and PR template render correctly.
