# Nova PM Autonomous Workflow

This document is the operational runbook for the Adversyn autonomous loop.
The goal: **Darren never has to copy/paste between ChatGPT and GitHub**.

## End-to-end flow

```
Darren ─► Nova ─► Nova writes JSON task ─► nova-inbox/
                                            │
                                            ▼
                                  watch-nova-inbox.mjs
                                            │
                                            ▼  (REST or gh CLI)
                                  GitHub issue with labels
                                            │
                                            ▼
                              Claude Code or Codex picks up
                              by label, assigns itself,
                              creates branch, commits, opens PR
                                            │
                                            ▼
                                 GitHub Actions: CI + Playwright
                                            │
                                            ▼
                              pr-report.yml posts Autonomous QA Report
                                            │
                                            ▼
                          watch-github-results-for-darren.mjs sees
                          a status: label change, calls
                          review-github-task-for-darren.mjs
                                            │
                                            ▼
                              reports/darren-final-report-<n>.md
                              (optionally posted as a PR comment)
                                            │
                                            ▼
                                       Darren reads
                                  ONE plain-English file
```

## How Darren gives Nova an objective

Plain English. *"Nova, fix the MarketPulse persistence on the trading dashboard. High priority. No prod deploys."*

That's it. Nova translates this into a JSON task using the schema below.

## How Nova creates a JSON task

Nova writes a file conforming to [`schemas/nova_task.schema.json`](../schemas/nova_task.schema.json) and drops it into `nova-inbox/`.

Required fields:

| Field | Notes |
| --- | --- |
| `title` | Short imperative — becomes the GitHub issue title |
| `agent_lane` | `claude` / `codex` / `qa-only` / `multi-agent` |
| `task_type` | `fix` / `qa` / `deploy` / `test` / `refactor` / `ci` / `docs` |
| `context` | Background |
| `problem` | What's broken / missing |
| `expected_behavior` | What should happen |
| `acceptance_criteria` | At least one bullet |
| `report_back_to` | Always `"Darren"` |
| `final_report_required` | Always `true` |

Optional but useful: `current_behavior`, `affected_routes`, `affected_files`,
`qa_requirements`, `forbidden_actions`, `requires_human_approval`,
`source`, `created_by`, `priority`.

See `examples/nova-task-claude.json`, `examples/nova-task-codex.json`,
`examples/nova-task-qa.json`.

### Multi-agent: when both Claude and Codex collaborate

Set `agent_lane: "multi-agent"` and `primary_agent: "claude" | "codex"`.
The intake adds three labels (`agent:claude`, `agent:codex`, `multi-agent`)
plus the `primary:<agent>` disambiguator. The primary owns the PR; the
other comments only.

## How the task becomes a GitHub issue

Two entry points:

### Direct (one-shot)

```bash
# Validate only — no GitHub call:
npm run pm:create-issue -- examples/nova-task-codex.json --dry-run

# Real:
npm run pm:create-issue -- nova-inbox/some-task.json
```

The intake script ([`scripts/create-github-issue-from-nova.mjs`](../scripts/create-github-issue-from-nova.mjs)):

1. Loads + validates JSON against the schema.
2. Maps fields to labels (see *Label mapping* below).
3. Builds a clean Markdown issue body.
4. Creates the issue via `gh` CLI if available, or via the REST API
   using `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`.
5. Prints `{ ok, issue_url, number, labels }` JSON to stdout.

### Watcher (recommended)

```bash
# One-shot (cron / CI):
npm run pm:watch:once

# Continuous (5s poll):
npm run pm:watch

# Continuous, custom interval:
node scripts/watch-nova-inbox.mjs --watch --interval 30
```

The watcher ([`scripts/watch-nova-inbox.mjs`](../scripts/watch-nova-inbox.mjs)):

- Watches `nova-inbox/*.json` (skips `.gitkeep`).
- Calls the intake script for each file.
- Moves successful files to `nova-inbox/processed/`.
- Moves failed files to `nova-inbox/failed/`.
- Appends a result line to `nova-inbox/log.ndjson`.
- Stop with `Ctrl+C` (`SIGINT`) — handlers flush and exit cleanly.

### Label mapping

| Task field | Labels added |
| --- | --- |
| `agent_lane = claude` | `agent:claude` |
| `agent_lane = codex` | `agent:codex` |
| `agent_lane = multi-agent` | `agent:claude`, `agent:codex`, `multi-agent`, `primary:<agent>` |
| `agent_lane = qa-only` | (none — humans / scheduled QA) |
| `task_type = X` | `task:<X>` |
| `priority = high` | `priority:high` |
| `requires_human_approval = true` OR `task_type = deploy` | `status:needs-human-approval` |

## How Claude/Codex executes

See [`AGENT_EXECUTION_LOOP.md`](./AGENT_EXECUTION_LOOP.md). Short version:
agents pick up issues by label, run [`create-agent-branch.mjs`](../scripts/create-agent-branch.mjs),
commit, open PR via `gh pr create`, run
[`link-pr-to-issue.mjs`](../scripts/link-pr-to-issue.mjs) to wire `Closes #N`
and flip the issue to `status:in-progress`, and post a
[`post-agent-report.mjs`](../scripts/post-agent-report.mjs) comment.

## How GitHub Actions validates

Existing CI (`.github/workflows/ci.yml`) installs deps, runs lint /
typecheck / test / build (each `--if-present`), installs Playwright, runs
`tests/e2e/autonomous-site-qa.spec.ts`, generates `qa-report.md`, uploads
artifacts, fails the PR on failure. `pr-report.yml` posts/updates the
*Autonomous QA Report* PR comment.

## How Darren final reports are generated

Two entry points:

### On demand

```bash
node scripts/review-github-task-for-darren.mjs --issue 12
node scripts/review-github-task-for-darren.mjs --pr 5 --post
```

Writes `reports/darren-final-report-<n>.md`.

### Continuously

```bash
# One-shot:
npm run pm:watch-results:once

# Continuous (60s poll):
npm run pm:watch-results

# With auto-post back to the issue:
node scripts/watch-github-results-for-darren.mjs --watch --post
```

State is tracked in `.bridge-state/issues.json`. The watcher only
regenerates a report when an issue's `updated_at` or label set changes —
no spam.

## How to run watchers

| Mode | Command | When |
| --- | --- | --- |
| Inbox one-shot | `npm run pm:watch:once` | Each cron tick / CI invocation |
| Inbox continuous | `npm run pm:watch` | Long-running on Darren's box |
| Results one-shot | `npm run pm:watch-results:once` | Each cron tick |
| Results continuous | `npm run pm:watch-results` | Long-running |

Recommended: run continuously in a Windows terminal that you can leave
open, OR schedule the `:once` variants every 1–5 minutes via Task Scheduler.

## How to stop watchers

`Ctrl+C` (`SIGINT`) at the terminal. Both watchers register `SIGINT` /
`SIGTERM` handlers and exit cleanly with a final log entry.

## How to recover failed tasks

Failed task JSONs land in `nova-inbox/failed/` with a `.failed.json`
suffix. To retry:

1. Read the matching log line in `nova-inbox/log.ndjson` for the error.
2. Edit the JSON if needed.
3. Move (or copy) the file back to `nova-inbox/`.
4. The next watcher tick picks it up.

## How to handle approval-required tasks

When a task has `requires_human_approval: true` (or `task_type: deploy`),
the intake adds `status:needs-human-approval`. **Agents do not act on
issues with that label** — see [`AGENT_EXECUTION_LOOP.md`](./AGENT_EXECUTION_LOOP.md).
Darren approves with a comment on the issue, then removes the label.

## How to avoid manual copy/paste

- Nova writes JSON → drops in `nova-inbox/`. Done.
- Watchers handle issue creation, status sync, and report generation.
- Darren reads `reports/darren-final-report-<n>.md` (or the auto-posted
  comment) — that file aggregates issue, PR, files changed, CI, Playwright
  result, blockers, and the next action.

If Darren ever finds himself manually relaying GitHub state to Nova or
vice-versa, **that is a bug in this bridge**. File an issue with
`task:ci` and we extend the watchers.
