#!/usr/bin/env node
/**
 * Create a feature branch for an agent working on a GitHub issue.
 *
 * Usage:
 *   node scripts/create-agent-branch.mjs --agent claude --issue 12 --slug fix-marketpulse
 *   node scripts/create-agent-branch.mjs --agent codex  --issue 17 --slug add-formatpercent-tests
 *   node scripts/create-agent-branch.mjs --agent claude --issue 12 --slug X --dry-run
 *
 * Branch name: agent/<agent>/<issue>-<slug>
 * Refuses to:
 *   - run on a dirty working tree (without --force)
 *   - create a duplicate branch
 *   - operate without a real --slug
 */

import { spawnSync } from 'node:child_process';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}
function flag(name) { return process.argv.includes(name); }

const agent = arg('--agent');
const issue = arg('--issue');
const slug = arg('--slug');
const dryRun = flag('--dry-run');
const force = flag('--force');

function bail(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + '\n');
  process.exit(1);
}

if (!agent || !['claude', 'codex'].includes(agent)) bail('--agent must be claude or codex');
if (!issue || !/^\d+$/.test(issue)) bail('--issue must be numeric');
if (!slug || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) bail('--slug must be 3-60 chars, [a-z0-9-]');

const branch = `agent/${agent}/${issue}-${slug}`;

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

const status = git(['status', '--porcelain']);
if (!status.ok) bail('git not available');
if (status.stdout && !force) {
  bail('working tree is dirty — commit, stash, or pass --force', { dirty: status.stdout.split('\n').slice(0, 10) });
}

const exists = git(['rev-parse', '--verify', branch]);
if (exists.ok) bail(`branch already exists: ${branch}`, { branch });

if (dryRun) {
  process.stdout.write(JSON.stringify({ ok: true, dry_run: true, branch }, null, 2) + '\n');
  process.exit(0);
}

const create = git(['checkout', '-b', branch]);
if (!create.ok) bail(`failed to create branch: ${create.stderr}`);

process.stdout.write(JSON.stringify({ ok: true, branch }, null, 2) + '\n');
