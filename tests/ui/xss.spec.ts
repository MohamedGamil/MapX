// Scanned values never run as script in the dashboard (M4-24): a route path, a file name (also in
// an import cycle) and a logged tool call carry `<img src=x onerror=window.__xss=1>`. Every tab
// is opened, the focus search lists the file, and the payload must show as text while
// window.__xss stays unset.
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XSS, initAndScan, xssWorkspace } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace } from './harness.js';

declare const window: any;

test.skip(!!browserMissing(), browserMissing() ?? '');

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('xss', (root) => {
    xssWorkspace(root);
    initAndScan(root);
    const call = { tool: `mapx_query${XSS}`, input: { pattern: XSS }, timestamp: new Date().toISOString(), durationMs: 3, success: false, error: XSS };
    writeFileSync(join(root, '.mapx/tool-calls.jsonl'), JSON.stringify(call) + '\n');
  });
});
test.afterAll(() => served?.stop());

const fired = (page: Page) => page.evaluate(() => window.__xss === 1);

async function open(page: Page, tab: string) {
  await page.click(`.nav-item[data-tab="${tab}"]`);
  await expect(page.locator(`#tab-${tab}`)).toHaveClass(/active/);
  await page.waitForLoadState('networkidle');
}

test('no scanned value runs as script, and each payload shows as text', async ({ page }) => {
  await page.goto(served.url);
  await graphReady(page);

  await open(page, 'routes');
  await expect(page.locator('#table-routes tbody')).toContainText(`/x${XSS}`);

  await open(page, 'symbols');
  await page.fill('#symbol-search', 'evilFn');
  await expect(page.locator('#table-symbols tbody')).toContainText(`evil${XSS}.ts`);
  await page.locator('#table-symbols tbody .link-btn').first().click();
  await expect(page.locator('#symbol-detail-view')).toContainText(`evil${XSS}.ts`);

  await open(page, 'architecture');
  await expect(page.locator('#arch-smells-list')).toContainText(`evil${XSS}.ts`);

  await open(page, 'metrics');
  await expect(page.locator('#tab-metrics')).not.toContainText('Loading');

  await open(page, 'tool-log');
  await expect(page.locator('#tool-log-container .log-entry')).toContainText(`mapx_query${XSS}`);

  await open(page, 'context');
  await page.fill('#context-task', 'evilFn loop');
  await page.click('#btn-build-context');
  await expect(page.locator('#context-results')).toContainText('Key Context Files');

  await open(page, 'graph');
  await page.selectOption('#select-graph-mode', 'focus');
  await page.fill('#focus-search-input', 'onerror');
  await expect(page.locator('#focus-autocomplete')).toContainText(`evil${XSS}.ts`);

  await page.waitForTimeout(500); // an injected <img> fails to load asynchronously
  expect(await fired(page)).toBe(false);
});
