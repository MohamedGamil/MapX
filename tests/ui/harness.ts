// Shared pieces of the dashboard browser tests (M4-19): a served fixture workspace per spec file,
// the browser check, and a collector of console errors, page errors and failed /api requests.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { chromium, type Page } from '@playwright/test';
import { serve } from '../../scripts/ui/workspace.js';

/** Why the browser tests cannot run here, or null when Chromium is installed. */
export function browserMissing(): string | null {
  let path = '';
  try { path = chromium.executablePath(); } catch { /* unknown platform */ }
  return path && existsSync(path) ? null : 'Chromium is not installed, so the dashboard browser tests are skipped: run `npx playwright install chromium`.';
}

export interface Served { root: string; url: string; child: ChildProcess }

/** Creates a temp workspace with `build`, then serves it; `stop` kills the server and deletes it. */
export async function servedWorkspace(prefix: string, build: (root: string) => void): Promise<Served & { stop(): void }> {
  const root = mkdtempSync(join(tmpdir(), `mapx-ui-${prefix}-`));
  try {
    build(root);
    const { url, child } = await serve(root);
    return { root, url, child, stop() { child.kill(); rmSync(root, { recursive: true, force: true }); } };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/** Collects what the dashboard must never produce: console errors, page errors, failed /api calls. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) errors.push(`api ${r.status()}: ${r.url()}`); });
  page.on('requestfailed', (r) => {
    // A request cut off by a later navigation or reload is not a failure of the dashboard.
    if (r.url().includes('/api/') && r.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(`api failed: ${r.url()} (${r.failure()?.errorText})`);
  });
  return errors;
}

/** Waits for the dashboard's graph to finish its layout (`<body data-graph="ready">`, M4-19). */
export async function graphReady(page: Page, timeout = 120_000) {
  await page.waitForSelector('body[data-graph="ready"]', { timeout, state: 'attached' });
}

/** The dashboard's tabs, as its navigation lists them (M4-24-R1: a spec can prove it opened each). */
export async function navTabs(page: Page): Promise<string[]> {
  const tabs = await page.locator('.nav-item[data-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab') ?? ''));
  return [...new Set(tabs)].sort();
}

/** Opens `tab` from the navigation and waits for it to show and for its requests to settle. */
export async function openTab(page: Page, tab: string) {
  await page.click(`.nav-item[data-tab="${tab}"]`);
  await page.locator(`#tab-${tab}.active`).waitFor({ state: 'attached' });
  await page.waitForLoadState('networkidle');
}
