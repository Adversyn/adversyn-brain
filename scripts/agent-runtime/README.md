# Agent runtime invokers

These are the seam between the watcher (`scripts/watch-agent-issues.mjs`)
and the actual CLI agents. The watcher creates a git worktree, builds the
prompt, and pipes the prompt to `agent-runtime/<agent>.sh` with the
worktree as `cwd`.

## Why a shell seam?

- Each CLI has its own non-interactive flags / sandbox flags / quirks.
  Encoding those in shell keeps the JS watcher portable.
- A shell script is the natural place to plug an alternative runtime
  later (e.g. claude-code-action via the API, Codex Cloud, etc.) without
  changing the watcher.
- Easy to test in isolation: `cat prompt.txt | bash claude.sh`.

## Contract

| Aspect | Spec |
| --- | --- |
| stdin | the full agent prompt (UTF-8) |
| cwd | a fresh git worktree on a `agent/<agent>/<n>-<slug>` branch |
| env | `ADVERSYN_AGENT`, `ADVERSYN_ISSUE`, `ADVERSYN_BRANCH`, `ADVERSYN_WORKTREE` |
| stdout/stderr | piped to `.bridge-state/agent-pickup/<n>-<ts>.log` (the watcher tails it for the report) |
| exit | the watcher checks `git log origin/main..HEAD` regardless of exit code |
| push | scripts MUST NOT push — the watcher pushes after verifying commits |

## Safety boundaries (in order)

1. **Worktree isolation** — `git worktree add <path>` confines all writes
   to that path. The watcher's own runtime tree is never touched.
2. **Watcher-enforced branch name regex** — only `agent/(claude|codex)/<n>-*`
   gets pushed.
3. **Prompt-encoded forbidden actions** — the watcher's prompt explicitly
   forbids editing `/home/ubuntu/adversyn-brain`, `/etc`, services,
   secrets, broker creds, live trading, force-push, etc. Both CLIs
   respect the prompt.
4. **Hard timeout** — `AGENT_TIMEOUT_MS` (default 15 min) enforced by
   the watcher (SIGTERM, then SIGKILL).
5. **Kill switch** — `AGENT_EXECUTION_ENABLED=false` skips invocation
   entirely (watcher just posts a "would pick up" comment).

## Editing these scripts

If you want to swap a runtime (e.g. point `claude.sh` at a remote API
endpoint instead of the local CLI), preserve the contract above and the
watcher will still work. Don't add `git push` here — that belongs to the
watcher.
