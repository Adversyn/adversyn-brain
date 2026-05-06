#!/usr/bin/env node
/**
 * Adversyn Autonomous Bridge — Darren final report generator.
 *
 * Collects the full state of a GitHub issue or PR (including its linked
 * counterpart, CI runs, Playwright report comment, agent execution report,
 * artifacts, blockers) and writes a plain-English summary to
 * reports/darren-final-report-<n>.md so Darren never has to scrape GitHub.
 *
 * Usage:
 *   node scripts/review-github-task-for-darren.mjs --issue 12
 *   node scripts/review-github-task-for-darren.mjs --pr 5
 *   node scripts/review-github-task-for-darren.mjs --issue 12 --post   # also comment on issue
 *   node scripts/review-github-task-for-darren.mjs --dry-run            # synthetic example, no API
 *
 * Auth: GITHUB_TOKEN env or `gh auth token`. Token is held in memory only.
 * Network access is required unless --dry-run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveRepo, resolveToken,
  getIssue, getPR, listIssueComments, listPRFiles,
  listCheckRuns, listWorkflowRuns, listRunArtifacts, postIssueComment,
} from './lib/github-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(HERE, '..', 'reports');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const issueArg = arg('--issue');
const prArg = arg('--pr');
const post = flag('--post');
const dryRun = flag('--dry-run');

function emit(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }
function bail(msg, extra = {}) { emit({ ok: false, error: msg, ...extra }); process.exit(1); }

if (!dryRun && !issueArg && !prArg) bail('usage: --issue <n> | --pr <n> [--post] [--dry-run]');

fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ---------- Synthetic dry-run ---------------------------------------------
if (dryRun) {
  const synth = {
    issue: { number: 999, title: 'Wire MarketPulse persistence after refresh', html_url: 'https://example.invalid/i/999',
      labels: [{ name: 'agent:claude' }, { name: 'task:fix' }, { name: 'priority:high' }, { name: 'status:passed' }],
      body: '## Context\nDemo dry-run.\n## Acceptance criteria\n- [x] one\n- [x] two', state: 'closed' },
    pr: { number: 1000, title: '[claude] Wire MarketPulse persistence', html_url: 'https://example.invalid/pr/1000',
      head: { ref: 'agent/claude/999-fix-marketpulse', sha: 'deadbeef' }, state: 'closed', merged: true,
      body: 'Closes #999\n\n## Summary\nWired GET/POST + load on mount.\n\n## Risks\nLow — additive endpoint.', additions: 92, deletions: 4 },
    files: [{ filename: 'MarketPulse.tsx', additions: 50, deletions: 2, status: 'modified' },
            { filename: 'service_new.py', additions: 42, deletions: 2, status: 'modified' }],
    runs: [{ name: 'CI', conclusion: 'success', html_url: 'https://example.invalid/runs/1' }],
    qaReportComment: 'Status: PASS\nRoutes visited (3): /, /trading, /trading/marketpulse\nFailed checks: _none_',
    agentReportComment: 'CLAUDE EXECUTION REPORT\nStatus: PASS',
    artifacts: [{ name: 'playwright-report', archive_download_url: 'https://example.invalid/a/1' }],
    labels: ['agent:claude', 'task:fix', 'priority:high', 'status:passed'],
    status: 'PASS',
  };
  const md = renderReport(synth);
  const out = path.join(REPORTS_DIR, 'darren-final-report-999.md');
  fs.writeFileSync(out, md, 'utf8');
  emit({ ok: true, dry_run: true, written: out, status: 'PASS', length: md.length });
  process.exit(0);
}

// ---------- Real fetch path ------------------------------------------------
const repo = resolveRepo();
if (!repo) bail('cannot resolve owner/repo (run inside the git repo or set GITHUB_REPOSITORY)');
if (!resolveToken()) bail('no GitHub token available (set GITHUB_TOKEN or run `gh auth login`)');

(async () => {
  const ctx = await collect({ issueNumber: issueArg ? parseInt(issueArg, 10) : null,
                              prNumber: prArg ? parseInt(prArg, 10) : null });
  if (!ctx.ok) bail(ctx.error);
  const md = renderReport(ctx);
  const refNum = ctx.issue?.number || ctx.pr?.number;
  const out = path.join(REPORTS_DIR, `darren-final-report-${refNum}.md`);
  fs.writeFileSync(out, md, 'utf8');
  let posted = null;
  if (post && ctx.issue) {
    const r = await postIssueComment({ ...repo, number: ctx.issue.number, body: md });
    posted = r.ok ? r.body.html_url : `error HTTP ${r.status}`;
  }
  emit({ ok: true, written: out, status: ctx.status, posted, issue: ctx.issue?.html_url, pr: ctx.pr?.html_url });
})().catch((e) => bail(String(e.message || e)));

// ---------- collection ----------------------------------------------------
async function collect({ issueNumber, prNumber }) {
  let issue = null;
  let pr = null;

  if (issueNumber) {
    const r = await getIssue({ ...repo, number: issueNumber });
    if (!r.ok) return { ok: false, error: `issue #${issueNumber} fetch failed: HTTP ${r.status}` };
    issue = r.body;
    // If the issue body / timeline shows a linked PR, grab the most recent.
    const linkedPRMatch = (issue.body || '').match(/#(\d+)/g) || [];
    // Better: search for "Closes #N" referenced from PRs is not possible without code search;
    // use the issue's pull_request field if it itself is actually a PR-as-issue, else
    // look at recent PRs that mention #N in the body.
    if (issue.pull_request) {
      // Issue is actually a PR.
      const prr = await getPR({ ...repo, number: issueNumber });
      if (prr.ok) pr = prr.body;
    }
  }
  if (prArg && !pr) {
    const r = await getPR({ ...repo, number: prNumber });
    if (!r.ok) return { ok: false, error: `PR #${prNumber} fetch failed: HTTP ${r.status}` };
    pr = r.body;
    // Try to find the linked issue from PR body's "Closes #N".
    if (!issue) {
      const m = (pr.body || '').match(/(?:Closes|Fixes|Resolves)\s+#(\d+)/i);
      if (m) {
        const irq = await getIssue({ ...repo, number: parseInt(m[1], 10) });
        if (irq.ok && !irq.body.pull_request) issue = irq.body;
      }
    }
  }

  // Comments on the issue — Autonomous QA Report and Agent Execution Report.
  let qaReportComment = null;
  let agentReportComment = null;
  let allComments = [];
  if (issue) {
    const c = await listIssueComments({ ...repo, number: issue.number });
    if (c.ok) {
      allComments = c.body || [];
      for (const cm of allComments) {
        if (typeof cm.body !== 'string') continue;
        if (!qaReportComment && /Autonomous QA Report/i.test(cm.body)) qaReportComment = cm.body;
        if (!agentReportComment && /(CLAUDE|CODEX) EXECUTION REPORT/i.test(cm.body)) agentReportComment = cm.body;
      }
    }
  }
  if (pr && (!qaReportComment || !agentReportComment)) {
    const c = await listIssueComments({ ...repo, number: pr.number });
    if (c.ok) {
      for (const cm of c.body || []) {
        if (typeof cm.body !== 'string') continue;
        if (!qaReportComment && /Autonomous QA Report/i.test(cm.body)) qaReportComment = cm.body;
        if (!agentReportComment && /(CLAUDE|CODEX) EXECUTION REPORT/i.test(cm.body)) agentReportComment = cm.body;
      }
    }
  }

  // PR files.
  let files = [];
  if (pr) {
    const f = await listPRFiles({ ...repo, number: pr.number });
    if (f.ok) files = f.body || [];
  }

  // CI runs against PR head.
  let runs = [];
  let artifacts = [];
  if (pr?.head?.sha) {
    const c = await listCheckRuns({ ...repo, ref: pr.head.sha });
    if (c.ok) runs = c.body?.check_runs || [];
    const wfr = await listWorkflowRuns({ ...repo, branch: pr.head.ref });
    if (wfr.ok && wfr.body?.workflow_runs?.length) {
      const latest = wfr.body.workflow_runs[0];
      const ar = await listRunArtifacts({ ...repo, runId: latest.id });
      if (ar.ok) artifacts = ar.body?.artifacts || [];
    }
  }

  const labels = (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const status = computeStatus({ issue, pr, runs, qaReportComment, labels });

  return { ok: true, issue, pr, files, runs, artifacts, qaReportComment, agentReportComment, allComments, labels, status };
}

function computeStatus({ issue, pr, runs, qaReportComment, labels }) {
  const labelSet = new Set(labels);
  if (labelSet.has('status:needs-human-approval')) return 'NEEDS_APPROVAL';
  if (labelSet.has('status:blocked')) return 'BLOCKED';
  if (labelSet.has('status:failed')) return 'FAIL';
  if (labelSet.has('status:passed')) return 'PASS';
  if (runs && runs.length) {
    if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out')) return 'FAIL';
    if (runs.every((r) => r.conclusion === 'success')) return 'PASS';
  }
  if (qaReportComment) {
    if (/Status:\s*PASS/i.test(qaReportComment)) return 'PASS';
    if (/Status:\s*FAIL/i.test(qaReportComment)) return 'FAIL';
  }
  return 'IN_PROGRESS';
}

// ---------- render --------------------------------------------------------
function renderReport({ issue, pr, files, runs, artifacts, qaReportComment, agentReportComment, labels, status }) {
  const labelStr = (labels || []).map((n) => `\`${n}\``).join(' ') || '_none_';
  const fileList = (files || []).slice(0, 30)
    .map((f) => `- \`${f.filename}\` (+${f.additions} −${f.deletions}) ${f.status}`)
    .join('\n') || '_none_';
  const runList = (runs || []).slice(0, 10)
    .map((r) => `- ${r.name}: **${r.conclusion || r.status}** — ${r.html_url}`)
    .join('\n') || '_no CI runs found_';
  const artifactList = (artifacts || []).slice(0, 10)
    .map((a) => `- \`${a.name}\``).join('\n') || '_no artifacts_';

  const playwrightStatus = (() => {
    if (!qaReportComment) return '_no Autonomous QA Report comment found_';
    const m = qaReportComment.match(/Status:\s*(PASS|FAIL|UNKNOWN)/i);
    return m ? m[1].toUpperCase() : 'UNKNOWN';
  })();

  const failures = extractFailures(qaReportComment);
  const blockers = extractBlockers({ labels, qaReportComment, agentReportComment });
  const needsApproval = (labels || []).includes('status:needs-human-approval');
  const nextAction = suggestNext({ status, needsApproval, pr, issue });

  const issueLine = issue ? `[#${issue.number}](${issue.html_url}) — ${issue.title}` : '_none_';
  const prLine = pr ? `[#${pr.number}](${pr.html_url}) — ${pr.title}` : '_no PR yet_';

  return `## DARREN FINAL REPORT

**Status:** ${status === 'PASS' ? 'PASS'
            : status === 'FAIL' ? 'FAIL'
            : status === 'BLOCKED' ? 'BLOCKED'
            : status === 'NEEDS_APPROVAL' ? 'NEEDS APPROVAL'
            : 'IN PROGRESS'}

### What was done
${pr ? extractSummary(pr.body) : (issue ? `Task created from Nova: _${issue.title}_. No PR has been opened yet.` : '_no work to summarize_')}

### What changed
${pr ? `Branch \`${pr.head?.ref}\` → ${pr.merged ? 'merged' : pr.state}. Commit \`${(pr.head?.sha || '').slice(0, 7)}\`. ${pr.additions || 0} additions, ${pr.deletions || 0} deletions across ${files.length} file(s).` : '_no PR diff to summarize_'}

### Files changed
${fileList}

### Tests and QA
- CI runs:
${runList}
- Playwright autonomous QA: **${playwrightStatus}**

### Playwright result
${qaReportComment ? excerpt(qaReportComment, 50) : '_no Autonomous QA Report comment captured_'}

### CI result
${runs.length ? `${runs.length} check run(s) against PR head; see runs above.` : '_no CI runs found for this branch / SHA_'}

### Failures or blockers
${failures.length === 0 && blockers.length === 0 ? '_none_' : [...failures, ...blockers].map((s) => `- ${s}`).join('\n')}

### Risks
${(pr && /risks?:/i.test(pr.body || '')) ? excerpt(pr.body, 12) : '_no explicit risk section in PR body — verify manually_'}

### Needs Darren approval
${needsApproval ? '**Yes** — \`status:needs-human-approval\` is set. The agent will not proceed until Darren explicitly approves in a comment.' : 'No.'}

### Next action
${nextAction}

### Links
- Issue: ${issueLine}
- PR: ${prLine}
- CI runs: ${runs.length ? runs.map((r) => r.html_url).slice(0, 5).join(', ') : '_none_'}
- Artifacts: ${artifactList}
- Labels: ${labelStr}

### Agent execution report (excerpt)
${agentReportComment ? excerpt(agentReportComment, 30) : '_none posted yet_'}

---
_Generated by \`scripts/review-github-task-for-darren.mjs\`. Single source of truth: the linked issue/PR. If anything below conflicts with GitHub state, GitHub wins._`;
}

function extractSummary(body) {
  if (!body) return '_no PR body_';
  const m = body.match(/##?\s*Summary\s*\n([\s\S]+?)(?=\n##?\s|\n---|$)/i);
  return (m ? m[1] : body).trim().slice(0, 800) || '_empty summary_';
}

function excerpt(s, lines = 30) {
  const arr = (s || '').split('\n').slice(0, lines);
  return arr.join('\n') + (s.split('\n').length > lines ? `\n…(truncated)` : '');
}

function extractFailures(qaReportComment) {
  if (!qaReportComment) return [];
  const block = qaReportComment.match(/Failed checks[\s\S]*?(?=####|$)/i);
  if (!block) return [];
  const lines = block[0].split('\n').slice(1).filter((l) => l.trim().startsWith('-'));
  return lines.map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean);
}

function extractBlockers({ labels, qaReportComment, agentReportComment }) {
  const set = new Set(labels || []);
  const out = [];
  if (set.has('status:blocked')) out.push('Issue/PR is labeled `status:blocked` — agent self-reported a blocker.');
  if (qaReportComment && /Status:\s*FAIL/i.test(qaReportComment)) out.push('Autonomous QA Report says FAIL — see Playwright section.');
  if (agentReportComment && /Status:\s*BLOCKED/i.test(agentReportComment)) out.push('Agent execution report says BLOCKED.');
  return out;
}

function suggestNext({ status, needsApproval, pr, issue }) {
  if (needsApproval) return '- Darren: comment approval (or rejection) on the issue. Agent will not proceed without it.';
  if (status === 'FAIL') return '- Investigate the failed CI run and Playwright artifacts. File a follow-up Nova task or comment to redirect the agent.';
  if (status === 'BLOCKED') return '- Read the agent execution report blocker, then either unblock (provide info / change labels) or close the task.';
  if (status === 'IN_PROGRESS') return '- Wait for the next CI run; the bridge will regenerate this report once the labels stabilize.';
  if (status === 'PASS' && pr && !pr.merged) return `- Review and merge ${pr.html_url}. The autonomous QA already passed.`;
  if (status === 'PASS' && pr && pr.merged) return '- Merged. No action required.';
  if (status === 'PASS' && !pr) return '- Task is marked passed but no PR is linked — verify the work landed correctly.';
  return '- Review the linked issue/PR and decide.';
}
