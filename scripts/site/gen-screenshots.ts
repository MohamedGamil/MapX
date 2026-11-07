// M7-07: draws the dashboard screenshots of the landing page, site/public/img/*.webp.
//
// Two synthetic workspaces (never private code) are scanned and served with `mapx ui`, then driven in
// headless Chromium: the Graph Explorer and the Architecture "Layer rules" view of the M5-01 TypeScript
// fixture, and the HTTP Calls view of the multi-repo workspace (a Vue frontend and a Laravel backend).
// Chromium takes the PNG and its canvas encodes the WebP, so no image library is needed. The output is
// committed, so a site build never needs this.  Regenerate with:  npm run site:shots
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { cli, initAndScan, initAndScanMultiRepo, multiRepoWorkspace, serve } from '../ui/workspace.js';
import { SCREENSHOTS, SHOT_HEIGHT, SHOT_MAX_BYTES, SHOT_WIDTH } from './screenshot-list.js';

declare const document: any;
declare const Image: any;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'site', 'public', 'img');
/** The dashboard shows the project folder's name: fixed names keep the pictures the same on every run. */
const ARCH_PROJECT = 'acme-shop';
const HTTP_PROJECT = 'orders-platform';
const QUALITY = 0.82;

/** The PNG as WebP, encoded by the browser's canvas. */
async function toWebp(browser: Browser, png: Buffer): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    const b64 = await page.evaluate(
      async ([data, quality]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return (canvas.toDataURL('image/webp', Number(quality)) as string).split(',')[1]!;
      },
      [png.toString('base64'), String(QUALITY)],
    );
    return Buffer.from(b64, 'base64');
  } finally {
    await page.close();
  }
}

async function dashboard(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('body[data-graph="ready"]', { state: 'attached', timeout: 120_000 });
  return page;
}

async function settle(page: Page): Promise<Buffer> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200); // fade-ins and the layout's last animation frames
  // A control that was just used keeps a focus ring; the picture should not show it.
  await page.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  return page.screenshot({ animations: 'disabled' });
}

/** The architecture fixture of M5-01, with its baseline cut to the shared layer (as the browser tests do). */
function archWorkspace(root: string): void {
  cpSync(join(ROOT, 'tests/fixtures/arch-rules/ts'), root, { recursive: true });
  const file = join(root, '.mapx/architecture.jsonc');
  const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\/\/.*\n/, ''));
  delete doc.$schema;
  writeFileSync(file, JSON.stringify(doc, null, 2));
  initAndScan(root);
  try {
    cli(root, 'check', '--generate-baseline');
  } catch {
    /* a baseline is written whatever the exit code */
  }
  const baselineFile = join(root, '.mapx/architecture.baseline.json');
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  baseline.entries = baseline.entries.filter((e: { source: string }) => e.source.startsWith('src/shared/'));
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
}

/** Draws every screenshot into `outDir` (created if needed) and returns the files written. */
export async function generateScreenshots(outDir: string = OUT): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'mapx-site-shots-'));
  const servers: { kill(): void }[] = [];
  let browser: Browser | undefined;
  const written: string[] = [];
  try {
    const archRoot = join(work, ARCH_PROJECT);
    const httpRoot = join(work, HTTP_PROJECT);
    mkdirSync(archRoot);
    mkdirSync(httpRoot);
    archWorkspace(archRoot);
    multiRepoWorkspace(httpRoot);
    initAndScanMultiRepo(httpRoot);
    // Each server is registered as soon as it runs, so a failure of the next one cannot leave it behind.
    const arch = await serve(archRoot);
    servers.push(arch.child);
    const http = await serve(httpRoot);
    servers.push(http.child);
    browser = await chromium.launch();
    const b = browser;

    const frames: Record<string, () => Promise<Buffer>> = {
      graph: async () => {
        const page = await dashboard(b, arch.url);
        // The default layout (fCoSE) is a force simulation with random starting positions: two runs
        // differ by about 9 percent of the pixels. The layered ELK layout is deterministic.
        await page.selectOption('#select-layout', 'elk');
        // The dashboard reports its layout on <body data-graph>: wait for the new layout to start (it may
        // already be done) and then to finish, instead of a fixed delay.
        await page.waitForSelector('body[data-graph="layout"]', { state: 'attached', timeout: 5_000 }).catch(() => undefined);
        await page.waitForSelector('body[data-graph="ready"]', { state: 'attached', timeout: 60_000 });
        return settle(page);
      },
      architecture: async () => {
        const page = await dashboard(b, arch.url);
        await page.click('.nav-item[data-tab="architecture"]');
        await page.click('#subtab-btn-arch-rules');
        await page.locator('#arch-rules-health .stat-tile').first().waitFor();
        return settle(page);
      },
      http: async () => {
        const page = await dashboard(b, http.url);
        await page.click('.nav-item[data-tab="http"]');
        await page.locator('#tab-http.active').waitFor({ state: 'attached' });
        return settle(page);
      },
    };
    for (const shot of SCREENSHOTS) {
      const webp = await toWebp(b, await frames[shot.id]!());
      if (webp.length > SHOT_MAX_BYTES) throw new Error(`${shot.file} is ${webp.length} bytes, over the ${SHOT_MAX_BYTES} byte cap`);
      writeFileSync(join(outDir, shot.file), webp);
      written.push(shot.file);
    }
  } finally {
    // Every step runs, whatever the one before it did.
    await browser?.close().catch(() => undefined);
    for (const s of servers) s.kill();
    rmSync(work, { recursive: true, force: true });
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await generateScreenshots();
  console.log(`site/public/img: ${files.join(', ')}`);
}
