// Thin wrapper around the gh CLI. Falls back gracefully when gh is missing.
// Never logs tokens or auth output — gh manages its own auth on disk.

import { spawnSync, spawn } from 'node:child_process';

export function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

export function ghAuthOK() {
  if (!ghAvailable()) return false;
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  return r.status === 0;
}

export function ghRun(args, { input } = {}) {
  if (!ghAvailable()) {
    return { ok: false, code: -1, stdout: '', stderr: 'gh CLI not installed' };
  }
  const r = spawnSync('gh', args, { encoding: 'utf8', input });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

export function ghJson(args) {
  const r = ghRun(args);
  if (!r.ok) return { ok: false, error: r.stderr || `gh exited ${r.code}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, error: `gh JSON parse failed: ${e.message}` };
  }
}
