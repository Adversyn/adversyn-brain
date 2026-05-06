#!/usr/bin/env node
/**
 * Adversyn Autonomous Bridge — agent pickup loop.
 *
 * Polls GitHub for issues labeled agent:claude or agent:codex with a
 * task:* label, applies pickup eligibility rules, locks the issue with
 * status:in-progress, creates a feature branch in an isolated git
 * worktree under .bridge-state/agent-work/issue-<n>, optionally invokes
 * the configured agent CLI, and on success pushes the branch + opens
 * the PR. Posts a CLAUDE/CODEX EXECUTION REPORT comment.
 *
 * SAFETY:
 *   - Per-task working dir is a `git worktree`, not the live runtime tree
 *     (the watcher's own runtime stays untouched).
 *   - Agent invocation is gated on AGENT_EXECUTION_ENABLED=true. With the
 *     flag off (default), the watcher ONLY detects + posts a "would pick
 *     up" comment. This is the kill switch.
 *   - Per-issue concurrency: at most one in-flight pickup at a time
 *     (configurable via AGENT_MAX_CONCURRENT, default 1).
 *   - Hard timeout per agent process (AGENT_TIMEOUT_MS, default 15 min).
 *   - Watcher only pushes branches matching agent/(claude|codex)/<n>-* .
 *   - status:needs-human-approval blocks pickup unless an approval
 *     comment containing "APPROVED FOR EXECUTION" was posted by a user
 *     with write access (author_association in {OWNER, MEMBER, COLLABORATOR}).
 *
 * Usage:
 *   node scripts/watch-agent-issues.mjs              # one-shot
 *   node scripts/watch-agent-issues.mjs --watch      # continuous (60s)
 *   node scripts/watch-agent-issues.mjs --watch --interval 30
 *   node scripts/watch-agent-issues.mjs --dry-run    # detect only, no GitHub writes
 *
 * Auth: GITHUB_TOKEN env or `gh auth token`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveRepo, resolveToken,
  listIssuesByLabel, getIssue, listIssueComments,
  postIssueComment, addLabels, removeLabel,
} from './lib/github-api.mjs';
import { ghAvailable, ghAuthOK, ghRun } from './lib/gh-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, '.bridge-state', 'agent-pickup');
const WORK_ROOT = path.join(ROOT, '.bridge-state', 'agent-work');
const LOG_FILE  = path.join(ROOT, '.bridge-state', 'agent-watcher.ndjson');
const RUNTIME_DIR = path.join(HERE, 'agent-runtime');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const dryRun = args.includes('--dry-run');
const intervalArg = args.indexOf('--interval');
const intervalSec = intervalArg >= 0 ? parseInt(args[intervalArg + 1], 10) : 60;

// Tunables (env-driven).
const EXECUTION_ENABLED = (process.env.AGENT_EXECUTION_ENABLED || '').toLowerCase() === 'true';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.AGENT_MAX_CONCURRENT || '1', 10));
const TIMEOUT_MS = Math.max(60_000, parseInt(process.env.AGENT_TIMEOUT_MS || `${15 * 60 * 1000}`, 10));
const APPROVAL_PHRASE = /APPROVED\s+FOR\s+EXECUTION/i;

const TASK_LABELS = new Set([
  'task:fix', 'task:test', 'task:ci', 'task:qa', 'task:refactor', 'task:docs',
]);

const SKIP_STATUS = new Set([
  'status:in-progress', 'status:passed', 'status:failed',
  'status:blocked', 'status:ready-for-review',
]);

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(WORK_ROOT, { recursive: true });
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
function logLine(o) { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', 'utf8'); }
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// ---------------- helpers --------------------------------------------------

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
}

function makeSlug(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    || 'task';
}

function gitInWorktree(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  return { ok: r.status === 0, code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function decideAgent(labels) {
  const set = new Set(labels);
  const hasClaude = set.has('agent:claude');
  const hasCodex = set.has('agent:codex');
  if (hasClaude && hasCodex) {
    if (set.has('primary:claude')) return 'claude';
    if (set.has('primary:codex'))  return 'codex';
    return null; // both lanes, no primary — refuse
  }
  if (hasClaude) return 'claude';
  if (hasCodex) return 'codex';
  return null;
}

function pickTaskLabel(labels) {
  for (const l of labels) if (TASK_LABELS.has(l)) return l;
  return null;
}

async function approvalPresent({ owner, repo, number }) {
  const c = await listIssueComments({ owner, repo, number });
  if (!c.ok) return false;
  for (const cm of c.body || []) {
    if (typeof cm.body !== 'string') continue;
    if (!APPROVAL_PHRASE.test(cm.body)) continue;
    const aa = cm.author_association || 'NONE';
    if (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(aa)) return true;
  }
  return false;
}

function activePickupCount() {
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
  let active = 0;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
      if (s.state === 'in_progress') active++;
    } catch { /* ignore */ }
  }
  return active;
}

function savePickupState(num, state) {
  fs.writeFileSync(path.join(STATE_DIR, `${num}.json`), JSON.stringify(state, null, 2), 'utf8');
}

function loadPickupState(num) {
  const p = path.join(STATE_DIR, `${num}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ---------------- runtime detection ----------------------------------------

function detectRuntime(agent) {
  const script = path.join(RUNTIME_DIR, `${agent}.sh`);
  if (!fs.existsSync(script)) {
    return { ok: false, error: `runtime script missing: ${script}` };
  }
  const cli = agent === 'claude' ? 'claude' : 'codex';
  const r = spawnSync('bash', ['-c', `command -v ${cli}`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) {
    return { ok: false, error: `${cli} CLI not on PATH` };
  }
  const ver = spawnSync(cli, ['--version'], { encoding: 'utf8' });
  return {
    ok: true,
    cli_path: r.stdout.trim(),
    cli_version: (ver.stdout || '').trim().split('\n')[0] || '(unknown)',
    runtime_script: script,
  };
}

// ---------------- prompt assembly ------------------------------------------

function buildAgentPrompt({ agent, issue, worktree, branch }) {
  return `You are the ${agent} agent for the Adversyn autonomous GitHub bridge.

You are working on issue #${issue.number} in repo Adversyn/adversyn-brain.

Repository working directory: ${worktree}
Branch (already checked out): ${branch}
Repository on disk: this is the bridge repo (autonomous-workflow tooling),
NOT the production execution-integration codebase. The production codebase
lives at /home/ubuntu/adversyn-brain on this server and you MUST NOT touch it.

ISSUE TITLE
${issue.title}

ISSUE BODY
${issue.body || '(empty)'}

YOUR JOB
1. Read the acceptance criteria carefully.
2. Implement the change inside ${worktree} only.
3. Run the project's tests / lint / typecheck / build where applicable
   (npm scripts: qa:e2e, qa:report; node --check; node --test if present).
4. Commit each logical change with a clear message ending with
   "Refs #${issue.number}".
5. Do NOT push the branch — the watcher will push and open the PR.
6. Do NOT delete this directory or its parent.
7. If you cannot proceed (ambiguous, missing context, would require
   editing files outside this directory, would require a forbidden
   action), exit immediately without committing. The watcher will read
   git log; if it finds zero new commits it posts BLOCKED.

FORBIDDEN ACTIONS (hard stop — never do these)
- Editing files outside ${worktree}
- Editing /home/ubuntu/adversyn-brain (different repo, runs production)
- Touching /etc, systemd units, or any service config
- Restarting any service
- Running live trading actions, order placement, force-close, liquidate
- Editing broker credentials or any secrets / .env files
- Running database migrations
- Modifying GitHub Actions workflows in a way that disables CI
- Force-pushing or rewriting history
- Calling 'gh' to merge PRs, close other issues, or post anywhere except
  this issue / the PR you create

REPORTING
When you finish, the watcher reads:
  - git log between origin/main..HEAD
  - git diff --stat origin/main..HEAD
and posts a ${agent.toUpperCase()} EXECUTION REPORT comment summarizing your work.
You don't need to post comments yourself.

Begin.`;
}

// ---------------- main per-issue pickup ------------------------------------

async function pickupOne({ owner, repo, issue }) {
  const number = issue.number;
  const labels = labelNames(issue);
  const agent = decideAgent(labels);
  const taskLabel = pickTaskLabel(labels);
  if (!agent || !taskLabel) return { skipped: 'missing agent/task label combination' };

  const skipReason = [...SKIP_STATUS].find((s) => labels.includes(s));
  if (skipReason) return { skipped: `already ${skipReason}` };

  if (labels.includes('status:needs-human-approval')) {
    const ok = await approvalPresent({ owner, repo, number });
    if (!ok) return { skipped: 'awaiting APPROVED FOR EXECUTION comment' };
  }

  if (issue.state !== 'open' && issue.state !== 'OPEN') return { skipped: 'issue not open' };
  if (issue.pull_request) return { skipped: 'this is a PR, not an issue' };

  // Check cap.
  if (activePickupCount() >= MAX_CONCURRENT) {
    return { skipped: `concurrency cap reached (${MAX_CONCURRENT})` };
  }

  // Check runtime.
  const runtime = detectRuntime(agent);
  if (!runtime.ok) {
    if (!dryRun) {
      await postIssueComment({ owner, repo, number, body:
        `## ${agent.toUpperCase()} EXECUTION REPORT\n\n**Status:** BLOCKED\n\n` +
        `**Summary:** Agent runtime not available on the EC2 bridge.\n\n` +
        `**Missing:** ${runtime.error}\n\n` +
        `**Next action:** Install / configure the runtime, then either re-run the watcher or wait for the next poll cycle.\n\n` +
        `_Posted by adversyn-bridge-agent-watch.service._`
      });
      await addLabels({ owner, repo, number, labels: ['status:blocked'] });
    }
    return { acted: 'blocked-runtime-missing', runtime_error: runtime.error };
  }

  const slug = makeSlug(issue.title);
  const branch = `agent/${agent}/${number}-${slug}`;
  const worktree = path.join(WORK_ROOT, `issue-${number}`);

  if (!EXECUTION_ENABLED) {
    // Detection-only mode. We do NOT claim status:in-progress (that would
    // cause the watcher to skip the issue once execution is enabled), and
    // we deduplicate the report comment by tracking last_reported_at in
    // the per-issue state file. Without dedupe, a 60s poll would spam the
    // issue every minute.
    const prior = loadPickupState(number);
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const recentlyReported = prior && prior.state === 'gated' && prior.last_reported_at
      && (Date.now() - new Date(prior.last_reported_at).getTime() < SIX_HOURS_MS);
    if (recentlyReported) {
      return { acted: 'gated-already-reported', agent, branch, last_reported_at: prior.last_reported_at };
    }
    if (!dryRun) {
      await postIssueComment({ owner, repo, number, body:
        `## ${agent.toUpperCase()} EXECUTION REPORT\n\n**Status:** BLOCKED\n\n` +
        `**Summary:** Pickup conditions are met. The ${agent} runtime is installed (${runtime.cli_version}) and authenticated. ` +
        `Autonomous execution is currently gated by \`AGENT_EXECUTION_ENABLED=false\` in \`/etc/adversyn-brain-bridge.env\`.\n\n` +
        `**Missing:** explicit go-ahead. Set \`AGENT_EXECUTION_ENABLED=true\` and \`systemctl restart adversyn-bridge-agent-watch.service\` to enable.\n\n` +
        `**Detected plan (when execution is enabled):**\n` +
        `- Branch: \`${branch}\`\n` +
        `- Worktree: \`${worktree}\`\n` +
        `- Runtime: \`${runtime.cli_path}\` (${runtime.cli_version})\n` +
        `- Timeout: ${Math.round(TIMEOUT_MS / 60000)} min\n\n` +
        `**Note:** the watcher has NOT applied \`status:in-progress\` — the issue remains pickup-eligible.\n\n` +
        `_Posted by adversyn-bridge-agent-watch.service._`
      });
    }
    savePickupState(number, {
      state: 'gated',
      agent, branch, worktree,
      first_seen_at: prior?.first_seen_at || new Date().toISOString(),
      last_reported_at: new Date().toISOString(),
    });
    return { acted: 'gated-execution-disabled', agent, branch };
  }

  // Execution enabled — NOW we lock the issue.
  if (!dryRun) {
    await addLabels({ owner, repo, number, labels: ['status:in-progress'] });
  }

  // Real execution path.
  savePickupState(number, { state: 'in_progress', agent, branch, worktree, started_at: new Date().toISOString(), pid: null });

  try {
    // 1. Create worktree on a fresh branch off origin/main.
    if (fs.existsSync(worktree)) {
      const r = gitInWorktree(ROOT, ['worktree', 'remove', '-f', worktree]);
      if (!r.ok) logLine({ event: 'stale_worktree_remove_failed', issue: number, stderr: r.stderr });
    }
    const fetch = gitInWorktree(ROOT, ['fetch', 'origin', 'main']);
    if (!fetch.ok) throw new Error(`fetch origin main failed: ${fetch.stderr}`);
    const wt = gitInWorktree(ROOT, ['worktree', 'add', '-b', branch, worktree, 'origin/main']);
    if (!wt.ok) throw new Error(`worktree add failed: ${wt.stderr}`);

    // 2. Run runtime script with prompt on stdin.
    const prompt = buildAgentPrompt({ agent, issue, worktree, branch });
    const logPath = path.join(STATE_DIR, `${number}-${ts()}.log`);
    const out = fs.openSync(logPath, 'w');
    const child = spawn('bash', [runtime.runtime_script], {
      cwd: worktree,
      stdio: ['pipe', out, out],
      env: { ...process.env, ADVERSYN_AGENT: agent, ADVERSYN_ISSUE: String(number), ADVERSYN_BRANCH: branch, ADVERSYN_WORKTREE: worktree },
    });
    savePickupState(number, { state: 'in_progress', agent, branch, worktree, started_at: new Date().toISOString(), pid: child.pid, log: logPath });
    child.stdin.write(prompt);
    child.stdin.end();

    const exit = await new Promise((resolve) => {
      const to = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 60_000);
      }, TIMEOUT_MS);
      child.on('exit', (code, signal) => { clearTimeout(to); resolve({ code, signal }); });
    });
    fs.closeSync(out);

    // 3. Inspect commits the agent produced.
    const log = gitInWorktree(worktree, ['log', '--pretty=%H%x09%s', 'origin/main..HEAD']);
    const commits = log.ok ? log.stdout.split('\n').filter(Boolean) : [];

    if (commits.length === 0) {
      // No work produced — post BLOCKED.
      const reason = exit.signal ? `agent killed by ${exit.signal} (timeout?)` : `agent exited ${exit.code} with no commits`;
      if (!dryRun) {
        await postIssueComment({ owner, repo, number, body:
          `## ${agent.toUpperCase()} EXECUTION REPORT\n\n**Status:** BLOCKED\n\n` +
          `**Summary:** Agent ran but produced no commits.\n\n` +
          `**Reason:** ${reason}\n\n` +
          `**Log tail:**\n\`\`\`\n${(fs.readFileSync(logPath,'utf8').split('\n').slice(-25).join('\n')).slice(-1500)}\n\`\`\`\n\n` +
          `**Next action:** Review the log and either retry, refine the issue body, or hand off.\n\n` +
          `_Posted by adversyn-bridge-agent-watch.service._`
        });
        await removeLabel({ owner, repo, number, name: 'status:in-progress' });
        await addLabels({ owner, repo, number, labels: ['status:blocked'] });
      }
      // Cleanup worktree.
      gitInWorktree(ROOT, ['worktree', 'remove', '-f', worktree]);
      gitInWorktree(ROOT, ['branch', '-D', branch]);
      savePickupState(number, { state: 'blocked', agent, branch, worktree, ended_at: new Date().toISOString() });
      return { acted: 'blocked-no-commits', commits: 0 };
    }

    // 4. Push and open PR.
    if (!branch.match(/^agent\/(claude|codex)\/\d+-/)) throw new Error(`refusing to push branch with unexpected name: ${branch}`);
    const push = gitInWorktree(worktree, ['push', '-u', 'origin', branch]);
    if (!push.ok) throw new Error(`push failed: ${push.stderr}`);

    const stat = gitInWorktree(worktree, ['diff', '--shortstat', 'origin/main..HEAD']);
    const files = gitInWorktree(worktree, ['diff', '--name-status', 'origin/main..HEAD']);

    let prUrl = null;
    if (ghAvailable() && ghAuthOK()) {
      const prTitle = `[${agent}] ${issue.title}`;
      const prBody = `Closes #${number}\n\n## Summary\nAutonomous pickup of issue #${number} by the ${agent} agent.\n\n## Commits\n\`\`\`\n${commits.join('\n')}\n\`\`\`\n\n## Diff\n\`\`\`\n${stat.stdout}\n${files.stdout}\n\`\`\`\n\n_Opened automatically by adversyn-bridge-agent-watch.service._`;
      const r = ghRun(['pr', 'create', '--title', prTitle, '--body', prBody, '--base', 'main', '--head', branch], { input: '' });
      if (r.ok) {
        const m = r.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
        if (m) prUrl = m[0];
      } else {
        logLine({ event: 'pr_create_failed', issue: number, stderr: r.stderr });
      }
    }

    // 5. Post execution report.
    if (!dryRun) {
      await postIssueComment({ owner, repo, number, body:
        `## ${agent.toUpperCase()} EXECUTION REPORT\n\n**Status:** PASS\n\n` +
        `**Summary:** Agent produced ${commits.length} commit(s) on branch \`${branch}\`. ${prUrl ? `PR opened: ${prUrl}` : 'PR creation skipped (gh missing or failed).'}\n\n` +
        `**Commits:**\n\`\`\`\n${commits.join('\n')}\n\`\`\`\n\n` +
        `**Diff stat:** ${stat.stdout || '(none)'}\n\n` +
        `**Files:**\n\`\`\`\n${files.stdout || '(none)'}\n\`\`\`\n\n` +
        `**Log tail:**\n\`\`\`\n${(fs.readFileSync(logPath,'utf8').split('\n').slice(-15).join('\n')).slice(-800)}\n\`\`\`\n\n` +
        `_Posted by adversyn-bridge-agent-watch.service._`
      });
      await removeLabel({ owner, repo, number, name: 'status:in-progress' });
      await addLabels({ owner, repo, number, labels: ['status:ready-for-review'] });
    }

    // 6. Cleanup the worktree but keep the branch (PR points at it).
    gitInWorktree(ROOT, ['worktree', 'remove', '-f', worktree]);
    savePickupState(number, { state: 'ready_for_review', agent, branch, pr_url: prUrl, ended_at: new Date().toISOString(), commits: commits.length });

    return { acted: 'pr-opened', commits: commits.length, pr_url: prUrl, branch };

  } catch (e) {
    // Hard error — post BLOCKED, attempt cleanup.
    const msg = String(e.message || e);
    logLine({ event: 'pickup_error', issue: number, error: msg });
    if (!dryRun) {
      await postIssueComment({ owner, repo, number, body:
        `## ${agent.toUpperCase()} EXECUTION REPORT\n\n**Status:** BLOCKED\n\n` +
        `**Summary:** Watcher hit an error during pickup.\n\n**Error:** \`${msg.slice(0, 800)}\`\n\n_Posted by adversyn-bridge-agent-watch.service._`
      });
      try { await removeLabel({ owner, repo, number, name: 'status:in-progress' }); } catch {}
      try { await addLabels({ owner, repo, number, labels: ['status:blocked'] }); } catch {}
    }
    if (fs.existsSync(worktree)) gitInWorktree(ROOT, ['worktree', 'remove', '-f', worktree]);
    savePickupState(number, { state: 'error', agent, branch, error: msg, ended_at: new Date().toISOString() });
    return { acted: 'error', error: msg };
  }
}

// ---------------- main loop ------------------------------------------------

async function tick() {
  const repo = resolveRepo();
  if (!repo) { emit({ ok: false, error: 'cannot resolve owner/repo' }); return { ok: false }; }
  if (!resolveToken()) { emit({ ok: false, error: 'no GitHub token (GITHUB_TOKEN env or `gh auth token`)' }); return { ok: false }; }

  // Pull both lanes; dedupe.
  const seen = new Map();
  for (const lbl of ['agent:claude', 'agent:codex']) {
    const r = await listIssuesByLabel({ ...repo, labels: lbl, state: 'open', perPage: 50 });
    if (!r.ok) { logLine({ event: 'list_failed', label: lbl }); continue; }
    for (const it of r.body || []) seen.set(it.number, it);
  }

  const results = [];
  for (const issue of seen.values()) {
    const labels = labelNames(issue);
    if (!pickTaskLabel(labels)) continue;
    if (issue.pull_request) continue;
    const out = await pickupOne({ ...repo, issue });
    const summary = {
      issue: issue.number,
      title: issue.title,
      labels,
      result: out,
      execution_enabled: EXECUTION_ENABLED,
      dry_run: dryRun,
    };
    emit(summary);
    logLine(summary);
    results.push(summary);
  }
  return { ok: true, processed: results.length, results };
}

(async () => {
  // Verbose startup so journalctl sees config.
  emit({
    ok: true,
    starting: true,
    mode: watchMode ? 'watch' : 'one-shot',
    interval_sec: intervalSec,
    execution_enabled: EXECUTION_ENABLED,
    max_concurrent: MAX_CONCURRENT,
    timeout_ms: TIMEOUT_MS,
    dry_run: dryRun,
  });
  if (!watchMode) {
    const r = await tick();
    emit({ ok: !!r.ok, mode: 'one-shot-done', processed: r.processed || 0 });
    process.exit(r.ok ? 0 : 1);
  }
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { stopping = true; emit({ stopping_on: sig }); process.exit(0); });
  }
  while (!stopping) {
    try { await tick(); } catch (e) { logLine({ event: 'tick_error', error: String(e.message || e) }); }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
})();
