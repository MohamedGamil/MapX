// Render budget for the graph tab (M4-19, criterion 2): on the generated 500-file fixture, the time
// from navigation to the first finished graph layout (the `mapx:graph-ready` mark) must stay within
// the M4-16 baseline plus 20%. The median of three loads is compared, to ride out one slow run.
// MAPX_UI_PERF_SCALE multiplies the budget on slower hardware (CI sets it; see the workflow).
import { test, expect, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, initAndScan } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

declare const performance: any;

test.skip(!!browserMissing(), browserMissing() ?? '');

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8'));
const scale = Number(process.env.MAPX_UI_PERF_SCALE ?? '1') || 1;

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('perf500', (root) => {
    generate(root, 500);
    initAndScan(root);
  });
});
test.afterAll(() => served?.stop());

/**
 * Milliseconds from navigation start to the first finished graph layout, in a fresh browser context
 * (no cached bundle), as the M4-16 audit measured.
 */
async function timeToGraph(browser: Browser, errors: string[]): Promise<number> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const pageErrors = watchErrors(page);
    await page.goto(served.url);
    await graphReady(page);
    const ms = await page.evaluate(() => Math.round(performance.getEntriesByName('mapx:graph-ready')[0].startTime));
    errors.push(...pageErrors);
    return ms;
  } finally {
    await context.close();
  }
}

test('the graph tab renders the 500-file fixture within the M4-16 baseline plus 20%', async ({ browser }) => {
  const errors: string[] = [];
  const { baselineMs, allowance } = budgets.graph500;
  const budget = Math.round(baselineMs * (1 + allowance) * scale);
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) runs.push(await timeToGraph(browser, errors));
  const median = [...runs].sort((a, b) => a - b)[1]!;
  test.info().annotations.push({ type: 'graph500', description: `runs ${runs.join(', ')} ms; median ${median} ms; budget ${budget} ms` });
  console.log(`[perf] graph500 runs ${runs.join(', ')} ms; median ${median} ms; budget ${budget} ms (baseline ${baselineMs} ms +${allowance * 100}%, scale ${scale})`);
  expect(errors).toEqual([]);
  expect(median, `median of ${runs.join(', ')} ms`).toBeLessThanOrEqual(budget);
});
