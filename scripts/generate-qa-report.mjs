#!/usr/bin/env node
/**
 * Adversyn Autonomous QA Report Generator
 *
 * Reads:
 *   - test-results/autonomous-qa-summary.json   (written by autonomous-site-qa.spec.ts)
 *   - test-results/playwright-results.json      (Playwright JSON reporter)
 *
 * Writes:
 *   - qa-report.md  (human-readable, copy/pasted into PR comments)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RESULTS_DIR = path.resolve('test-results');
const SUMMARY_PATH = path.join(RESULTS_DIR, 'autonomous-qa-summary.json');
const PW_JSON_PATH = path.join(RESULTS_DIR, 'playwright-results.json');
const REPORT_PATH = path.resolve('qa-report.md');

const env = (k, d = '') => (process.env[k] ?? d);
const branch = env('GITHUB_REF_NAME', '(local)');
const sha = env('GITHUB_SHA', '(unknown)');
const pr = env('GITHUB_PR_NUMBER', '');
const pwResult = env('PW_RESULT', '');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const summary = readJsonSafe(SUMMARY_PATH);
const pwJson = readJsonSafe(PW_JSON_PATH);

let total = 0;
let passed = 0;
let failed = 0;
let skipped = 0;
if (pwJson?.suites) {
  const walk = (suites) => {
    for (const s of suites || []) {
      for (const spec of s.specs || []) {
        for (const t of spec.tests || []) {
          for (const r of t.results || []) {
            total++;
            if (r.status === 'passed') passed++;
            else if (r.status === 'skipped') skipped++;
            else failed++;
          }
        }
      }
      walk(s.suites);
    }
  };
  walk(pwJson.suites);
}

const status = (() => {
  if (summary?.status === 'fail') return 'FAIL';
  if (failed > 0) return 'FAIL';
  if (pwResult === 'failure') return 'FAIL';
  if (summary?.status === 'pass' || (pwResult === 'success' && total > 0)) return 'PASS';
  return 'UNKNOWN';
})();

const lines = [];
lines.push('### Adversyn Autonomous QA Report');
lines.push('');
lines.push(`- **Status:** ${status}`);
lines.push(`- **Timestamp:** ${new Date().toISOString()}`);
lines.push(`- **Commit:** \`${sha}\``);
lines.push(`- **Branch:** \`${branch}\``);
if (pr) lines.push(`- **PR:** #${pr}`);
lines.push(`- **App URL:** ${summary?.baseUrl || env('APP_BASE_URL', '(not set)')}`);
lines.push(`- **Host:** ${os.hostname()}`);
lines.push('');
lines.push('#### Playwright counts');
lines.push(`- Total: ${total}`);
lines.push(`- Passed: ${passed}`);
lines.push(`- Failed: ${failed}`);
lines.push(`- Skipped: ${skipped}`);
lines.push('');

if (summary) {
  lines.push('#### Coverage');
  lines.push(`- Routes visited (${summary.routesVisited.length}): ${summary.routesVisited.map((r) => `\`${r}\``).join(', ') || '_none_'}`);
  lines.push(`- Buttons clicked: ${summary.buttonsClicked.length}`);
  lines.push(`- Inputs modified: ${summary.inputsModified.length}`);
  lines.push(`- Persistence checks: ${summary.persistenceChecks.length} (${summary.persistenceChecks.filter((p) => p.persisted).length} persisted)`);
  lines.push('');

  if (summary.persistenceChecks.length > 0) {
    lines.push('<details><summary>Persistence detail</summary>');
    lines.push('');
    lines.push('| Route | Selector | Before | After | Persisted |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const p of summary.persistenceChecks.slice(0, 30)) {
      lines.push(`| \`${p.route}\` | \`${p.selector}\` | \`${p.before || ''}\` | \`${p.after || ''}\` | ${p.persisted ? 'yes' : 'no'} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (summary.consoleErrors?.length) {
    lines.push('#### Console errors');
    for (const e of summary.consoleErrors.slice(0, 25)) {
      lines.push(`- \`${e.route}\`: ${e.text.slice(0, 240)}`);
    }
    lines.push('');
  } else {
    lines.push('#### Console errors');
    lines.push('_none_');
    lines.push('');
  }

  if (summary.pageErrors?.length) {
    lines.push('#### Page errors');
    for (const e of summary.pageErrors.slice(0, 25)) {
      lines.push(`- \`${e.route}\`: ${e.text.slice(0, 240)}`);
    }
    lines.push('');
  }

  if (summary.failures?.length) {
    lines.push('#### Failed checks');
    for (const f of summary.failures) {
      lines.push(`- \`${f.route}\`: ${f.reason}`);
    }
    lines.push('');
  } else {
    lines.push('#### Failed checks');
    lines.push('_none_');
    lines.push('');
  }

  lines.push('#### Artifacts');
  lines.push('- Playwright HTML report: `playwright-report/` (uploaded as `playwright-report` artifact)');
  lines.push('- Screenshots: `test-results/autonomous-qa/` (inside the same artifact)');
  lines.push('- Raw summary: `test-results/autonomous-qa-summary.json`');
  lines.push('');
} else {
  lines.push('_No autonomous-qa-summary.json was found. The Playwright spec may have failed to bootstrap, or `tests/e2e/autonomous-site-qa.spec.ts` did not run. Check the workflow logs._');
  lines.push('');
}

lines.push('#### Final status');
lines.push(`**${status}** — ${describe(status, summary, failed)}`);
lines.push('');
lines.push('#### Suggested next action for Nova');
lines.push(suggest(status, summary, failed));
lines.push('');
lines.push('_Generated by `scripts/generate-qa-report.mjs`. See `docs/AUTONOMOUS_GITHUB_BRIDGE.md`._');

fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
console.log(`Wrote ${REPORT_PATH} — status ${status}`);

function describe(s, sum, f) {
  if (s === 'PASS') return 'autonomous walk completed without failures, console errors, or page errors';
  if (s === 'FAIL') {
    const reasons = [];
    if (f > 0) reasons.push(`${f} Playwright test(s) failed`);
    if (sum?.failures?.length) reasons.push(`${sum.failures.length} site checks failed`);
    if (sum?.consoleErrors?.length) reasons.push(`${sum.consoleErrors.length} console errors`);
    if (sum?.pageErrors?.length) reasons.push(`${sum.pageErrors.length} page errors`);
    return reasons.length ? reasons.join('; ') : 'one or more checks failed — see above';
  }
  return 'no autonomous QA signal — verify Playwright actually ran';
}

function suggest(s, sum, f) {
  if (s === 'PASS') return '- Apply `status:ready-for-review`. Nova reviews the PR comment and either merges or requests changes.';
  if (s === 'FAIL') {
    const tips = [
      '- Apply `status:failed` (if not already set by the workflow).',
      '- Open the failed Playwright run, inspect screenshots/videos/traces.',
    ];
    if (sum?.failures?.length) tips.push('- Read the **Failed checks** section above for the route + reason.');
    if (sum?.consoleErrors?.length) tips.push('- Inspect **Console errors** — these usually point at the broken route directly.');
    return tips.join('\n');
  }
  return '- Verify `playwright.config.ts` is detected, `tests/e2e/autonomous-site-qa.spec.ts` exists, and `APP_BASE_URL` is reachable from CI. Re-run the workflow.';
}
