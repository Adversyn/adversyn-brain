#!/usr/bin/env node
/**
 * Ensure a PR's body links to the source issue with `Closes #N` and that
 * the issue has `status:in-progress` (added) and any stale status labels
 * are removed. Also flips the agent's issue assignment if --assignee given.
 *
 * Usage:
 *   node scripts/link-pr-to-issue.mjs --pr 5 --issue 12
 *   node scripts/link-pr-to-issue.mjs --pr 5 --issue 12 --dry-run
 */

import { ghAvailable, ghAuthOK, ghRun } from './lib/gh-cli.mjs';
import { getPR, getIssue, addLabels, removeLabel, resolveRepo } from './lib/github-api.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) { return process.argv.includes(name); }

const prNumber = parseInt(arg('--pr') || '', 10);
const issueNumber = parseInt(arg('--issue') || '', 10);
const dryRun = flag('--dry-run');

function emit(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }

if (!prNumber || !issueNumber) {
  emit({ ok: false, error: 'usage: --pr <n> --issue <n> [--dry-run]' });
  process.exit(1);
}

const repo = resolveRepo();
if (!repo) {
  emit({ ok: false, error: 'cannot resolve owner/repo from git remote or GITHUB_REPOSITORY' });
  process.exit(1);
}

(async () => {
  const pr = await getPR({ ...repo, number: prNumber });
  if (!pr.ok) { emit({ ok: false, error: `PR fetch failed: HTTP ${pr.status}` }); process.exit(2); }
  const issue = await getIssue({ ...repo, number: issueNumber });
  if (!issue.ok) { emit({ ok: false, error: `Issue fetch failed: HTTP ${issue.status}` }); process.exit(2); }

  const closesPattern = new RegExp(`(?:Closes|Fixes|Resolves)\\s+#${issueNumber}\\b`, 'i');
  const hasClose = closesPattern.test(pr.body?.body || '');
  const planned = {
    add_close_link: !hasClose,
    add_label: 'status:in-progress',
    remove_labels: ['status:ready-for-review', 'status:passed', 'status:failed', 'status:blocked'],
  };

  if (dryRun) {
    emit({ ok: true, dry_run: true, planned, pr_url: pr.body.html_url, issue_url: issue.body.html_url });
    return;
  }

  // Update PR body to include Closes #N if missing — prefer gh CLI for atomic edit.
  if (!hasClose) {
    if (ghAvailable() && ghAuthOK()) {
      const newBody = (pr.body.body || '') + `\n\nCloses #${issueNumber}`;
      const r = ghRun(['pr', 'edit', String(prNumber), '--body', newBody]);
      if (!r.ok) emit({ ok: false, warning: `pr body edit failed: ${r.stderr.trim()}` });
    } else {
      emit({ warning: 'gh CLI not available — PR body not edited; add `Closes #' + issueNumber + '` manually' });
    }
  }

  // Add status:in-progress on the issue.
  await addLabels({ ...repo, number: issueNumber, labels: ['status:in-progress'] });
  // Best-effort removal of stale status labels.
  for (const lbl of planned.remove_labels) {
    await removeLabel({ ...repo, number: issueNumber, name: lbl });
  }

  emit({ ok: true, dry_run: false, applied: planned, pr_url: pr.body.html_url, issue_url: issue.body.html_url });
})().catch((e) => { emit({ ok: false, error: String(e.message || e) }); process.exit(3); });
