# `pm:submit` — Plain-English task intake

Darren describes the problem in plain English on the EC2 host; the bridge picks the right repo, classifies the agent lane, builds a valid Nova task, and creates the GitHub issue. **No JSON, no PowerShell, no local files.**

## Usage

```bash
ssh ubuntu@18.190.151.128
cd /home/ubuntu/adversyn-bridge

npm run pm:submit -- \
  --problem "Console Debate opens at bottom instead of top" \
  --where "left sidebar Console Debate page on trading UI" \
  --expected "page opens at top" \
  --priority high \
  --repo auto
```

Output (truncated):

```json
{ "ok": true, "classified": { "repo": "Adversyn/Adversyn-Trading", ... } }
{ "ok": true, "mode": "direct-issue", "issue_url": "https://github.com/...", "number": 12, "labels": [...] }
```

## Flags

| Flag | Required | Default | What it does |
| --- | --- | --- | --- |
| `--problem` | yes | — | Plain-English description of what's broken |
| `--where` | recommended | — | UI location, route, file area, or service |
| `--expected` | yes | — | One-line statement of desired behavior |
| `--priority` | no | `normal` | `low` / `normal` / `high` |
| `--repo` | no | `auto` | `auto` (resolve from text) / `bridge` / `frontend` / `<owner/name>` |
| `--approval-needed` | no | `false` | Force `requires_human_approval=true`. Auto-detected from risky keywords (deploy, secret, broker, restart, live trading, …) |
| `--dry-run` | no | — | Print classified task as JSON; no issue created |
| `--to-inbox` | no | — | Write to `nova-inbox/*.json` instead of creating directly (lets `pm:watch` handle it asynchronously) |

## Classification logic

- **Repo selection** (`--repo auto`): scores each registered repo against the input text using `app_url`, `service_name`, `name`, and domain hints. Trading UI is favored by `8888 / /trading/ / console debate / vite / frontend`. Bridge is favored by `bridge / watcher / inbox / Darren report / pm:watch / nova task / schema`.
- **Agent lane**: codex for short focused fixes/tests/typos; claude for refactors/multi-file/architecture; qa-only for verify/audit/baseline. Long descriptions (>600 chars) are promoted to claude.
- **Risky keywords trigger `requires_human_approval=true`**: `deploy / production / release / rollback / migration / database / secret / credential / broker / restart / systemd / live trading / force-close / liquidate`. The intake adds the `status:needs-human-approval` label automatically.

## Repo registry

`repos/*.json`. Each file describes one managed repo:

- `full_name` — `<owner>/<repo>` on GitHub
- `local_path` — EC2 path to the agent's working clone
- `allow_agent_execution` — gates the agent pickup loop
- `allow_npm_build_on_ec2`, `allow_npm_install_on_ec2` — production-host safety flags
- `forbidden_paths`, `forbidden_commands` — injected into the agent prompt

To add a third repo, drop another `repos/<name>.json` and (on EC2) `git clone` it into the configured `local_path`. The watchers pick it up on the next tick.

## Why direct issue creation is the default

`--to-inbox` is supported but `pm:submit` defaults to creating the GitHub issue directly. Synchronous output (issue URL printed immediately) is more useful than waiting for a watcher tick, and the task JSON is sent to the same intake script (`create-github-issue-from-nova.mjs`) under the hood, so safety / label rules are identical.
