#!/usr/bin/env node
/**
 * Post an agent execution report (CODEX EXECUTION REPORT or
 * CLAUDE EXECUTION REPORT) on a GitHub PR or issue.
 *
 * Usage:
 *   node scripts/post-agent-report.mjs \
 *     --target pr --number 5 --agent codex \
 *     --status PASS \
 *     --summary "Added regression test" \
 *     --files-changed marketPulseFormatters.ts,tests/formatPercent.test.ts \
 *     --tests-run "npm ci, npm test" \
 *     --qa-impact "1 test added" \
 *     --risks "low" \
 *     --next "merge"
 *
 *   node scripts/post-agent-report.mjs ... --dry-run
 */

import { postIssueComment, resolveRepo } from './lib/github-api.mjs';
import { ghAvailable, ghAuthOK, ghRun } from './lib/gh-cli.mjs';

function arg(name, fb = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fb;
}
function flag(name) { return process.argv.includes(name); }

const target = arg('--target');
const number = parseInt(arg('--number') || '', 10);
const agent = (arg('--agent') || '').toLowerCase();
const status = (arg('--status') || '').toUpperCase();
const summary = arg('--summary');
const filesChanged = (arg('--files-changed') || '').split(',').map((s) => s.trim()).filter(Boolean);
const testsRun = (arg('--tests-run') || '').split(',').map((s) => s.trim()).filter(Boolean);
const qaImpact = arg('--qa-impact');
const risks = arg('--risks');
const next = arg('--next');
const dryRun = flag('--dry-run');

function emit(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }

if (!['pr', 'issue'].includes(target)) { emit({ ok: false, error: '--target must be pr or issue' }); process.exit(1); }
if (!number) { emit({ ok: false, error: '--number required' }); process.exit(1); }
if (!['claude', 'codex'].includes(agent)) { emit({ ok: false, error: '--agent must be claude or codex' }); process.exit(1); }
if (!['PASS', 'FAIL', 'BLOCKED'].includes(status)) { emit({ ok: false, error: '--status must be PASS|FAIL|BLOCKED' }); process.exit(1); }
if (!summary) { emit({ ok: false, error: '--summary required' }); process.exit(1); }

const title = agent === 'codex' ? 'CODEX EXECUTION REPORT' : 'CLAUDE EXECUTION REPORT';
const bullets = (arr) => (arr.length ? arr.map((s) => `- ${s}`).join('\n') : '_none_');

const body = `## ${title}

**Status:** ${status}

**Summary:**
${summary}

**Files changed:**
${bullets(filesChanged)}

**Tests run:**
${bullets(testsRun)}

**QA impact:**
${qaImpact || '_none recorded_'}

**Risks:**
${risks || '_none recorded_'}

**Next action:**
${next || '_TBD_'}

---
_Posted by \`scripts/post-agent-report.mjs\`. The Autonomous QA Report (separate comment) covers CI / Playwright outcome; this report covers what the agent itself did._`;

if (dryRun) { emit({ ok: true, dry_run: true, target, number, agent, status, body_preview: body.slice(0, 400) }); process.exit(0); }

const repo = resolveRepo();
if (!repo) { emit({ ok: false, error: 'cannot resolve owner/repo' }); process.exit(2); }

(async () => {
  // Prefer gh CLI when available; fall back to REST.
  if (ghAvailable() && ghAuthOK()) {
    const cmd = target === 'pr'
      ? ['pr', 'comment', String(number), '--body', body]
      : ['issue', 'comment', String(number), '--body', body];
    const r = ghRun(cmd);
    if (r.ok) { emit({ ok: true, via: 'gh', target, number }); return; }
    emit({ warning: `gh failed (${r.stderr.trim()}); falling back to REST` });
  }
  const res = await postIssueComment({ ...repo, number, body });
  if (!res.ok) { emit({ ok: false, error: `REST comment failed: HTTP ${res.status}` }); process.exit(3); }
  emit({ ok: true, via: 'rest', target, number, comment_url: res.body.html_url });
})().catch((e) => { emit({ ok: false, error: String(e.message || e) }); process.exit(4); });
