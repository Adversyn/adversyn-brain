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

# Codex 0.128.0 non-interactive flags:
#   exec                       — non-interactive single run
#   --skip-git-repo-check      — accept that we are in a git worktree (worktrees
#                                are technically git repos, just non-standard layout)
#   --sandbox workspace-write  — file writes by model-issued shell commands are
#                                confined to PWD; THIS is our hard FS boundary
#   -c approval_policy=never   — never block on approval prompts; rely on the
#                                sandbox + the prompt's forbidden-actions list
#   --cd "$PWD"                 — anchor working dir to the worktree
#   --                         — end-of-flags marker before the prompt arg
exec codex exec   --skip-git-repo-check   --sandbox workspace-write   -c approval_policy=never   --cd "$PWD"   -- "$PROMPT"
