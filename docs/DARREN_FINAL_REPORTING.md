# Darren Final Reporting

The whole point of the bridge is that Darren reads **one** plain-English
file and knows what happened. This document explains where that file
comes from, what it contains, and how to (re)generate it.

## What Darren reads

```
reports/darren-final-report-<issue-or-pr-number>.md
```

(Optionally posted as an `## DARREN FINAL REPORT` comment on the issue
when `--post` is passed.)

The file always contains, in this order:

1. **Status** — `PASS` / `FAIL` / `BLOCKED` / `NEEDS APPROVAL` / `IN PROGRESS`
2. **What was done** — extracted from the PR's `## Summary` section
3. **What changed** — branch, commit SHA, additions/deletions, file count
4. **Files changed** — top 30 with `+/−` line counts and status
5. **Tests and QA** — every CI run name + conclusion + URL; Playwright PASS/FAIL
6. **Playwright result** — first 50 lines of the Autonomous QA Report comment
7. **CI result** — count of check runs and per-run links
8. **Failures or blockers** — auto-extracted from the QA report's *Failed checks* section + status labels + agent execution report
9. **Risks** — extracted from the PR body's *Risks* section if present
10. **Needs Darren approval** — yes/no based on `status:needs-human-approval`
11. **Next action** — computed from status; explicit and actionable
12. **Links** — issue, PR, CI run URLs, artifact names, full label list
13. **Agent execution report (excerpt)** — first 30 lines of the matching comment

## How to generate one

### On demand

```bash
# By issue number:
node scripts/review-github-task-for-darren.mjs --issue 12

# By PR number (resolves the linked issue if "Closes #N" is in the body):
node scripts/review-github-task-for-darren.mjs --pr 5

# Also post the full report as a comment on the issue:
node scripts/review-github-task-for-darren.mjs --issue 12 --post

# Synthetic dry run (no API calls — useful for layout / formatting):
node scripts/review-github-task-for-darren.mjs --dry-run
```

### Continuously (the bridge's normal mode)

```bash
# One-shot:
npm run pm:watch-results:once

# Continuous (60s poll):
npm run pm:watch-results

# Continuous, auto-post:
node scripts/watch-github-results-for-darren.mjs --watch --post
```

The watcher polls these labels:
- `status:ready-for-review`
- `status:passed`
- `status:failed`
- `status:blocked`
- `status:needs-human-approval`

It tracks per-issue state in `.bridge-state/issues.json` (fingerprint =
`updated_at` + sorted label set). A report is regenerated only when the
fingerprint changes — so a refresh of an unchanged issue does not produce
a duplicate report.

## Sources of truth (and what wins on conflict)

| Field in report | Primary source | Fallback |
| --- | --- | --- |
| Status | `status:*` labels | `runs[*].conclusion` → QA report comment |
| What changed | PR `head.ref` + `head.sha` + diff | _no PR → empty_ |
| Files changed | `GET /pulls/<n>/files` | _no PR → empty_ |
| CI result | Check runs against PR `head.sha` | _none → empty_ |
| Playwright result | Most recent `## Autonomous QA Report` comment on PR or issue | _no comment → "not captured"_ |
| Failures | QA report comment's *Failed checks* section | Status labels |
| Agent report | First `(CLAUDE\|CODEX) EXECUTION REPORT` comment | _none → "not posted yet"_ |
| Approval flag | Presence of `status:needs-human-approval` | _none → no_ |
| Next action | Computed from status + approval + PR merged state | _fallback advice_ |

If any value in the report disagrees with what you see on GitHub,
**GitHub wins**. Re-run the review script — the fingerprint will detect
the drift and regenerate.

## Approval workflow (Darren's only required interaction)

1. Watcher posts a Darren report with **Status: NEEDS APPROVAL**.
2. Darren reads the report. To approve, comments on the **issue** (not
   the PR):
   ```
   APPROVED FOR EXECUTION
   ```
   (case-insensitive — exact phrase, can include surrounding text)
3. The agent (or a future approval-listener) removes
   `status:needs-human-approval` and proceeds.
4. To reject: comment with rationale, then close the issue or change
   labels to redirect work.

## Recovering a missing report

If a report is expected but missing:

```bash
# Force regenerate, ignoring the cached fingerprint:
rm -f .bridge-state/issues.json   # clears all state
npm run pm:watch-results:once

# Or for one specific issue:
node scripts/review-github-task-for-darren.mjs --issue <n>
```

If the script reports a missing field (e.g. *no Autonomous QA Report
comment captured*), check the PR's CI run — `pr-report.yml` may not have
fired yet, or the PR may not be associated with a workflow run that
uploaded a `qa-report` artifact.

## Privacy / safety guarantees

- Reports are derived from the GitHub API only. Never from `.env`, never
  from local secrets.
- Tokens are held in memory by the script — never written to disk,
  never logged. (Auth precedence: `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`.)
- The watcher's state file (`.bridge-state/issues.json`) contains only
  issue numbers, titles, label names, URLs, fingerprints, and the
  computed status. No bodies. No comments. No tokens.
- The report itself is plain Markdown — safe to share with the team.
- `reports/` is gitignored except for `.gitkeep`. Reports do not land
  in commits.
