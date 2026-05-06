// Minimal GitHub REST helper using Node 20 fetch.
// Auth precedence: GITHUB_TOKEN env > GH_TOKEN env > gh auth token.
// Token is held in memory only. Never logged. Never written to disk.

import { spawnSync } from 'node:child_process';

const API = 'https://api.github.com';

let _cachedToken = null;

export function resolveToken() {
  if (_cachedToken) return _cachedToken;
  if (process.env.GITHUB_TOKEN) return (_cachedToken = process.env.GITHUB_TOKEN);
  if (process.env.GH_TOKEN) return (_cachedToken = process.env.GH_TOKEN);
  // Fallback: ask gh CLI for the cached token. Silent fail.
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    return (_cachedToken = r.stdout.trim());
  }
  return null;
}

export function resolveRepo() {
  // Try env first.
  if (process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    if (owner && repo) return { owner, repo };
  }
  // Read git remote.
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (r.status === 0) {
    const url = r.stdout.trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

async function ghFetch(pathOrUrl, init = {}) {
  const token = resolveToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'adversyn-bridge',
    ...(init.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

export async function createIssue({ owner, repo, title, body, labels }) {
  return ghFetch(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels }),
  });
}

export async function getIssue({ owner, repo, number }) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}`);
}

export async function listIssueComments({ owner, repo, number }) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
}

export async function getPR({ owner, repo, number }) {
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`);
}

export async function listPRFiles({ owner, repo, number }) {
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
}

export async function listIssuesByLabel({ owner, repo, labels, state = 'all', perPage = 50 }) {
  const q = new URLSearchParams({
    state,
    labels: Array.isArray(labels) ? labels.join(',') : labels,
    per_page: String(perPage),
    sort: 'updated',
    direction: 'desc',
  });
  return ghFetch(`/repos/${owner}/${repo}/issues?${q.toString()}`);
}

export async function listCheckRuns({ owner, repo, ref }) {
  return ghFetch(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`);
}

export async function listWorkflowRuns({ owner, repo, branch, perPage = 10 }) {
  const q = new URLSearchParams({ per_page: String(perPage) });
  if (branch) q.set('branch', branch);
  return ghFetch(`/repos/${owner}/${repo}/actions/runs?${q.toString()}`);
}

export async function listRunArtifacts({ owner, repo, runId }) {
  return ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
}

export async function postIssueComment({ owner, repo, number, body }) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function addLabels({ owner, repo, number, labels }) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
}

export async function removeLabel({ owner, repo, number, name }) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}
