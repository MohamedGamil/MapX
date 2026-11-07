// Multi-repo workspaces in the dashboard (M4-21, criterion 3): a repo switcher (All plus each repo)
// kept in the URL, a workspace overview, every view scoped to the chosen repo, and cross-repo
// edges drawn distinctly. The fixture registers three repos: the primary, web (axios) and api (Laravel).
import { test, expect, type Page } from '@playwright/test';
import { basename } from 'node:path';
import { initAndScanMultiRepo, multiRepoWorkspace } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

declare const window: any;

test.skip(!!browserMissing(), browserMissing() ?? '');

let served: Awaited<ReturnType<typeof servedWorkspace>>;
let primary: string;

test.beforeAll(async () => {
  served = await servedWorkspace('repos', (root) => {
    multiRepoWorkspace(root);
    initAndScanMultiRepo(root);
  });
  primary = basename(served.root);
});
test.afterAll(() => served?.stop());

async function fullGraphFiles(page: Page): Promise<number> {
  await page.click('.nav-item[data-tab="graph"]');
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  return page.evaluate(() => window.__mapxStats().nodes);
}

test('the switcher lists all repos, scopes every view, and is kept in the URL', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(served.url);
  await graphReady(page);
  await expect(page.locator('#repo-switcher')).toBeVisible();
  // /api/repos (git state per repo) may answer after the graph: wait for the options.
  await expect(page.locator('#select-repo option')).toHaveText(['All repos (3)', primary, 'web', 'api']);
  expect(await fullGraphFiles(page)).toBe(9); // 2 + 3 + 4 files

  await page.selectOption('#select-repo', 'web');
  await expect(page).toHaveURL(/\?repo=web$/);
  await graphReady(page); // the switch reloads the graph, in the view chosen (Full Codebase)
  expect(await page.evaluate(() => window.__mapxStats().nodes)).toBe(3);
  await expect(page.locator('#stat-files')).toHaveText('3');
  expect(await fullGraphFiles(page)).toBe(3);

  await page.click('.nav-item[data-tab="symbols"]');
  await expect(page.locator('#table-symbols tbody tr').first()).toBeVisible();
  const files = await page.locator('#table-symbols tbody td:last-child').allTextContents();
  expect(files.length).toBeGreaterThan(0);
  expect(files.every((f) => f.startsWith('web/'))).toBe(true);

  await page.click('.nav-item[data-tab="routes"]');
  await expect(page.locator('#table-routes tbody')).toContainText('No framework routes'); // web has none

  await page.click('.nav-item[data-tab="metrics"]');
  await expect(page.locator('[data-scope-note]').first()).toBeHidden();
  await expect(page.locator('#metrics-summary')).toContainText('3');

  // A reload keeps the repo; another repo by URL.
  await page.goto(`${served.url}?repo=api`);
  await graphReady(page);
  await expect(page.locator('#select-repo')).toHaveValue('api');
  expect(await fullGraphFiles(page)).toBe(4);
  await page.click('.nav-item[data-tab="routes"]');
  await expect(page.locator('#table-routes tbody tr')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('the workspace overview lists each repo, and a row switches to it', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(served.url);
  await graphReady(page);
  await page.click('.nav-item[data-tab="workspace"]');
  const rows = page.locator('#table-repos tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#workspace-cross')).toContainText('web');
  await expect(page.locator('#workspace-cross .cross-pair')).toContainText('3 edges');
  await page.locator('#table-repos [data-repo="api"]').click();
  await expect(page).toHaveURL(/\?repo=api$/);
  await expect(page.locator('#table-repos tr.current-repo')).toContainText('api');
  // Per-repo views name the repo they show while "All repos" is chosen.
  await page.selectOption('#select-repo', '');
  await page.click('.nav-item[data-tab="architecture"]');
  await expect(page.locator('#tab-architecture [data-scope-note]')).toContainText(`primary repo, ${primary}`);
  expect(errors).toEqual([]);
});

test('cross-repo edges are drawn distinctly', async ({ page }) => {
  await page.goto(served.url);
  await graphReady(page);
  await fullGraphFiles(page);
  const cross = await page.evaluate(() => window.__mapxEdge('web/src/api/orders.ts', 'api/app/Http/Controllers/OrderController.php'));
  const local = await page.evaluate(() => window.__mapxEdge('api/app/Http/Controllers/OrderController.php', 'api/app/Services/OrderService.php'));
  expect(cross).toMatchObject({ crossRepo: true, lineStyle: 'dashed' });
  expect(local).toMatchObject({ crossRepo: false, lineStyle: 'solid' });
  expect(cross.color).not.toBe(local.color);
});

test('an unknown repo in the URL falls back to all repos, and every view loads (review 2026-11-02)', async ({ page }) => {
  await page.goto(`${served.url}?repo=nope`);
  await expect(page.locator('#select-repo')).toHaveValue('');
  await expect(page).not.toHaveURL(/repo=/);
  await graphReady(page);
  expect(await fullGraphFiles(page)).toBe(9);
  await page.click('.nav-item[data-tab="symbols"]');
  await expect(page.locator('#table-symbols tbody tr').first()).toBeVisible();
});

test('a response for a repo switched away from is dropped (review 2026-11-02)', async ({ page }) => {
  await page.goto(served.url);
  await graphReady(page);
  await page.click('.nav-item[data-tab="graph"]');
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  // web's answers arrive late; api is chosen meanwhile.
  await page.route(/\/api\/(graph|metrics|symbols)\?.*repo=web/, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  await page.selectOption('#select-repo', 'web');
  await page.selectOption('#select-repo', 'api');
  await page.waitForTimeout(3500);
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  expect(await page.evaluate(() => window.__mapxStats().nodes)).toBe(4);
  await page.click('.nav-item[data-tab="metrics"]');
  await expect(page.locator('#metrics-summary .stat-tile-value').first()).toHaveText('4');
  await page.click('.nav-item[data-tab="symbols"]');
  const files = await page.locator('#table-symbols tbody td:last-child').allTextContents();
  expect(files.length).toBeGreaterThan(0);
  expect(files.every((f) => f.startsWith('api/'))).toBe(true);
});
