#!/usr/bin/env bash
# Adversyn Bridge — Claude Code agent invoker.
#
# Called by scripts/watch-agent-issues.mjs with the agent prompt on stdin
# and the worktree as cwd. Inherits these env vars:
#   ADVERSYN_AGENT     = "claude"
#   ADVERSYN_ISSUE     = issue number
#   ADVERSYN_BRANCH    = "agent/claude/<n>-<slug>"
#   ADVERSYN_WORKTREE  = absolute path to the worktree
#
# Contract: read prompt from stdin, do the work in cwd, commit but do not
# push. Exit 0 on success (the watcher checks `git log` regardless).
#
# Hard timeout is enforced by the watcher (SIGTERM after AGENT_TIMEOUT_MS),
# so we don't add another timeout here.

set -e
set -u

if ! command -v claude >/dev/null 2>&1; then
  echo "[claude.sh] claude CLI not on PATH" >&2
  exit 127
fi

# Read full prompt.
PROMPT="$(cat)"
if [ -z "$PROMPT" ]; then
  echo "[claude.sh] empty prompt on stdin — refusing" >&2
  exit 2
fi

echo "[claude.sh] starting claude in $PWD for issue #${ADVERSYN_ISSUE:-?}"
echo "[claude.sh] claude version: $(claude --version 2>/dev/null | head -1)"

# Headless / autonomous run.
#   --print              : emit final response and exit (non-interactive)
#   --dangerously-skip-permissions : required for autonomous file/edit access
# The watcher's worktree isolation + its prompt's forbidden-actions list
# are the safety boundaries. The CLI flag here only governs prompt-time
# tool approval.
exec claude \
  --print \
  --dangerously-skip-permissions \
  --append-system-prompt "You are inside a sandboxed git worktree. Stay inside it. Do not push. Commit your work with a clear message ending with 'Refs #${ADVERSYN_ISSUE}'." \
  -- "$PROMPT"
