#!/usr/bin/env node
/**
 * Adversyn Autonomous Bridge — Nova → GitHub Issue intake.
 *
 * Reads a Nova task JSON, validates it against schemas/nova_task.schema.json,
 * maps fields to labels, generates a clean issue body, and creates the issue
 * via gh CLI (preferred) or GitHub REST API.
 *
 * Usage:
 *   node scripts/create-github-issue-from-nova.mjs <task.json>
 *   node scripts/create-github-issue-from-nova.mjs <task.json> --dry-run
 *   node scripts/create-github-issue-from-nova.mjs <task.json> --no-gh   (force REST)
 *
 * Output:
 *   stdout JSON: { ok, issue_url, number, labels, dry_run }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateNovaTask, applySchemaDefaults } from './lib/nova-task-validator.mjs';
import { ghAvailable, ghAuthOK, ghRun } from './lib/gh-cli.mjs';
import { createIssue, resolveRepo, resolveToken } from './lib/github-api.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceRest = args.includes('--no-gh');
const file = args.find((a) => !a.startsWith('--'));

function fail(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + '\n');
  process.exit(1);
}

if (!file) fail('usage: node scripts/create-github-issue-from-nova.mjs <task.json> [--dry-run] [--no-gh]');
if (!fs.existsSync(file)) fail(`task file not found: ${file}`);

let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  fail(`task file is not valid JSON: ${e.message}`);
}

const task = applySchemaDefaults(raw);
const v = validateNovaTask(task);
if (!v.valid) fail('schema validation failed', { errors: v.errors });

// --- label mapping --------------------------------------------------------
const labels = [];
if (task.agent_lane === 'claude') labels.push('agent:claude');
if (task.agent_lane === 'codex') labels.push('agent:codex');
if (task.agent_lane === 'multi-agent') {
  labels.push('agent:claude', 'agent:codex', 'multi-agent');
  if (task.primary_agent === 'claude') labels.push('primary:claude');
  if (task.primary_agent === 'codex') labels.push('primary:codex');
}
// qa-only doesn't tag an agent lane — humans or scheduled runs handle it.

labels.push(`task:${task.task_type}`);
if (task.priority === 'high') labels.push('priority:high');
if (task.requires_human_approval || task.task_type === 'deploy') {
  labels.push('status:needs-human-approval');
}

// --- body builder ---------------------------------------------------------
function bullets(arr) {
  if (!arr || arr.length === 0) return '_none_';
  return arr.map((s) => `- ${s}`).join('\n');
}
function checks(arr) {
  if (!arr || arr.length === 0) return '_none_';
  return arr.map((s) => `- [ ] ${s}`).join('\n');
}

const body = `> Auto-generated from a Nova task by \`scripts/create-github-issue-from-nova.mjs\`.
> Source: \`${task.source || 'unknown'}\` — Created by: \`${task.created_by || 'unknown'}\`.

## Context
${task.context}

## Problem
${task.problem}

## Expected behavior
${task.expected_behavior}

${task.current_behavior ? `## Current behavior\n${task.current_behavior}\n` : ''}
## Affected routes
${bullets(task.affected_routes)}

## Affected files
${bullets(task.affected_files)}

## Acceptance criteria
${checks(task.acceptance_criteria)}

## QA requirements
${checks(task.qa_requirements)}

## Forbidden actions
${bullets(task.forbidden_actions)}

## Routing
- Agent lane: \`${task.agent_lane}\`
- Primary agent: \`${task.primary_agent}\`
- Task type: \`${task.task_type}\`
- Priority: \`${task.priority}\`
- Requires human approval: ${task.requires_human_approval ? '**yes**' : 'no'}

## Reporting contract
- \`report_back_to\`: ${task.report_back_to}
- \`final_report_required\`: ${task.final_report_required}
- After CI completes, the bridge will generate a Darren final report. See \`docs/DARREN_FINAL_REPORTING.md\`.

---
_Adversyn Autonomous GitHub Bridge — see \`docs/AUTONOMOUS_GITHUB_BRIDGE.md\`._`;

// --- dry-run output -------------------------------------------------------
if (dryRun) {
  process.stdout.write(JSON.stringify({
    ok: true,
    dry_run: true,
    title: task.title,
    labels,
    body_preview: body.slice(0, 600),
    body_length: body.length,
  }, null, 2) + '\n');
  process.exit(0);
}

// Determine the target repo for this task. Precedence:
//   1. task.target_repo (e.g. "Adversyn/Adversyn-Trading")
//   2. GITHUB_REPOSITORY env (CI-style)
//   3. git remote origin of cwd (legacy default)
function resolveTargetRepo(t) {
  if (t.target_repo && t.target_repo.includes('/')) {
    const [owner, repo] = t.target_repo.split('/');
    if (owner && repo) return { owner, repo, source: 'task.target_repo' };
  }
  const r = resolveRepo();
  return r ? { ...r, source: r ? (process.env.GITHUB_REPOSITORY ? 'env' : 'git-remote') : 'unknown' } : null;
}

// --- create via gh CLI ----------------------------------------------------
async function viaGh() {
  if (!ghAvailable()) return { ok: false, reason: 'gh CLI not installed' };
  if (!ghAuthOK()) return { ok: false, reason: 'gh CLI not authenticated (run `gh auth login`)' };
  const target = resolveTargetRepo(task);
  if (!target) return { ok: false, reason: 'cannot resolve target repo (set task.target_repo or GITHUB_REPOSITORY)' };
  const labelArgs = labels.flatMap((l) => ['--label', l]);
  const r = ghRun(
    ['issue', 'create', '--repo', `${target.owner}/${target.repo}`, '--title', task.title, '--body-file', '-', ...labelArgs],
    { input: body }
  );
  if (!r.ok) return { ok: false, reason: r.stderr.trim() || `gh exited ${r.code}` };
  const m = r.stdout.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/);
  if (!m) return { ok: false, reason: `gh succeeded but no URL in stdout: ${r.stdout.slice(0, 200)}` };
  return { ok: true, issue_url: m[0], number: parseInt(m[1], 10), target_repo: `${target.owner}/${target.repo}` };
}

// --- create via REST ------------------------------------------------------
async function viaRest() {
  const target = resolveTargetRepo(task);
  if (!target) return { ok: false, reason: 'cannot resolve target repo (set task.target_repo or GITHUB_REPOSITORY)' };
  if (!resolveToken()) return { ok: false, reason: 'no GitHub token available (set GITHUB_TOKEN or run `gh auth login`)' };
  const res = await createIssue({ owner: target.owner, repo: target.repo, title: task.title, body, labels });
  if (!res.ok) return { ok: false, reason: `REST create failed: HTTP ${res.status} ${typeof res.body === 'object' && res.body?.message ? res.body.message : ''}` };
  return { ok: true, issue_url: res.body.html_url, number: res.body.number, target_repo: `${target.owner}/${target.repo}` };
}

(async () => {
  let result;
  if (forceRest) {
    result = await viaRest();
  } else {
    result = await viaGh();
    if (!result.ok) {
      // Fall back to REST on any gh issue.
      const fallback = await viaRest();
      if (fallback.ok) result = fallback;
      else result = { ok: false, reason: `gh: ${result.reason}; rest: ${fallback.reason}` };
    }
  }
  if (!result.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: result.reason, labels }, null, 2) + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    dry_run: false,
    issue_url: result.issue_url,
    number: result.number,
    labels,
    target_repo: result.target_repo,
  }, null, 2) + '\n');
})();
