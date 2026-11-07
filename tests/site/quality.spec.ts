// M7-06: accessibility (axe-core: no serious or critical violation) on the main pages in both colour
// schemes, and the 404 page in a browser. The 404 page is an empty shell that VitePress fills in the
// browser, so only a browser can check it.
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { GUIDES } from '../../scripts/site/sync-docs.js';
import { BASE, browserMissing, buildAndServe, type Served } from './serve.js';

const missing = browserMissing();
test.skip(!!missing, missing ?? '');

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

let served: Served;
test.beforeAll(async () => {
  served = await buildAndServe();
});
test.afterAll(async () => {
  await served?.close();
});

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

/** Runs axe on the loaded page and returns its serious and critical violations, described. */
async function seriousViolations(page: import('@playwright/test').Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  const result = (await page.evaluate('axe.run(document, { resultTypes: ["violations"] })')) as { violations: Violation[] };
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} [${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 220)}]`).join(' | ')}`);
}

// The home page, the docs index and every guide: the guides differ in the code they show.
for (const path of ['', 'docs/', ...GUIDES.map((g) => `docs/${g}`)]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`axe finds no serious or critical violation on /${path} in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${served.origin}${BASE}${path}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
}

// The navigation bar changes below 768 px (the search button shows only its icon): check a phone as well.
for (const path of ['', 'docs/getting-started']) {
  test(`axe finds no serious or critical violation on /${path} on a phone`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${served.origin}${BASE}${path}`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

// The 404 page is an empty shell that the browser fills in: axe runs once it has.
for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds no serious or critical violation on the 404 page in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${served.origin}${BASE}no-such-page`);
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test.describe('the 404 page', () => {
  test('answers with status 404, shows the footer credit and leads back to the home page', async ({ page }) => {
    const response = await page.goto(`${served.origin}${BASE}no-such-page`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
    await expect(page.locator('footer.VPFooter')).toContainText('MapX is created by Mohamed Gamil');
    // The link's accessible name is its visible text (the theme's aria-label default did not contain it).
    const home = page.getByRole('link', { name: 'Take me home' });
    await expect(home).toBeVisible();
    await home.click();
    await expect(page).toHaveURL(`${served.origin}${BASE}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('MapX');
  });

  test('keeps the site navigation and loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${served.origin}${BASE}docs/does-not-exist`);
    await expect(page.getByRole('navigation').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
