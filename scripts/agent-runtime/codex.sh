#!/usr/bin/env bash
# Adversyn Bridge — Codex agent invoker.
#
# Called by scripts/watch-agent-issues.mjs with the agent prompt on stdin
# and the worktree as cwd. Inherits these env vars:
#   ADVERSYN_AGENT     = "codex"
#   ADVERSYN_ISSUE     = issue number
#   ADVERSYN_BRANCH    = "agent/codex/<n>-<slug>"
#   ADVERSYN_WORKTREE  = absolute path to the worktree

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

# Codex 0.128.0 invocation, hardened for our environment:
#
#   --dangerously-bypass-approvals-and-sandbox
#       This AWS Ubuntu host (linux-aws 6.17, apparmor_restrict_unprivileged_userns=1)
#       blocks bubblewrap from setting up user namespaces. Both vendored and
#       system bwrap fail with 'setting up uid map: Permission denied' /
#       'loopback: Failed RTM_NEWADDR: Operation not permitted'. Without
#       bypass, codex cannot run any local commands at all and exits BLOCKED
#       before reading the worktree.
#
#       SAFETY: the bypass disables codex's internal sandbox, but our outer
#       safety boundaries are still in place:
#         - watcher confines work to a fresh git worktree under
#           .bridge-state/agent-work/<repo>/issue-<n>
#         - watcher only pushes branches matching agent/(claude|codex)/<n>-*
#         - 15-min hard timeout (SIGTERM, then SIGKILL)
#         - forbidden_paths and forbidden_commands are encoded in the prompt
#           (read by codex from stdin)
#         - watcher inspects diffs before pushing; if the agent touches a
#           forbidden path the next layer (Darren review on PR) catches it
#
#   --skip-git-repo-check  — accept being inside a worktree (non-standard layout)
#   --cd "$PWD"           — anchor working dir to the worktree
#   --                     — end-of-flags before the prompt argument
exec codex exec   --dangerously-bypass-approvals-and-sandbox   --skip-git-repo-check   --cd "$PWD"   -- "$PROMPT"
