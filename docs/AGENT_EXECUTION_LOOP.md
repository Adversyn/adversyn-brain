# Agent Execution Loop

How Claude Code and Codex operate against GitHub issues in the Adversyn
autonomous bridge. Read this before running an agent against a labeled
issue.

## Pickup criteria

An agent acts on an issue **only** when all of these hold:

1. The issue carries the agent's lane label:
   - Claude Code: `agent:claude`
   - Codex: `agent:codex`
2. The issue carries a `task:*` label (`task:fix`, `task:qa`, `task:test`,
   `task:refactor`, `task:ci`, `task:deploy`, `task:docs`).
3. The issue does **not** carry `status:needs-human-approval` unless
   Darren has commented explicit approval.
4. The issue is not already labeled `status:in-progress` by the *other*
   agent (unless `multi-agent` is also set, in which case `primary:<self>`
   must be present).

If any condition fails, the agent **does not act**.

## Step-by-step loop

```
1. Read issue #N. Confirm labels.
2. node scripts/create-agent-branch.mjs --agent <self> --issue N --slug <kebab-slug>
3. Implement the change. Commit incrementally. Never commit .env / secrets.
4. Open PR (gh pr create --fill, or via GitHub UI).
5. node scripts/link-pr-to-issue.mjs --pr <pr> --issue N
   → adds 'Closes #N' if missing, sets status:in-progress, drops stale status:* labels
6. node scripts/post-agent-report.mjs --target pr --number <pr> \
        --agent <self> --status PASS|FAIL|BLOCKED \
        --summary "..." --files-changed "a,b" --tests-run "..." \
        --qa-impact "..." --risks "..." --next "..."
7. Wait for CI. If green:
     - apply 'status:ready-for-review' (gh issue edit)
   If red:
     - apply 'status:failed', read the Autonomous QA Report comment, plan a fix
   If blocked (cannot proceed without human input):
     - apply 'status:blocked', explain in a comment
```

Concrete examples:

```bash
node scripts/create-agent-branch.mjs --agent codex --issue 17 --slug formatpercent-tests
# (you commit, push, open a PR — say PR #18)
node scripts/link-pr-to-issue.mjs --pr 18 --issue 17
node scripts/post-agent-report.mjs --target pr --number 18 --agent codex \
  --status PASS \
  --summary "Added regression test for formatPercent zero handling; one-line fix in marketPulseFormatters.ts." \
  --files-changed "marketPulseFormatters.ts,tests/formatPercent.test.ts" \
  --tests-run "npm ci, npm test" \
  --qa-impact "1 test added, no Playwright impact" \
  --risks "low" \
  --next "merge"
```

## Commit / branch conventions

- Branch: `agent/<agent>/<issue>-<slug>` (enforced by `create-agent-branch.mjs`)
- Slug regex: `[a-z0-9][a-z0-9-]{2,60}`
- Commit message: imperative, body explains *why*, includes `Refs #<issue>`
- Never commit `.env`, secrets, generated artifacts, or `node_modules/`
- Never use `--no-verify` or `--no-gpg-sign`

## Single-agent invariant

- Two agents must not both push to the same branch unless `multi-agent`
  is on the issue.
- Multi-agent collaboration uses a `HANDOFF` comment to switch ownership
  (see `docs/AUTONOMOUS_GITHUB_BRIDGE.md`).

## Human-approval gate

Issues labeled `status:needs-human-approval` are frozen for agents.
Approval = Darren posts a comment containing the literal phrase
**`APPROVED FOR EXECUTION`** (case-insensitive). Once seen, the agent
removes the label and proceeds. Until then, the agent only updates the
issue with a comment confirming it is waiting.

Auto-applied to: any task with `requires_human_approval: true`, or any
`task:deploy`. Agents must self-apply this label to:

- destructive file ops outside repo scope
- production deploys
- service restarts (systemd / docker / pm2)
- DB migrations
- secrets changes
- firewall / nginx / systemd / cron changes
- broker credential changes
- live trading actions / order placement / force-close

## Blocked / failed / passed semantics

| Label | Set by | Meaning |
| --- | --- | --- |
| `status:in-progress` | Agent (via `link-pr-to-issue.mjs`) | Active work |
| `status:ready-for-review` | Agent on green CI | Nova / Darren can review |
| `status:passed` | `pr-report.yml` after green CI | Autonomous QA passed |
| `status:failed` | `pr-report.yml` after red CI | Autonomous QA failed |
| `status:blocked` | Agent | Cannot proceed without human input |
| `status:needs-human-approval` | Intake script or self | Frozen pending Darren |

The Darren report watcher subscribes to all five status labels and
regenerates the final report when any of them flips.

## Agent execution report

Always post one. Format is canonical — see `docs/CODEX_AGENT_RULES.md`
for Codex (also reused by Claude when posting). The
[`scripts/post-agent-report.mjs`](../scripts/post-agent-report.mjs)
helper enforces the structure.

The agent report covers what *the agent did*. It is distinct from the
*Autonomous QA Report* (which covers what CI / Playwright did), and from
the *Darren final report* (which aggregates everything for Darren).

## Failure modes the agent must self-detect

- "I am about to edit secrets / production config" → label
  `status:needs-human-approval`, comment, stop.
- "Tests don't exist for the contract I'm changing" → comment to Nova
  asking for clarification, label `status:blocked`, stop.
- "I cannot run a listed command (tool missing)" → comment with the
  missing tool, label `status:blocked`, stop.
- "I am being asked to revert another agent's commit" → comment, do
  nothing until Nova directs.
