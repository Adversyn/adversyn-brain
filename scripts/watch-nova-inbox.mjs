#!/usr/bin/env node
/**
 * Adversyn Autonomous Bridge — nova-inbox watcher.
 *
 * Watches nova-inbox/*.json for new task files. For each file, runs the
 * Nova → GitHub issue intake. On success, moves the file to
 * nova-inbox/processed/<YYYY-MM-DD>-<n>-<basename>.json. On failure, moves
 * it to nova-inbox/failed/. Appends to nova-inbox/log.ndjson.
 *
 * Usage:
 *   node scripts/watch-nova-inbox.mjs              # one-shot (CI / cron)
 *   node scripts/watch-nova-inbox.mjs --watch      # continuous (poll every 5s)
 *   node scripts/watch-nova-inbox.mjs --interval 15
 *   node scripts/watch-nova-inbox.mjs --dry-run    # validates only, no GitHub call
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INBOX = path.join(ROOT, 'nova-inbox');
const PROCESSED = path.join(INBOX, 'processed');
const FAILED = path.join(INBOX, 'failed');
const LOG = path.join(INBOX, 'log.ndjson');
const INTAKE = path.join(HERE, 'create-github-issue-from-nova.mjs');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const dryRun = args.includes('--dry-run');
const intervalArg = args.indexOf('--interval');
const intervalSec = intervalArg >= 0 ? parseInt(args[intervalArg + 1], 10) : 5;

for (const d of [INBOX, PROCESSED, FAILED]) fs.mkdirSync(d, { recursive: true });

function ts() { return new Date().toISOString(); }
function logLine(obj) {
  fs.appendFileSync(LOG, JSON.stringify({ ts: ts(), ...obj }) + '\n', 'utf8');
}

function listInboxFiles() {
  return fs.readdirSync(INBOX, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json') && d.name !== '.gitkeep')
    .map((d) => path.join(INBOX, d.name));
}

function moveTo(target, file, suffix = '') {
  fs.mkdirSync(target, { recursive: true });
  const base = path.basename(file, '.json');
  const stamp = ts().replace(/[:.]/g, '-');
  const name = `${stamp}-${base}${suffix}.json`;
  const dest = path.join(target, name);
  fs.renameSync(file, dest);
  return dest;
}

function processFile(file) {
  const nodeArgs = [INTAKE, file, ...(dryRun ? ['--dry-run'] : [])];
  const r = spawnSync('node', nodeArgs, { encoding: 'utf8' });
  let result = null;
  // Intake emits one JSON object per invocation (possibly pretty-printed across
  // multiple lines). Parse the full stdout, then fall back to the last line.
  if (r.stdout && r.stdout.trim()) {
    try { result = JSON.parse(r.stdout.trim()); }
    catch {
      try { result = JSON.parse(r.stdout.trim().split('\n').pop()); }
      catch { /* keep null */ }
    }
  }
  const ok = r.status === 0 && result && result.ok;
  const summary = {
    file: path.basename(file),
    ok,
    code: r.status,
    issue_url: result?.issue_url || null,
    number: result?.number || null,
    labels: result?.labels || null,
    error: result?.error || (r.stderr ? r.stderr.trim().slice(0, 600) : null),
    dry_run: !!result?.dry_run,
  };
  logLine(summary);
  if (dryRun) {
    // In dry-run we don't move files — nothing was actually created.
    return summary;
  }
  if (ok) moveTo(PROCESSED, file);
  else moveTo(FAILED, file, '.failed');
  return summary;
}

async function tick() {
  const files = listInboxFiles();
  if (files.length === 0) return [];
  const results = [];
  for (const f of files) {
    const s = processFile(f);
    results.push(s);
    process.stdout.write(JSON.stringify(s) + '\n');
  }
  return results;
}

(async () => {
  if (!watchMode) {
    const r = await tick();
    process.stdout.write(JSON.stringify({ ok: true, processed: r.length, results: r }, null, 2) + '\n');
    process.exit(0);
  }
  // Continuous mode.
  process.stdout.write(JSON.stringify({ ok: true, watching: INBOX, interval_sec: intervalSec }) + '\n');
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      process.stdout.write(JSON.stringify({ ok: true, stopping_on: sig }) + '\n');
      process.exit(0);
    });
  }
  while (!stopping) {
    try { await tick(); } catch (e) {
      logLine({ event: 'tick_error', error: String(e.message || e) });
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
})();
