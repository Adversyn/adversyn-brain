# Adversyn Autonomous GitHub Bridge

**Goal:** remove Darren as the manual copy/paste bridge. All implementation,
QA, deploy reports, screenshots, logs, and next-step summaries live in
GitHub Issues, PRs, Actions artifacts, and PR comments.

## Roles

| Role | Who | What they do |
| --- | --- | --- |
| PM / prompt architect | Nova (ChatGPT) | Writes Issues, sets labels, reviews PR comments, decides next step |
| Implementation agent (large) | Claude Code | Architecture, refactors, complex debugging, full-feature implementations |
| Implementation agent (focused) | Codex | Small scoped patches, test additions, CI fixes |
| Build / deploy / QA runner | GitHub Actions + Playwright | Runs every PR; uploads artifacts; posts a PR comment |
| Source of truth | GitHub | Issues, PRs, comments, labels, artifacts |
| Human approver | Darren | Only for `status:needs-human-approval` items |

## End-to-end workflow

```
Nova writes Issue   ─►   labels select agent + lane
                          │
                          ▼
                Agent (Claude Code or Codex)
                          │
                ┌─────────┴────────────┐
                ▼                      ▼
       creates feature branch   commits implementation
                          │
                          ▼
                     opens PR
                          │
                          ▼
              GitHub Actions CI runs:
                lint / typecheck / test / build
                Playwright autonomous QA
                          │
                          ▼
        scripts/generate-qa-report.mjs → qa-report.md
                          │
                          ▼
        .github/workflows/pr-report.yml posts comment
                          │
                          ▼
                 Nova reviews PR comment
                          │
                          ▼
                 Nova writes next Issue
```

## Label contract

### Agent lanes
- `agent:claude` — Claude Code
- `agent:codex` — Codex
- `primary:claude` / `primary:codex` — disambiguator when both are tagged
- `multi-agent` — explicit collaboration

### Task types
- `task:fix`, `task:test`, `task:refactor`, `task:ci`, `task:qa`, `task:deploy`

### Priority
- `priority:high`

### Status
- `status:in-progress`, `status:blocked`
- `status:ready-for-review`
- `status:passed`, `status:failed`
- `status:needs-nova-review`
- `status:needs-human-approval`

The full label set is canonical in [`.github/labels.yml`](../.github/labels.yml)
and synced by `.github/workflows/labels-sync.yml`.

## Routing rules

1. Issues with `agent:claude` are for Claude Code.
2. Issues with `agent:codex` are for Codex.
3. Issues with **both** must also carry exactly one `primary:claude` or
   `primary:codex` — the primary owns the PR, the other comments only.
4. Issues with **no** agent label are not actioned by any agent.
5. Tasks that are destructive, production-impacting, secrets-related,
   deployment-related, DB-migration-related, trading/live-money-related,
   or service-restart-related **must** carry `status:needs-human-approval`.
   Agents must wait for Darren's explicit approval comment before acting.
6. An agent must not work on an issue already labeled `status:in-progress`
   by the *other* agent without `multi-agent`.

## How to choose the correct agent

| Trait | Claude Code | Codex |
| --- | --- | --- |
| Scope | Multiple files / cross-cutting | Single file / single module |
| Decisions | Architectural / design tradeoffs | Mechanical / mostly determined |
| Time budget | Hours | Minutes |
| Test surface | New flows, integration tests | Targeted unit/regression tests |
| Risk | Higher — cross-system effects | Lower — bounded change |

If unclear, default to Claude Code.

## Multi-agent handoff rules

- Use `multi-agent` when one agent prepares scaffolding and the other completes
  the patch. The first agent leaves a PR comment titled **HANDOFF** with:
  what is done, what remains, where to start, what tests still need to pass.
- The second agent **must** push to the same branch and update the same PR.
- Both agents must avoid simultaneously editing the same file. Use draft PR
  status and `status:in-progress` to signal active editing.

## Conflict prevention

- Each agent assigns itself the issue before starting, sets `status:in-progress`,
  and removes the label when it finishes (success, blocked, or fail).
- If an agent finds another agent already on the issue without `multi-agent`,
  it must stop and post a comment to Nova requesting guidance.
- Agents must rebase, never force-push to `main`. Force-push to a feature
  branch is allowed only if the agent owns it.

## Required label examples

### Claude task
```
agent:claude  task:refactor  priority:high  status:in-progress
```

### Codex task
```
agent:codex  task:test
```

### QA-only task
```
task:qa  status:needs-nova-review
```

### Production deploy
```
agent:claude  task:deploy  status:needs-human-approval  priority:high
```

## Issue-to-PR workflow (per agent)

1. Read the issue. Confirm it has the right labels.
2. Add `status:in-progress`, assign yourself.
3. Create a feature branch named `agent/<agent>/<issue-number>-<slug>`.
4. Commit incrementally. Never commit `.env`, secrets, or credentials.
5. Open a PR using `.github/pull_request_template.md`. Link the issue with
   `Closes #N`.
6. CI runs automatically. If Playwright is configured, the workflow fails
   the PR if QA fails.
7. After CI completes, `pr-report.yml` posts the **Autonomous QA Report**
   comment and applies `status:passed` or `status:failed`.
8. Apply `status:ready-for-review` when satisfied. Nova reviews.

## QA workflow

- The Playwright spec at
  [`tests/e2e/autonomous-site-qa.spec.ts`](../tests/e2e/autonomous-site-qa.spec.ts)
  walks every nav route, clicks every safe button, modifies every safe input,
  verifies persistence after save+reload, and screenshots every major page.
- Destructive tokens are skipped unconditionally:
  `delete`, `remove`, `force-close`, `liquidate`, `live-trade`,
  `execute-live`, `reset`, `wipe`, `purge` — plus auth/order placement tokens.
- Login is opt-in via `QA_USERNAME` / `QA_PASSWORD`; otherwise `QA_SKIP_LOGIN=true`.
- Artifacts uploaded by CI: `playwright-report/`, `test-results/`, `qa-report.md`.

## Deployment workflow

- A deploy task **must** carry `task:deploy` and `status:needs-human-approval`.
- Deploys are not triggered automatically. Once Darren approves with an
  explicit comment, the agent may run the deploy script in a separate run.
- All production deploys must reference a green CI run with passing
  Playwright autonomous QA.
- Failed QA blocks merge — the CI workflow fails the PR if Playwright fails.

## PR comment protocol

Every PR receives one **Autonomous QA Report** comment, edited in place by
`.github/workflows/pr-report.yml`. It contains:

- Build status, test status, Playwright status
- Artifact links (Playwright HTML report, screenshots, qa-report.md)
- A human-readable summary
- A suggested next action

Codex additionally posts a **CODEX EXECUTION REPORT** comment per
[`docs/CODEX_AGENT_RULES.md`](./CODEX_AGENT_RULES.md).

## Safety rules (hard constraints)

- Never run live trading actions during QA.
- Never click destructive buttons in autonomous tests.
- Never expose secrets in logs.
- Never commit `.env` files.
- Never hardcode credentials.
- All production deploys must pass CI and Playwright QA.
- Failed QA blocks merge.
- `status:needs-human-approval` blocks any action until Darren comments approval.

## How Nova reviews GitHub outputs

1. Open the PR.
2. Read the **Autonomous QA Report** comment first — that is the single source
   of truth for the run.
3. If `status:passed`, sanity-check the diff and decide whether to merge or
   request follow-up.
4. If `status:failed`, write a follow-up Issue (or comment on the existing one)
   pointing to the failure and the preferred fix path. Apply the right labels
   to route to the right agent.

## How Darren stops being the manual bridge

- Darren only intervenes when a label says he must:
  `status:needs-human-approval`.
- Everything else — implementation, QA, screenshots, logs, summaries —
  flows through GitHub.
- If Darren finds himself manually relaying a result, that is a bug in this
  bridge. File an issue tagged `task:ci` to fix it.

## Required repository settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `APP_BASE_URL` | Variable or Secret | URL the Playwright QA hits |
| `QA_USERNAME` | Secret | Optional QA login user |
| `QA_PASSWORD` | Secret | Optional QA login pass |
| `QA_AUTH_MODE` | Variable | `none`, `basic`, or `form` |
| `QA_SKIP_LOGIN` | Variable | `true` to skip login entirely |
| Any deploy secrets | Secret | Used only by deploy jobs you add later |

## Troubleshooting

- **CI didn't run Playwright.** Check `playwright.config.ts` exists and is
  committed. Check `package.json` has `@playwright/test` in `devDependencies`.
- **PR comment didn't appear.** Check the `pr-report.yml` workflow run; it
  triggers on `workflow_run` after CI completes. The PR must be from the
  same repo (forks need a different flow).
- **Labels missing.** Trigger `labels-sync.yml` manually via *Actions →
  Sync labels → Run workflow*.
- **Login broken.** Verify `QA_USERNAME` / `QA_PASSWORD` are set as
  **Secrets**, not Variables. Verify `QA_AUTH_MODE=form`.
- **404 on every route.** Verify `APP_BASE_URL` is reachable from GitHub
  runners (the URL must be public or behind a self-hosted runner).
- **Playwright passes but no comment.** The CI workflow uploads the
  `qa-report` artifact; if `pr-report.yml` can't download it, the comment
  falls back to a generic message. Check artifact retention and run permissions.
