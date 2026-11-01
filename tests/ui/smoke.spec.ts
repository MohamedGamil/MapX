// Every dashboard tab renders its content in Chromium with no console error, page error or failed
// /api request (M4-19, criterion 1). The fixture: generated sources plus a Laravel app with routes
// and a Vue component calling it, scanned with the source CLI, and one logged MCP tool call.
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initAndScan, smokeWorkspace } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

test.skip(!!browserMissing(), browserMissing() ?? '');

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('smoke', (root) => {
    smokeWorkspace(root);
    initAndScan(root);
    const call = { tool: 'mapx_query', input: { pattern: 'OrderController' }, timestamp: new Date().toISOString(), durationMs: 12, success: true };
    writeFileSync(join(root, '.mapx/tool-calls.jsonl'), JSON.stringify(call) + '\n');
  });
});
test.afterAll(() => served?.stop());

/** Each tab with what its main panel must show once loaded. */
const TABS: Array<{ tab: string; shows: (page: Page) => Promise<void> }> = [
  {
    tab: 'graph',
    shows: async (page) => {
      await graphReady(page);
      await expect(page.locator('#cy canvas').first()).toBeAttached();
    },
  },
  {
    tab: 'symbols',
    shows: async (page) => {
      await expect(page.locator('#table-symbols tbody tr').first()).toBeVisible();
      await expect(page.locator('#symbol-page-info')).not.toHaveText('—');
    },
  },
  {
    tab: 'routes',
    shows: async (page) => {
      await expect(page.locator('#table-routes tbody')).toContainText('/orders');
      await expect(page.locator('#table-routes tbody tr')).toHaveCount(2);
    },
  },
  {
    tab: 'architecture',
    shows: async (page) => {
      await expect(page.locator('#arch-profile-details')).not.toContainText('Loading');
      await expect(page.locator('#arch-profile-details')).toContainText(/laravel/i);
      await expect(page.locator('#arch-dsm-matrix table.dsm-table')).toBeVisible();
      await expect(page.locator('#arch-smells-list')).not.toContainText('Loading');
    },
  },
  {
    tab: 'context',
    shows: async (page) => {
      await page.fill('#context-task', 'How are orders listed?');
      await page.click('#btn-build-context');
      await expect(page.locator('#context-results')).toContainText('Key Context Files');
    },
  },
  {
    tab: 'metrics',
    shows: async (page) => {
      await expect(page.locator('#metrics-summary')).not.toContainText('Loading');
      await expect(page.locator('#metrics-languages')).toContainText(/typescript/i);
      await expect(page.locator('#top-files-list li').first()).toBeVisible();
    },
  },
  {
    tab: 'tool-log',
    shows: async (page) => {
      await expect(page.locator('#tool-log-container .log-entry')).toHaveCount(1);
      await expect(page.locator('#tool-log-container .log-entry')).toContainText('mapx_query');
    },
  },
];

test('the sidebar lists exactly the tabs this spec covers', async ({ page }) => {
  await page.goto(served.url);
  const tabs = await page.locator('.nav-item[data-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab')));
  expect(tabs.sort()).toEqual(TABS.map((t) => t.tab).sort());
});

for (const { tab, shows } of TABS) {
  test(`${tab} tab renders its content without errors`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(served.url);
    await graphReady(page); // the default tab; its load runs whichever tab is opened
    await page.click(`.nav-item[data-tab="${tab}"]`);
    await expect(page.locator(`#tab-${tab}`)).toHaveClass(/active/);
    await shows(page);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
}

test('a layout engine other than fCoSE loads on first use and lays out the graph (M4-20)', async ({ page }) => {
  const errors = watchErrors(page);
  // Script bytes (decoded) fetched per chunk name, recorded as responses arrive.
  const loaded = new Map<string, number>();
  page.on('response', async (r) => {
    if (!r.url().includes('/chunks/')) return;
    const name = r.url().split('/').pop()!;
    loaded.set(name, (await r.body().catch(() => Buffer.alloc(0))).length);
  });
  const engineBytes = (layout: string) => [...loaded].filter(([n]) => n.startsWith(`cytoscape-${layout}-`)).reduce((n, [, b]) => n + b, 0);
  await page.goto(served.url);
  await graphReady(page);
  expect(engineBytes('elk')).toBe(0); // not part of the first load
  // Each engine arrives on first use, with its code: a chunk holding the engine itself, not a
  // re-export of code the first load already carried.
  const minBytes: Record<string, number> = { elk: 500_000, dagre: 20_000, cola: 40_000 };
  for (const layout of ['elk', 'dagre', 'cola']) {
    await page.selectOption('#select-layout', layout);
    await graphReady(page);
    await expect.poll(() => engineBytes(layout), { message: layout }).toBeGreaterThan(minBytes[layout]!);
  }
  expect(errors).toEqual([]);
});
