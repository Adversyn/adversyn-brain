#!/usr/bin/env bash
# Adversyn Bridge — Codex agent invoker.
#
# Called by scripts/watch-agent-issues.mjs with the agent prompt on stdin
# and the worktree as cwd. Inherits these env vars:
#   ADVERSYN_AGENT     = "codex"
#   ADVERSYN_ISSUE     = issue number
#   ADVERSYN_BRANCH    = "agent/codex/<n>-<slug>"
#   ADVERSYN_WORKTREE  = absolute path to the worktree
#
# Contract: read prompt from stdin, do the work in cwd, commit but do not
# push. Exit 0 on success.

set -e
set -u

if ! command -v codex >/dev/null 2>&1; then
  echo "[codex.sh] codex CLI not on PATH" >&2
  exit 127
fi

PROMPT="$(cat)"
if [ -z "$PROMPT" ]; then
  echo "[codex.sh] empty prompt on stdin — refusing" >&2
  exit 2
fi

echo "[codex.sh] starting codex in $PWD for issue #${ADVERSYN_ISSUE:-?}"
echo "[codex.sh] codex version: $(codex --version 2>/dev/null | head -1)"

# Headless / autonomous run.
#   exec                                   : non-interactive single run
#   --skip-git-check                       : we already know we're in a git worktree
#   --sandbox workspace-write              : only this worktree is writable
#   --ask-for-approval never               : autonomous approval (the watcher's
#                                            worktree isolation is the safety boundary)
exec codex exec \
  --skip-git-check \
  --sandbox workspace-write \
  --ask-for-approval never \
  --cd "$PWD" \
  -- "$PROMPT"
