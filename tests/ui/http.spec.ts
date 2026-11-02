// The HTTP tab (M4-23, criteria 2 and 3): web (axios) calls api (Laravel). The tab lists the calls
// with method, repo-pair and status filters, draws the repo-to-repo flow weighted by calls, and
// shows both ends of a selected call; the graph marks the http edges between the repos.
import { test, expect, type Page } from '@playwright/test';
import { initAndScanMultiRepo, multiRepoWorkspace } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

declare const window: any;

test.skip(!!browserMissing(), browserMissing() ?? '');

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('http', (root) => {
    multiRepoWorkspace(root);
    initAndScanMultiRepo(root);
  });
});
test.afterAll(() => served?.stop());

async function openHttp(page: Page) {
  await page.goto(served.url);
  await graphReady(page);
  await page.click('.nav-item[data-tab="http"]');
  await expect(page.locator('#table-http tbody tr')).toHaveCount(4);
}

test('lists the calls, filters them, and draws the flow between repos', async ({ page }) => {
  const errors = watchErrors(page);
  await openHttp(page);
  await expect(page.locator('#http-summary')).toContainText('Calls');
  expect(await page.locator('#http-summary .stat-tile-value').allTextContents()).toEqual(['4', '3', '1', '1']);

  const links = page.locator('#http-flow .flow-link');
  await expect(links).toHaveCount(2);
  await expect(page.locator('#http-flow .flow-link[data-pair="web→api"] text')).toHaveText('3');
  const widths = await page.locator('#http-flow .flow-link path').evaluateAll((ps) => ps.map((p) => Number(p.getAttribute('stroke-width'))));
  expect(widths[0]).toBeGreaterThan(widths[1]!); // 3 calls draw wider than 1
  await expect(page.locator('#http-flow svg')).toHaveAttribute('aria-label', /web to api: 3; web to No route: 1/);

  await page.selectOption('#http-filter-method', 'GET');
  await expect(page.locator('#table-http tbody tr')).toHaveCount(3);
  await page.selectOption('#http-filter-method', '');
  await page.selectOption('#http-filter-status', 'unmatched');
  await expect(page.locator('#table-http tbody tr')).toHaveCount(1);
  await expect(page.locator('#table-http tbody')).toContainText('/api/nowhere');
  await page.selectOption('#http-filter-status', '');
  await page.locator('#http-flow .flow-link[data-pair="web→api"] path').click();
  await expect(page.locator('#http-filter-pair')).toHaveValue('web→api');
  await expect(page.locator('#table-http tbody tr')).toHaveCount(3);
  await expect(page.locator('#http-count')).toHaveText('3 of 4 calls');
  expect(errors).toEqual([]);
});

test('selecting a call shows both ends, each a way into the graph', async ({ page }) => {
  const errors = watchErrors(page);
  await openHttp(page);
  await page.selectOption('#http-filter-status', 'matched');
  await page.locator('#table-http tbody .link-btn').first().click();
  const detail = page.locator('#http-detail');
  await expect(detail).toContainText('Caller, in web');
  await expect(detail).toContainText('web/src/api/orders.ts:');
  await expect(detail).toContainText('axios.');
  await expect(detail).toContainText('Handler, in api');
  await expect(detail).toContainText('App\\Http\\Controllers\\OrderController@');
  await expect(detail.locator('[data-go-id]')).toHaveCount(2);
  await expect(detail.locator('[data-go-id]').nth(1)).toHaveText(/api\/app\/Http\/Controllers\/OrderController\.php:\d+/);
  await detail.locator('[data-go-id]').nth(1).click();
  await expect(page.locator('#tab-graph')).toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('the graph marks the http edges between repos', async ({ page }) => {
  await page.goto(served.url);
  await graphReady(page);
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  const edge = await page.evaluate(() => window.__mapxEdge('web/src/api/orders.ts', 'api/app/Http/Controllers/OrderController.php'));
  expect(edge).toMatchObject({ type: 'http', crossRepo: true, lineStyle: 'dashed' });
});

test('the no-route pair filters, and a flow link works from the keyboard (review 2026-11-02)', async ({ page }) => {
  await openHttp(page);
  const options = await page.locator('#http-filter-pair option').evaluateAll((os) => os.map((o) => (o as any).value));
  const noRoute = options.find((v: string) => v.startsWith('web→') && v !== 'web→api')!;
  await page.selectOption('#http-filter-pair', noRoute);
  await expect(page.locator('#table-http tbody tr')).toHaveCount(1);
  await expect(page.locator('#table-http tbody')).toContainText('/api/nowhere');
  await page.selectOption('#http-filter-pair', '');
  await page.focus('#http-flow .flow-link.is-none');
  await page.keyboard.press('Enter');
  await expect(page.locator('#http-filter-pair')).toHaveValue(noRoute);
  await expect(page.locator('#table-http tbody tr')).toHaveCount(1);
});
