/**
 * Adversyn Autonomous Site QA
 *
 * Hits APP_BASE_URL, walks every internal route from the nav, clicks every
 * SAFE button, modifies SAFE inputs, verifies persistence, screenshots every
 * major page, and fails on broken routes / hydration errors / fatal console
 * errors / missing critical UI.
 *
 * Hard guardrails (do not weaken without explicit approval):
 *   - never click destructive selectors
 *   - never force-close trades
 *   - never execute live trading
 *   - never submit real-money actions
 *
 * Configuration via env (set in repo Variables/Secrets):
 *   APP_BASE_URL    — e.g. https://app.adversyn.example  (defaults to http://localhost:3000)
 *   QA_USERNAME     — optional login user
 *   QA_PASSWORD     — optional login pass
 *   QA_AUTH_MODE    — none | basic | form  (default: form when QA_USERNAME present, else none)
 *   QA_SKIP_LOGIN   — "true" to skip login entirely
 */

import { expect, test, type Page, type ConsoleMessage } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const SKIP_LOGIN = (process.env.QA_SKIP_LOGIN || '').toLowerCase() === 'true';
const QA_USER = process.env.QA_USERNAME || '';
const QA_PASS = process.env.QA_PASSWORD || '';
const AUTH_MODE = (process.env.QA_AUTH_MODE || (QA_USER ? 'form' : 'none')).toLowerCase();

const DESTRUCTIVE_TOKENS = [
  'delete',
  'remove',
  'force-close',
  'force close',
  'liquidate',
  'live-trade',
  'live trade',
  'execute-live',
  'execute live',
  'reset',
  'wipe',
  'purge',
  'sign out',
  'sign-out',
  'logout',
  'log out',
  'cancel order',
  'close trade',
  'close position',
  'place order',
  'submit order',
];

const RESULTS_DIR = path.resolve('test-results');
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, 'autonomous-qa');
const SUMMARY_PATH = path.join(RESULTS_DIR, 'autonomous-qa-summary.json');

type Summary = {
  baseUrl: string;
  startedAt: string;
  finishedAt?: string;
  routesVisited: string[];
  buttonsClicked: { route: string; label: string }[];
  inputsModified: { route: string; selector: string; value: string }[];
  persistenceChecks: { route: string; selector: string; before: string; after: string; persisted: boolean }[];
  consoleErrors: { route: string; text: string }[];
  pageErrors: { route: string; text: string }[];
  failures: { route: string; reason: string }[];
  screenshots: string[];
  status: 'pass' | 'fail' | 'unknown';
};

const summary: Summary = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  routesVisited: [],
  buttonsClicked: [],
  inputsModified: [],
  persistenceChecks: [],
  consoleErrors: [],
  pageErrors: [],
  failures: [],
  screenshots: [],
  status: 'unknown',
};

function ensureDirs() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function isDestructive(text: string | null | undefined): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return DESTRUCTIVE_TOKENS.some((tok) => haystack.includes(tok));
}

function safeRouteSlug(routePath: string): string {
  const slug = routePath.replace(/[^a-z0-9-_]/gi, '_').replace(/_+/g, '_');
  return slug || 'root';
}

async function captureScreenshot(page: Page, label: string) {
  ensureDirs();
  const file = path.join(SCREENSHOTS_DIR, `${Date.now()}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  summary.screenshots.push(file);
}

function attachConsoleListeners(page: Page, currentRouteRef: { value: string }) {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      summary.consoleErrors.push({ route: currentRouteRef.value, text: msg.text() });
    }
  });
  page.on('pageerror', (err) => {
    summary.pageErrors.push({ route: currentRouteRef.value, text: String(err) });
  });
}

async function maybeLogin(page: Page) {
  if (SKIP_LOGIN || AUTH_MODE === 'none') return;
  if (!QA_USER || !QA_PASS) return;

  try {
    const userField = page.locator(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="user" i], input[id*="email" i]'
    ).first();
    const passField = page.locator(
      'input[type="password"], input[name="password"], input[id*="pass" i]'
    ).first();
    if ((await userField.count()) === 0 || (await passField.count()) === 0) return;

    await userField.fill(QA_USER);
    await passField.fill(QA_PASS);

    const submit = page.locator(
      'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")'
    ).first();
    if ((await submit.count()) > 0 && !isDestructive(await submit.innerText().catch(() => ''))) {
      await submit.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    }
    await captureScreenshot(page, 'after-login');
  } catch {
    /* login is best-effort */
  }
}

async function discoverRoutesFromNav(page: Page): Promise<string[]> {
  const found = new Set<string>(['/']);
  const hrefs = await page
    .locator('nav a[href], header a[href], aside a[href], [role="navigation"] a[href], a[data-testid*="nav" i][href]')
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href') || ''));
  for (const h of hrefs) {
    if (!h) continue;
    if (h.startsWith('http')) {
      try {
        const u = new URL(h);
        if (u.origin === new URL(BASE_URL).origin) found.add(u.pathname || '/');
      } catch {
        /* ignore */
      }
      continue;
    }
    if (h.startsWith('/') && !h.startsWith('//')) {
      const clean = h.split('#')[0].split('?')[0] || '/';
      found.add(clean);
    }
  }
  return Array.from(found);
}

async function exerciseSafeButtons(page: Page, route: string) {
  const buttons = page.locator('button:visible, [role="button"]:visible');
  const count = Math.min(await buttons.count(), 12);
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const label = (await btn.innerText().catch(() => ''))?.trim() || (await btn.getAttribute('aria-label')) || '';
    const dataTestId = (await btn.getAttribute('data-testid')) || '';
    const id = (await btn.getAttribute('id')) || '';
    const cls = (await btn.getAttribute('class')) || '';
    const composite = `${label} ${dataTestId} ${id} ${cls}`;

    if (isDestructive(composite)) continue;
    if (!label && !dataTestId) continue;
    const type = (await btn.getAttribute('type')) || '';
    if (type === 'submit') continue;

    try {
      await btn.click({ trial: true, timeout: 1_000 });
    } catch {
      continue;
    }
    try {
      await btn.click({ timeout: 2_500 });
      summary.buttonsClicked.push({ route, label: label || dataTestId });
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    } catch {
      /* skip stubborn buttons */
    }
  }
}

async function exerciseSafeInputs(page: Page, route: string) {
  const inputs = page.locator(
    'input:not([type="password"]):not([type="hidden"]):not([type="file"]):not([readonly]):not([disabled]):visible, textarea:visible'
  );
  const count = Math.min(await inputs.count(), 8);
  const persistenceTargets: { selector: string; before: string; after: string }[] = [];

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const id = (await input.getAttribute('id')) || (await input.getAttribute('name')) || '';
    const placeholder = (await input.getAttribute('placeholder')) || '';
    const type = (await input.getAttribute('type')) || 'text';
    if (isDestructive(`${id} ${placeholder}`)) continue;

    let value = 'qa-' + Math.random().toString(36).slice(2, 8);
    if (type === 'number') value = '1';
    if (type === 'email') value = `qa+${Date.now()}@example.com`;
    if (type === 'date') value = '2026-01-01';
    if (type === 'url') value = 'https://example.com';

    const before = (await input.inputValue().catch(() => '')) || '';
    try {
      await input.fill(value, { timeout: 2_000 });
      summary.inputsModified.push({ route, selector: id || placeholder || 'input', value });
      persistenceTargets.push({ selector: id || placeholder || 'input', before, after: value });
    } catch {
      /* skip */
    }
  }

  const saveBtn = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /^(save|update|apply|submit)\b/i })
    .first();

  if ((await saveBtn.count()) > 0 && !isDestructive((await saveBtn.innerText().catch(() => '')) || '')) {
    try {
      await saveBtn.click({ timeout: 3_000 });
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      await page.reload({ timeout: 15_000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});

      for (const t of persistenceTargets) {
        const sel = t.selector;
        const probe = page.locator(`#${CSS.escape(sel)}, [name="${sel}"], [placeholder="${sel}"]`).first();
        if ((await probe.count()) === 0) continue;
        const after = (await probe.inputValue().catch(() => '')) || '';
        summary.persistenceChecks.push({
          route,
          selector: sel,
          before: t.before,
          after,
          persisted: after === t.after,
        });
      }
    } catch {
      /* save flow is best-effort */
    }
  }
}

async function checkPageHealth(page: Page, route: string) {
  const status = page.url();
  if (/\/404(?:[/?#]|$)/.test(status)) {
    summary.failures.push({ route, reason: '404 page reached' });
  }
  const h1 = await page.locator('h1, [role="heading"][aria-level="1"]').first().textContent().catch(() => '');
  if (!h1 && route !== '/') {
    // not necessarily fatal, but flag
    summary.failures.push({ route, reason: 'no <h1> / heading on page' });
  }
  const fatalText = await page
    .locator('text=/Application error|Hydration|ChunkLoadError|Internal Server Error/i')
    .first()
    .textContent()
    .catch(() => '');
  if (fatalText) {
    summary.failures.push({ route, reason: `fatal text on page: ${fatalText.slice(0, 120)}` });
  }
}

test.describe('Adversyn Autonomous Site QA', () => {
  test.setTimeout(120_000);

  test('walk site, exercise UI, verify health', async ({ page }) => {
    ensureDirs();
    const currentRoute = { value: '/' };
    attachConsoleListeners(page, currentRoute);

    const landing = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    expect(landing, 'failed to load APP_BASE_URL').not.toBeNull();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await captureScreenshot(page, 'landing');
    await maybeLogin(page);

    const routes = await discoverRoutesFromNav(page);
    for (const route of routes) {
      currentRoute.value = route;
      const target = new URL(route, BASE_URL).toString();
      try {
        const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        if (resp && resp.status() >= 400) {
          summary.failures.push({ route, reason: `HTTP ${resp.status()}` });
          continue;
        }
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        summary.routesVisited.push(route);
        await captureScreenshot(page, `route-${safeRouteSlug(route)}`);
        await checkPageHealth(page, route);
        await exerciseSafeButtons(page, route);
        await exerciseSafeInputs(page, route);
      } catch (err) {
        summary.failures.push({ route, reason: `exception: ${(err as Error).message}` });
      }
    }

    summary.finishedAt = new Date().toISOString();
    const fatalConsole = summary.consoleErrors.length;
    const pageErrs = summary.pageErrors.length;
    summary.status = summary.failures.length === 0 && fatalConsole === 0 && pageErrs === 0 ? 'pass' : 'fail';

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

    expect.soft(summary.routesVisited.length, 'no routes were visited').toBeGreaterThan(0);
    expect(summary.failures, `failures recorded: ${JSON.stringify(summary.failures)}`).toEqual([]);
    expect(summary.pageErrors, `pageerrors recorded: ${JSON.stringify(summary.pageErrors)}`).toEqual([]);
    expect(
      summary.consoleErrors,
      `fatal console errors: ${JSON.stringify(summary.consoleErrors.slice(0, 5))}`
    ).toEqual([]);
  });
});
