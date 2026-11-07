// Dashboard UX/UI audit (docs/baton M4-16, D027). Scans fixture workspaces (a copy of MapX's own
// sources, and generated projects of about 500 and 2,000 files: no private code), serves each with
// `mapx ui`, and drives the dashboard in headless Chromium (Playwright):
// - every tab of the MapX copy at 1440x900, 1024x768 and 390x844: screenshots (JPEG), console
//   errors, failed /api requests, axe accessibility violations by impact;
// - each fixture: time from navigation to a rendered graph, and main-thread long tasks;
// - the dashboard bundle's gzipped size.
// Writes <out>/metrics.json and the screenshots, and prints a summary.
//   npx tsx scripts/ui/audit.ts [--out docs/research/dashboard-ux-audit] [--no-screens] [--sizes 500,2000]
// Exit code 1 when a tab logs a console error or an /api request fails; 2 on setup errors.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from '@playwright/test';
import { REPO, cli, generate, serve } from './workspace.js';

// Code in page.evaluate / waitForFunction runs in the browser. The repo's typecheck has no DOM lib
// (and adding it program-wide would hide mistakes in src/): these module-scoped declarations type
// only this file's in-page callbacks.
declare const document: any;
declare const window: any;
declare class PerformanceObserver { constructor(cb: (list: any) => void); observe(opts: any): void; }

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = resolve(REPO, arg('out') ?? 'docs/research/dashboard-ux-audit');
const SCREENS = !process.argv.includes('--no-screens');
const SIZES = (arg('sizes') ?? '500,2000').split(',').map(Number);
const VIEWPORTS = [{ name: '1440', width: 1440, height: 900 }, { name: '1024', width: 1024, height: 768 }, { name: '390', width: 390, height: 844 }];


const LONGTASK_INIT = `window.__longTasks = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {}`;

/** Navigation to a rendered graph: /api/graph answered and the loading overlay hidden again. */
async function timeGraph(page: Page, url: string) {
  const start = Date.now();
  const graphResponse = page.waitForResponse((r) => r.url().endsWith('/api/graph'), { timeout: 120_000 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const response = await graphResponse;
  const payloadBytes = (await response.body()).length;
  const nodes = (await response.json()).filter((el: any) => !el.data?.source).length;
  await page.waitForFunction(() => {
    const overlay = document.getElementById('graph-loading-overlay');
    return !!document.querySelector('#cy canvas') && (!overlay || overlay.classList.contains('hidden'));
  }, null, { timeout: 120_000 });
  const ms = Date.now() - start;
  const longTasks: number[] = await page.evaluate(() => (window as any).__longTasks ?? []);
  return { ms, nodes, payloadBytes, longTasks: { count: longTasks.length, maxMs: Math.max(0, ...longTasks), totalMs: longTasks.reduce((a, b) => a + b, 0) } };
}

/**
 * Switches the graph to "Full Codebase" (every file drawn) and times it until the main thread
 * settles: the end of the last long task, after 3 s without a new one. The dashboard has no layout
 * event to wait for (M4-19 adds test hooks), so this is a proxy.
 */
async function timeFullGraph(page: Page) {
  await page.evaluate(() => { (window as any).__longEnds = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__longEnds.push(e.startTime + e.duration); }).observe({ type: 'longtask' }); (window as any).__switchAt = performance.now(); });
  await page.selectOption('#select-graph-mode', 'full');
  let seen = -1;
  for (;;) {
    await page.waitForTimeout(3000);
    const n: number = await page.evaluate(() => (window as any).__longEnds.length);
    if (n === seen) break;
    seen = n;
  }
  return page.evaluate(() => {
    const ends: number[] = (window as any).__longEnds;
    const at: number = (window as any).__switchAt;
    return { settledMs: Math.round(ends.length ? Math.max(...ends) - at : 0), longTasks: ends.length };
  });
}

async function auditTabs(browser: Browser, url: string) {
  const tabs: Record<string, any> = {};
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failed: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', (r) => { if (r.url().includes('/api/')) failed.push(`failed ${r.url()}`); });
    await page.goto(url, { waitUntil: 'networkidle' });
    const names: string[] = await page.$$eval('[data-tab]', (els) => [...new Set(els.map((e) => (e as any).dataset.tab!))]);
    for (const tab of names) {
      consoleErrors.length = 0;
      failed.length = 0;
      const button = page.locator(`.nav-item[data-tab="${tab}"]`).first();
      if (await button.isVisible()) await button.click();
      else await page.evaluate((t) => (document.querySelector(`.nav-item[data-tab="${t}"]`) as any)?.click(), tab);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(700);
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      // Content cut off at the right edge: an overflow:hidden layout clips it without page scroll.
      const clipped = await page.evaluate(() => {
        const pane = document.querySelector('.tab-pane.active');
        if (!pane) return 0;
        // No named helpers in here: tsx's keepNames wraps them in __name, which the page lacks.
        let count = 0;
        for (const el of pane.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.right > window.innerWidth + 1) count++;
        }
        return count;
      });
      const entry = (tabs[tab] ??= { viewports: {} });
      entry.viewports[vp.name] = { consoleErrors: [...consoleErrors], failedApi: [...failed], horizontalOverflow: overflowX, clippedElements: clipped };
      if (vp.name === '1440') {
        await page.addScriptTag({ path: AXE });
        const result: any = await page.evaluate(async () => (window as any).axe.run(document, { resultTypes: ['violations'] }));
        entry.axe = result.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
      }
      if (SCREENS) await page.screenshot({ path: join(OUT, `mapx-${tab}-${vp.name}.jpg`), type: 'jpeg', quality: 70, fullPage: false });
    }
    await context.close();
  }
  return tabs;
}

function bundleSizes() {
  const dist = join(REPO, 'dist/ui');
  const files = readdirSync(dist).filter((f) => /\.(js|css|html)$/.test(f));
  return Object.fromEntries(files.map((f) => {
    const buf = readFileSync(join(dist, f));
    return [f, { bytes: buf.length, gzip: gzipSync(buf).length }];
  }));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  execFileSync('npm', ['run', '-s', 'build:ui'], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] });
  const metrics: any = { at: new Date().toISOString(), chromium: '', bundle: bundleSizes(), fixtures: {} };
  const work = mkdtempSync(join(tmpdir(), 'mapx-ui-audit-'));
  const browser = await chromium.launch();
  metrics.chromium = browser.version();
  const children: ChildProcess[] = [];
  try {
    const fixtures: Array<{ name: string; root: string; tabs: boolean }> = [];
    const copy = join(work, 'mapx-copy');
    mkdirSync(copy);
    execFileSync('sh', ['-c', `git -C "${REPO}" archive HEAD src tests scripts | tar -x -C "${copy}"`]);
    fixtures.push({ name: 'mapx-copy', root: copy, tabs: true });
    for (const n of SIZES) {
      const root = join(work, `generated-${n}`);
      mkdirSync(root);
      generate(root, n);
      fixtures.push({ name: `generated-${n}`, root, tabs: false });
    }
    for (const f of fixtures) {
      cli(f.root, 'init', f.root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
      cli(f.root, 'scan');
      const { url, child } = await serve(f.root);
      children.push(child);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(LONGTASK_INIT);
      const page = await context.newPage();
      const graph = await timeGraph(page, url);
      if (SCREENS && !f.tabs) await page.screenshot({ path: join(OUT, `${f.name}-graph-1440.jpg`), type: 'jpeg', quality: 70 });
      const fullGraph = await timeFullGraph(page);
      if (SCREENS) await page.screenshot({ path: join(OUT, `${f.name}-graph-full-1440.jpg`), type: 'jpeg', quality: 70 });
      await context.close();
      metrics.fixtures[f.name] = { graph, fullGraph, ...(f.tabs ? { tabs: await auditTabs(browser, url) } : {}) };
      child.kill();
    }
  } finally {
    await browser.close();
    for (const c of children) c.kill();
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');

  // Summary
  const shots = readdirSync(OUT).filter((f) => f.endsWith('.jpg'));
  const shotBytes = shots.reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
  console.log(`Chromium ${metrics.chromium}; bundle: ${Object.entries(metrics.bundle).map(([f, s]: any) => `${f} ${(s.gzip / 1024).toFixed(0)} KB gz`).join(', ')}`);
  let problems = 0;
  for (const [name, f] of Object.entries<any>(metrics.fixtures)) {
    console.log(`${name}: ${f.graph.nodes} files; default (clusters) graph in ${f.graph.ms} ms (payload ${(f.graph.payloadBytes / 1024).toFixed(0)} KB; long tasks ${f.graph.longTasks.count}, max ${f.graph.longTasks.maxMs} ms); full graph settles in ${f.fullGraph.settledMs} ms (${f.fullGraph.longTasks} long tasks)`);
    for (const [tab, t] of Object.entries<any>(f.tabs ?? {})) {
      const errs = Object.values<any>(t.viewports).reduce((n, v) => n + v.consoleErrors.length + v.failedApi.length, 0);
      problems += errs;
      const overflow = Object.entries<any>(t.viewports).filter(([, v]) => v.horizontalOverflow || v.clippedElements > 0).map(([k, v]) => `${k}${v.clippedElements ? ` (${v.clippedElements} clipped)` : ''}`);
      const axe = (t.axe ?? []).reduce((acc: any, v: any) => { acc[v.impact] = (acc[v.impact] ?? 0) + 1; return acc; }, {});
      console.log(`  ${tab}: console/API errors ${errs}; axe ${JSON.stringify(axe)}; overflow or clipping at ${overflow.join(', ') || 'none'}`);
    }
  }
  console.log(`${shots.length} screenshots, ${(shotBytes / 1024 / 1024).toFixed(1)} MB, in ${OUT}`);
  process.exitCode = problems > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
