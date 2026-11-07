// Screenshots of every dashboard tab in both themes at 1440, 1024 and 390 px (M4-17 review aid).
//   npx tsx scripts/ui/shots.ts --out <dir> [--tabs graph,routes] [--themes dark,light] [--widths 1440,390] [--size 120]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { generate, initAndScan, serve, smokeWorkspace } from './workspace.js';

declare const document: any;

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = resolve(arg('out') ?? 'shots');
const THEMES = (arg('themes') ?? 'dark,light').split(',');
const WIDTHS = (arg('widths') ?? '1440,1024,390').split(',').map(Number);
const SIZE = Number(arg('size') ?? '0');
const HEIGHT: Record<number, number> = { 1440: 900, 1024: 768, 390: 844 };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'mapx-ui-shots-'));
  if (SIZE) generate(root, SIZE); else smokeWorkspace(root);
  initAndScan(root);
  const { url, child } = await serve(root);
  const browser = await chromium.launch();
  try {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({ viewport: { width, height: HEIGHT[width] ?? 900 }, colorScheme: theme as any });
        const page = await context.newPage();
        await page.goto(url);
        await page.waitForSelector('body[data-graph="ready"]', { state: 'attached', timeout: 120_000 });
        const tabs: string[] = (arg('tabs') ?? '').split(',').filter(Boolean);
        const names = tabs.length ? tabs : await page.$$eval('.nav-item[data-tab]', (els) => els.map((e) => (e as any).dataset.tab));
        for (const tab of names) {
          await page.evaluate((t) => document.querySelector(`.nav-item[data-tab="${t}"]`).click(), tab);
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(OUT, `${tab}-${theme}-${width}.jpg`), type: 'jpeg', quality: 70 });
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
