// Adversyn bridge — per-repo registry.
// Loads repos/*.json, resolves the right repo for an issue / plain task,
// and exposes lookup helpers used by the watchers and submit script.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = path.resolve(HERE, '..', '..', 'repos');

let _cache = null;

export function loadRepos() {
  if (_cache) return _cache;
  if (!fs.existsSync(REPOS_DIR)) { _cache = []; return _cache; }
  const out = [];
  for (const f of fs.readdirSync(REPOS_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(REPOS_DIR, f), 'utf8'));
      if (c && c.name && c.full_name && c.local_path) out.push(c);
    } catch {
      /* skip malformed */
    }
  }
  _cache = out;
  return out;
}

export function findByFullName(fullName) {
  return loadRepos().find((r) => r.full_name === fullName) || null;
}

export function findByName(name) {
  return loadRepos().find((r) => r.name === name) || null;
}

export function defaultRepo() {
  return findByFullName('Adversyn/adversyn-brain') || loadRepos()[0] || null;
}

export function listAllowedRepos() {
  // Filter by AGENT_EXECUTION_ALLOWED_REPOS env var (comma-separated full_names).
  // If unset, all loaded repos are returned (subject to allow_agent_execution flag).
  const repos = loadRepos();
  const allow = (process.env.AGENT_EXECUTION_ALLOWED_REPOS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return repos;
  return repos.filter((r) => allow.includes(r.full_name));
}

// Heuristic resolver for plain-English tasks. Used by submit-plain-task.mjs.
// Inputs are plain strings; output is the picked repo or null.
export function resolveRepoFromText({ where = '', problem = '', expected = '' } = {}) {
  const text = `${where} ${problem} ${expected}`.toLowerCase();
  const repos = loadRepos();
  const score = new Map();
  for (const r of repos) score.set(r, 0);

  // Strong signals — app URL substring or service name in text.
  for (const r of repos) {
    if (r.app_url && text.includes(r.app_url.toLowerCase())) score.set(r, score.get(r) + 5);
    if (r.service_name && text.includes(r.service_name.toLowerCase())) score.set(r, score.get(r) + 5);
    if (text.includes(r.name.toLowerCase())) score.set(r, score.get(r) + 3);
    if (text.includes(r.full_name.toLowerCase())) score.set(r, score.get(r) + 5);
  }

  // Domain hints.
  const tradingHints = ['trading', '8888', '/trading/', 'console debate', 'react', 'vite', 'frontend', 'ui '];
  const bridgeHints  = ['bridge', 'watcher', 'inbox', 'darren report', 'autonomous-github-bridge', 'pm:watch', 'systemd unit', 'nova task', 'schema'];

  const trading = findByName('adversyn-trading-ui');
  const bridge  = findByName('adversyn-brain');
  if (trading) for (const h of tradingHints) if (text.includes(h)) score.set(trading, (score.get(trading) || 0) + 1);
  if (bridge)  for (const h of bridgeHints)  if (text.includes(h)) score.set(bridge,  (score.get(bridge)  || 0) + 1);

  let best = null;
  let bestScore = -1;
  for (const [r, s] of score.entries()) {
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore > 0 ? best : null;
}

// Heuristic agent classifier. Returns { agent_lane, primary_agent, task_type_hint }.
// Codex = focused/scoped/test/CI; Claude = larger/multi-file/architectural; QA-only = verification.
export function classifyAgentLane({ problem = '', expected = '' } = {}) {
  const text = `${problem} ${expected}`.toLowerCase();

  // QA-only signals — anchored to word boundaries so they don't false-fire.
  const qaOnly = /(^|\b)(qa-only|qa only|just verify|baseline qa|capture screenshots only|smoke[ -]test only|audit only)(\b|$)/;
  if (qaOnly.test(text)) {
    return { agent_lane: 'qa-only', primary_agent: 'none', task_type_hint: 'qa' };
  }

  // Codex hints — small, mechanical, single-file.
  const codexHints = [
    'add a regression test', 'add a unit test', 'add unit test', 'fix typo', 'lint fix',
    'one-line fix', 'one line fix', 'rename ', 'update doc', 'fix doc', 'unused import',
    'small fix', 'tweak ', 'css fix', 'simple bug', 'add a test', 'fix a typo',
    'rename a ', 'remove unused', 'tighten ', 'add a comment',
  ];
  // Claude hints — cross-cutting, design, multi-file, refactor, architecture.
  const claudeHints = [
    'refactor', 'redesign', 'architect', 'rework', 'wire up', 'persistence',
    'whole flow', 'multi-file', 'state management', 'observability', 'consolidate',
    'introduce ', 'replace ', 'migrate ', 'rebuild ',
  ];

  const codexScore  = codexHints.reduce((s, h) => s + (text.includes(h) ? 1 : 0), 0);
  const claudeScore = claudeHints.reduce((s, h) => s + (text.includes(h) ? 1 : 0), 0);

  // Test-add hints
  const isTestTask = /\b(add (a |an )?(regression |unit )?test|write tests for)\b/.test(text);

  if (claudeScore > codexScore) return { agent_lane: 'claude', primary_agent: 'none', task_type_hint: 'fix' };
  if (codexScore > 0) return { agent_lane: 'codex', primary_agent: 'none', task_type_hint: isTestTask ? 'test' : 'fix' };

  // Long descriptions tilt toward claude.
  if ((problem + expected).length > 600) return { agent_lane: 'claude', primary_agent: 'none', task_type_hint: 'fix' };

  // Default: small bugs go to codex.
  return { agent_lane: 'codex', primary_agent: 'none', task_type_hint: 'fix' };
}
