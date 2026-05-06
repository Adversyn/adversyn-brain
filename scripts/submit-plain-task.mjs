#!/usr/bin/env node
/**
 * Adversyn bridge — plain-English intake.
 *
 * Lets Darren (or Nova) submit a task using --problem / --where / --expected
 * flags. We classify (which agent, which task type), pick the right repo from
 * `repos/*.json`, build a valid Nova task JSON, and create the GitHub issue
 * directly via gh CLI / REST.
 *
 * Usage:
 *   npm run pm:submit -- --problem "Console Debate opens at bottom" \
 *       --where "trading UI sidebar" --expected "page opens at top" \
 *       --priority high --repo auto
 *
 *   # explicit repo:
 *   --repo bridge|frontend|<owner/repo-fullname>
 *
 *   # require human approval (e.g. anything that hints at deploy / secrets):
 *   --approval-needed true
 *
 *   # dry-run (no GitHub call, no inbox write):
 *   --dry-run
 *
 *   # write to nova-inbox instead of creating issue directly:
 *   --to-inbox
 *
 * Output: JSON with the resulting issue URL (or path to inbox file).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRepoFromText, classifyAgentLane, findByName, findByFullName, defaultRepo } from './lib/repos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INBOX = path.join(ROOT, 'nova-inbox');
const INTAKE = path.join(HERE, 'create-github-issue-from-nova.mjs');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const problem = arg('--problem') || '';
const where   = arg('--where') || '';
const expected = arg('--expected') || '';
const priorityArg = (arg('--priority') || 'normal').toLowerCase();
const repoArg = arg('--repo') || 'auto';
const approvalArg = (arg('--approval-needed') || 'false').toLowerCase();
const dryRun = flag('--dry-run');
const toInbox = flag('--to-inbox');

function emit(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }
function bail(msg, extra = {}) { emit({ ok: false, error: msg, ...extra }); process.exit(1); }

// --- validation -----------------------------------------------------------
if (!problem) bail('--problem is required (plain-English description)');
if (!expected) bail('--expected is required (one-line desired behavior)');
if (!['low', 'normal', 'high'].includes(priorityArg)) bail(`invalid --priority: ${priorityArg}`);
if (!['true', 'false'].includes(approvalArg)) bail(`invalid --approval-needed: ${approvalArg}`);

// --- repo selection -------------------------------------------------------
function pickRepo() {
  if (repoArg === 'auto') {
    const r = resolveRepoFromText({ where, problem, expected });
    if (r) return { source: 'auto', repo: r };
    // Fallback: bridge repo.
    return { source: 'auto-fallback-bridge', repo: defaultRepo() };
  }
  if (repoArg === 'bridge') {
    const r = findByName('adversyn-brain');
    if (!r) bail('--repo bridge: repos/adversyn-brain.json missing');
    return { source: 'flag-bridge', repo: r };
  }
  if (repoArg === 'frontend') {
    const r = findByName('adversyn-trading-ui');
    if (!r) bail('--repo frontend: repos/adversyn-trading-ui.json missing');
    return { source: 'flag-frontend', repo: r };
  }
  if (repoArg.includes('/')) {
    const r = findByFullName(repoArg);
    if (!r) bail(`--repo ${repoArg}: no matching repos/*.json`);
    return { source: 'flag-fullname', repo: r };
  }
  // Try as `--repo <short-name>`:
  const r = findByName(repoArg);
  if (!r) bail(`--repo ${repoArg}: no matching repos/*.json`);
  return { source: 'flag-shortname', repo: r };
}
const { source: repoSource, repo: repoCfg } = pickRepo();
if (!repoCfg) bail('failed to pick a target repo');

// --- agent classification -------------------------------------------------
const cls = classifyAgentLane({ problem, expected });
let agent_lane = cls.agent_lane;
let task_type = cls.task_type_hint || 'fix';

// Per-repo allowed_task_types — clamp.
if (Array.isArray(repoCfg.allowed_task_types) && repoCfg.allowed_task_types.length > 0
    && !repoCfg.allowed_task_types.includes(task_type)) {
  task_type = repoCfg.allowed_task_types.includes('fix') ? 'fix'
            : repoCfg.allowed_task_types.includes('docs') ? 'docs'
            : repoCfg.allowed_task_types[0];
}

// --- build Nova task JSON -------------------------------------------------
const task = {
  title: deriveTitle(problem),
  agent_lane,
  primary_agent: 'none',
  task_type,
  priority: priorityArg,
  context: synthesizeContext({ where, expected, repoCfg }),
  problem: problem,
  expected_behavior: expected,
  affected_routes: deriveRoutes({ where, expected }),
  affected_files: [],
  acceptance_criteria: deriveAcceptance({ problem, expected, where }),
  qa_requirements: deriveQA({ repoCfg, task_type }),
  forbidden_actions: deriveForbidden({ repoCfg }),
  requires_human_approval: approvalArg === 'true' || isRiskyTask({ problem, expected, where }),
  source: 'pm:submit',
  created_by: process.env.USER || 'unknown',
  report_back_to: 'Darren',
  final_report_required: true,
  target_repo: repoCfg.full_name,
};

emit({
  ok: true,
  classified: {
    repo: repoCfg.full_name,
    repo_source: repoSource,
    agent_lane: task.agent_lane,
    task_type: task.task_type,
    requires_human_approval: task.requires_human_approval,
  },
  title: task.title,
});

if (dryRun) {
  emit({ ok: true, dry_run: true, task });
  process.exit(0);
}

// --- dispatch -------------------------------------------------------------
if (toInbox) {
  fs.mkdirSync(INBOX, { recursive: true });
  const fname = `${Date.now()}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}.json`;
  const target = path.join(INBOX, fname);
  fs.writeFileSync(target, JSON.stringify(task, null, 2), 'utf8');
  emit({ ok: true, mode: 'to-inbox', written: target, target_repo: task.target_repo });
  process.exit(0);
}

// Direct: spawn create-github-issue-from-nova.mjs with the task on a temp file.
const tmp = `/tmp/pm-submit-${Date.now()}.json`;
fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8');
const r = spawnSync('node', [INTAKE, tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);
if (r.status !== 0) {
  emit({ ok: false, error: 'intake failed', stderr: (r.stderr || '').trim().slice(0, 800), stdout: (r.stdout || '').trim().slice(0, 800) });
  process.exit(2);
}
let parsed = null;
try { parsed = JSON.parse((r.stdout || '').trim()); }
catch { try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {} }
if (!parsed?.ok) {
  emit({ ok: false, error: 'intake reported failure', detail: parsed });
  process.exit(3);
}
emit({
  ok: true,
  mode: 'direct-issue',
  target_repo: parsed.target_repo,
  issue_url: parsed.issue_url,
  number: parsed.number,
  labels: parsed.labels,
});

// --- helpers --------------------------------------------------------------
function deriveTitle(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length <= 100 ? t : t.slice(0, 97) + '…';
}
function synthesizeContext({ where, expected, repoCfg }) {
  const lines = [
    `Repo: \`${repoCfg.full_name}\` — ${repoCfg.purpose || ''}`,
    where ? `Location: ${where}` : null,
    expected ? `Goal: ${expected}` : null,
    repoCfg.app_url ? `App URL: ${repoCfg.app_url}` : null,
    `Submitted via \`pm:submit\` — auto-classified, no manual JSON.`,
  ].filter(Boolean);
  return lines.join('\n');
}
function deriveRoutes({ where }) {
  if (!where) return [];
  // Strip URLs first so we don't capture fragments of `http://...`.
  const cleaned = where.replace(/https?:\/\/[^\s]+/gi, '');
  // Match path-like tokens: /alpha or /alpha/beta — at least one [a-zA-Z]
  // char after the slash, no consecutive slashes.
  const matches = cleaned.match(/(?<![/A-Za-z0-9])\/[A-Za-z][A-Za-z0-9_\-]*(?:\/[A-Za-z0-9_\-]+)*/g);
  if (!matches) return [];
  // Filter out file paths that are clearly not routes (extensions like .md, .ts, .json, .png, .ico).
  const filtered = matches.filter((m) => !/\.[a-z0-9]{1,5}$/i.test(m));
  return Array.from(new Set(filtered));
}
function deriveAcceptance({ problem, expected, where }) {
  return [
    `${expected || 'meets the expected behavior'}`.replace(/^./, (c) => c.toUpperCase()),
    `No new console errors${where ? ` on the affected page (${where})` : ''}.`,
    `Playwright autonomous QA passes (or is not applicable for this task).`,
    `No destructive UI selectors are clicked.`,
  ];
}
function deriveQA({ repoCfg, task_type }) {
  const out = [];
  if (task_type !== 'docs') out.push('CI must be green.');
  out.push(`Playwright autonomous-site-qa must remain green${repoCfg.app_url ? ` against ${repoCfg.app_url}` : ''}.`);
  return out;
}
function deriveForbidden({ repoCfg }) {
  const out = [];
  if (repoCfg.allow_npm_build_on_ec2 === false) out.push('Do not run `npm run build` / `vite build` on the EC2 host (CPU-pins the box).');
  if (repoCfg.allow_npm_install_on_ec2 === false) out.push('Do not run `npm install` / `npm ci` on the EC2 host.');
  out.push('No service restart, no deploy, no live trading actions, no broker credential edits.');
  if (repoCfg.deploy_target) out.push(`No automated deploy to \`${repoCfg.deploy_target}\` — Darren-driven only.`);
  return out;
}
function isRiskyTask({ problem, expected, where }) {
  const text = `${problem} ${expected} ${where}`.toLowerCase();
  const risky = ['deploy', 'production', 'prod ', 'release', 'rollback', 'migration', 'database', 'secret', 'credential', 'broker', 'restart', 'systemd', 'live trading', 'force-close', 'liquidate'];
  return risky.some((k) => text.includes(k));
}
