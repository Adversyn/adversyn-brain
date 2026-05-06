#!/usr/bin/env node
/**
 * Adversyn Autonomous Bridge — results watcher.
 *
 * Polls the repo for issues with terminal-state labels, generates a Darren
 * final report for any new state we haven't reported on yet, optionally
 * posts the report back to the issue, and tracks last-seen state in
 * .bridge-state/issues.json so we don't duplicate.
 *
 * Usage:
 *   node scripts/watch-github-results-for-darren.mjs              # one-shot
 *   node scripts/watch-github-results-for-darren.mjs --watch      # continuous (60s)
 *   node scripts/watch-github-results-for-darren.mjs --watch --interval 120
 *   node scripts/watch-github-results-for-darren.mjs --post       # also comment on issue
 *   node scripts/watch-github-results-for-darren.mjs --dry-run    # don't write reports, don't post
 *
 * Auth: GITHUB_TOKEN env or `gh auth token`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRepo, resolveToken, listIssuesByLabel } from './lib/github-api.mjs';
import { loadRepos } from './lib/repos.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, '.bridge-state');
const STATE_FILE = path.join(STATE_DIR, 'issues.json');
const LOG_FILE = path.join(STATE_DIR, 'watcher.ndjson');

const TARGET_LABELS = [
  'status:ready-for-review',
  'status:passed',
  'status:failed',
  'status:blocked',
  'status:needs-human-approval',
];

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const watchMode = flag('--watch');
const dryRun = flag('--dry-run');
const post = flag('--post');
const intervalSec = parseInt(arg('--interval') || '60', 10);

fs.mkdirSync(STATE_DIR, { recursive: true });

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); }
function logLine(o) { fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', 'utf8'); }
function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function fingerprint(issue) {
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).sort().join(',');
  return `${issue.updated_at}|${labelNames}`;
}

async function pollOnce({ owner, repo, state }) {
  const seen = new Set();
  const aggregate = [];
  for (const lbl of TARGET_LABELS) {
    const r = await listIssuesByLabel({ owner, repo, labels: lbl, state: 'all', perPage: 50 });
    if (!r.ok) { logLine({ event: 'list_failed', label: lbl, status: r.status }); continue; }
    for (const it of r.body || []) {
      if (seen.has(it.number)) continue;
      seen.add(it.number);
      aggregate.push(it);
    }
  }
  const fresh = [];
  for (const it of aggregate) {
    const fp = fingerprint(it);
    const last = state[String(it.number)];
    if (last && last.fingerprint === fp) continue;
    fresh.push({ issue: it, fp });
  }
  return fresh;
}

async function regenerateReport(issueNumber, { owner, repo } = {}) {
  const args = [path.join(HERE, 'review-github-task-for-darren.mjs'), '--issue', String(issueNumber)];
  if (post && !dryRun) args.push('--post');
  if (dryRun) args.push('--dry-run');
  // Pass GITHUB_REPOSITORY so the report script targets the right repo.
  const env = { ...process.env };
  if (owner && repo) env.GITHUB_REPOSITORY = `${owner}/${repo}`;
  const r = spawnSync('node', args, { encoding: 'utf8', env });
  let parsed = null;
  if (r.stdout && r.stdout.trim()) {
    try { parsed = JSON.parse(r.stdout.trim()); }
    catch {
      try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); }
      catch { /* ignore */ }
    }
  }
  return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

async function tick() {
  if (!resolveToken()) { emit({ ok: false, error: 'no GitHub token' }); return { ok: false }; }
  // Build target list: repos/*.json registry, fallback to resolveRepo().
  const registry = loadRepos();
  const targets = registry.length > 0
    ? registry.map((r) => ({ owner: r.full_name.split('/')[0], repo: r.full_name.split('/')[1] }))
    : [resolveRepo()].filter(Boolean);
  if (targets.length === 0) { emit({ ok: false, error: 'no target repos' }); return { ok: false }; }

  const state = loadState();
  let processed = 0;
  for (const { owner, repo } of targets) {
    const fresh = await pollOnce({ owner, repo, state });
    for (const { issue, fp } of fresh) {
      // State key is namespaced by repo so #5 in two repos doesn't collide.
      const key = `${owner}/${repo}#${issue.number}`;
      const r = await regenerateReport(issue.number, { owner, repo });
      state[key] = {
        repo: `${owner}/${repo}`,
        fingerprint: fp,
        last_reported_at: new Date().toISOString(),
        labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
        title: issue.title,
        url: issue.html_url,
        report_status: r.parsed?.status || 'unknown',
      };
      emit({
        ok: r.ok,
        repo: `${owner}/${repo}`,
        issue: issue.number,
        title: issue.title,
        labels: state[key].labels,
        report_status: state[key].report_status,
        written: r.parsed?.written || null,
        posted: r.parsed?.posted || null,
      });
      logLine({ event: 'report_regenerated', repo: `${owner}/${repo}`, issue: issue.number, ok: r.ok, status: r.parsed?.status });
      processed++;
    }
  }
  saveState(state);
  return { ok: true, processed };
}

(async () => {
  if (!watchMode) {
    const r = await tick();
    emit({ ok: !!r.ok, mode: 'one-shot', processed: r.processed || 0 });
    process.exit(r.ok ? 0 : 1);
  }
  emit({ ok: true, mode: 'watch', interval_sec: intervalSec, dry_run: dryRun, post });
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { stopping = true; emit({ stopping_on: sig }); process.exit(0); });
  }
  while (!stopping) {
    try { await tick(); } catch (e) { logLine({ event: 'tick_error', error: String(e.message || e) }); }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
})();
