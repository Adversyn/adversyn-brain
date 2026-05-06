<!--
Adversyn Autonomous GitHub Bridge — PR template.
Agent (Claude Code or Codex) MUST fill out every section before requesting review.
Nova reviews this on GitHub. Darren only intervenes for blocking decisions.
-->

## Summary
<!-- One-paragraph human-readable description of what changed and why. -->

## Linked issue
Closes #<!-- issue number -->

## Agent
- [ ] Claude Code
- [ ] Codex

## Files changed
<!-- Bullet list of files with a one-line note per file. -->
-

## Implementation notes
<!-- Approach, tradeoffs, anything Nova or a future agent needs to know. -->

## QA performed
<!-- What the agent ran locally / in CI. Paste relevant command names. -->
- [ ] `npm ci` (or repo-detected equivalent) succeeded
- [ ] Lint passed (or skipped — script not present)
- [ ] Typecheck passed (or skipped — script not present)
- [ ] Unit tests passed (or skipped — script not present)
- [ ] Build succeeded (or skipped — script not present)

## Playwright coverage
<!-- Routes / buttons / inputs covered by tests/e2e/autonomous-site-qa.spec.ts -->
- Routes:
- Buttons:
- Inputs / persistence checks:
- Console errors observed:

## Screenshots / artifacts
<!-- Link to GitHub Actions artifacts (playwright-report, test-results, qa-report.md). -->
- Playwright report:
- Trace / video:
- qa-report.md:

## Risks
<!-- What could break? Blast radius? -->

## Rollback plan
<!-- Exact steps to revert if this lands badly. -->

## Acceptance criteria checklist
<!-- Copy from the linked issue. Every box must be checked before merge. -->
- [ ] ...
- [ ] ...

## Safety attestations
- [ ] No secrets, tokens, or `.env` files committed
- [ ] No live trading / order placement / force-close actions executed
- [ ] No destructive selectors clicked in QA (`delete`, `remove`, `force-close`, `liquidate`, `live-trade`, `execute-live`, `reset`, `wipe`, `purge`)
- [ ] Production-impacting changes carry the `status:needs-human-approval` label

---
_Generated under the Adversyn Autonomous GitHub Bridge. See `docs/AUTONOMOUS_GITHUB_BRIDGE.md`._
