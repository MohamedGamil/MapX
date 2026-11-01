// The Full Codebase graph on the generated 2,000-file fixture (M4-20, criterion 2): from switching
// to it until the laid-out graph is painted takes at most 70% of the M4-16 baseline, and no
// main-thread task meanwhile exceeds the budget (the baseline froze the page in one task of about
// 6 s). The median of three runs, each in a fresh browser context. MAPX_UI_PERF_SCALE as in perf.spec.ts.
import { test, expect, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, initAndScan } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

declare const window: any;
declare const document: any;
declare function requestAnimationFrame(cb: () => void): number;
declare class PerformanceObserver { constructor(cb: (l: any) => void); observe(o: any): void; }

test.skip(!!browserMissing(), browserMissing() ?? '');

const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'budgets.json'), 'utf8'));
const scale = Number(process.env.MAPX_UI_PERF_SCALE ?? '1') || 1;

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('perf2000', (root) => {
    generate(root, 2000);
    initAndScan(root);
  });
});
test.afterAll(() => served?.stop());

async function timeFullGraph(browser: Browser, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const pageErrors = watchErrors(page);
    await page.goto(served.url);
    await graphReady(page);
    await page.evaluate(() => {
      window.__lt = [];
      new PerformanceObserver((l: any) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' });
      window.__t0 = performance.now();
    });
    await page.selectOption('#select-graph-mode', 'full');
    await page.waitForFunction(() => document.body.dataset.graph === 'ready' && performance.now() - window.__t0 > 50, null, { timeout: 120_000, polling: 20 });
    const result: { ms: number; longest: number } = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      ms: Math.round(performance.now() - window.__t0),
      longest: Math.round(Math.max(0, ...window.__lt.filter((t: any) => t.start >= window.__t0).map((t: any) => t.ms))),
    })))));
    errors.push(...pageErrors);
    return result;
  } finally {
    await context.close();
  }
}

test('the Full Codebase graph of 2,000 files is ready within 70% of the M4-16 baseline, without freezing the page', async ({ browser }) => {
  const { baselineMs, target, maxLongTaskMs } = budgets.fullGraph2000;
  const budget = Math.round(baselineMs * target * scale);
  const longBudget = Math.round(maxLongTaskMs * scale);
  const errors: string[] = [];
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await timeFullGraph(browser, errors));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1]!;
  const ms = median(runs.map((r) => r.ms));
  const longest = median(runs.map((r) => r.longest));
  console.log(`[perf] fullGraph2000 runs ${runs.map((r) => `${r.ms} ms (longest task ${r.longest} ms)`).join(', ')}; median ${ms} ms against ${budget} ms; longest task median ${longest} ms against ${longBudget} ms (scale ${scale})`);
  expect(errors).toEqual([]);
  expect(ms, `median of ${runs.map((r) => r.ms).join(', ')} ms`).toBeLessThanOrEqual(budget);
  expect(longest, `longest main-thread task, median of ${runs.map((r) => r.longest).join(', ')} ms`).toBeLessThanOrEqual(longBudget);
});

test('without the layout worker, the graph is laid out on the main thread', async ({ page }) => {
  const errors = watchErrors(page);
  await page.route('**/layout-worker.js', (route) => route.abort());
  await page.goto(served.url);
  await graphReady(page);
  await page.selectOption('#select-graph-mode', 'full');
  await page.waitForFunction(() => document.body.dataset.graph === 'ready', null, { timeout: 120_000, polling: 50 });
  expect(await page.evaluate(() => document.body.dataset.layoutMs)).toBeUndefined(); // the worker never answered
  expect(errors).toEqual([]);
});
