// The dashboard's design system (M4-17): colour tokens only, light and dark themes that pass axe
// (no serious or critical violations, contrast included) on every tab, a layout without horizontal
// scrolling at 390, 1024 and 1440 px with a collapsing sidebar, and keyboard focus rings.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO, initAndScan, smokeWorkspace } from '../../scripts/ui/workspace.js';
import { findColourLiterals } from '../../scripts/ui/check-tokens.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

declare const document: any;
declare const window: any;
declare const localStorage: any;
declare function getComputedStyle(el: any): any;

test.skip(!!browserMissing(), browserMissing() ?? '');

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TABS = ['graph', 'workspace', 'symbols', 'routes', 'architecture', 'context', 'metrics', 'tool-log'];
const WIDTHS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }];

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('design', (root) => {
    smokeWorkspace(root);
    initAndScan(root);
  });
});
test.afterAll(() => served?.stop());

async function open(browser: Browser, opts: { width?: number; height?: number; colorScheme?: 'light' | 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, colorScheme: opts.colorScheme ?? 'dark' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(served.url);
  await graphReady(page);
  return { context, page, errors };
}

/** Opens a tab whether its button is visible (sidebar or rail) or inside the closed drawer. */
async function showTab(page: Page, tab: string) {
  await page.evaluate((t) => document.querySelector(`.nav-item[data-tab="${t}"]`).click(), tab);
  await expect(page.locator(`#tab-${tab}`)).toHaveClass(/active/);
  await page.waitForLoadState('networkidle');
}

test('styles.css has no colour literal outside its token blocks', () => {
  const found = findColourLiterals(readFileSync(join(REPO, 'src/ui/styles.css'), 'utf8'));
  expect(found.map((v) => `${v.line}: ${v.selector} { ${v.text} }`)).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: axe finds no serious or critical violation on any tab`, async ({ browser }) => {
    const { context, page, errors } = await open(browser, { colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const found: string[] = [];
    for (const tab of TABS) {
      await showTab(page, tab);
      await page.waitForTimeout(400); // fade-in animation: axe reads final colours
      await page.addScriptTag({ path: AXE });
      const result: any = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
      for (const v of result.violations) {
        if (v.impact === 'serious' || v.impact === 'critical') {
          found.push(`${tab}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
        }
      }
    }
    expect(errors).toEqual([]);
    expect(found).toEqual([]);
    await context.close();
  });
}

for (const { width, height } of WIDTHS) {
  test(`${width} px: no tab scrolls horizontally or clips content at the right edge`, async ({ browser }) => {
    const { context, page, errors } = await open(browser, { width, height });
    const problems: string[] = [];
    for (const tab of TABS) {
      await showTab(page, tab);
      await page.waitForTimeout(400);
      const result = await page.evaluate(() => {
        const vw = window.innerWidth;
        const main = document.querySelector('.main-content');
        // The page, or the view's own scroll container, scrolling sideways.
        const scroll = document.documentElement.scrollWidth > vw || document.body.scrollWidth > vw || main.scrollWidth > main.clientWidth + 1;
        // Content past the right edge that is not inside a sideways scroll region of its own (the
        // DSM matrix): the frame (main, which scrolls vertically, so its overflow-x computes to auto)
        // does not count as one.
        const clipped: string[] = [];
        for (const el of document.querySelectorAll('.tab-pane.active *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
          let p = el.parentElement;
          let inScroller = false;
          while (p && p !== main) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.getBoundingClientRect().right <= vw + 1) { inScroller = true; break; }
            p = p.parentElement;
          }
          if (!inScroller) clipped.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`);
        }
        return { scroll, clipped: clipped.slice(0, 5) };
      });
      if (result.scroll) problems.push(`${tab}: page scrolls horizontally`);
      if (result.clipped.length) problems.push(`${tab}: clipped ${result.clipped.join(', ')}`);
    }
    expect(errors).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });
}

test('the sidebar is full at 1440 px, an icon rail at 1024 px and a drawer at 390 px', async ({ browser }) => {
  const at = async (width: number, height: number) => {
    const { context, page } = await open(browser, { width, height });
    const sidebar = page.locator('#sidebar');
    return { context, page, sidebar, box: await sidebar.boundingBox() };
  };
  const wide = await at(1440, 900);
  expect(wide.box!.width).toBeGreaterThan(200);
  await expect(wide.page.locator('.nav-item[data-tab="routes"] .nav-label')).toBeVisible();
  await wide.context.close();

  const rail = await at(1024, 768);
  expect(rail.box!.width).toBeLessThanOrEqual(72);
  await expect(rail.page.locator('.nav-item[data-tab="routes"] .nav-label')).toBeHidden();
  await expect(rail.page.locator('.nav-item[data-tab="routes"]')).toBeVisible();
  await rail.context.close();

  const narrow = await at(390, 844);
  await expect(narrow.sidebar).toBeHidden(); // off-canvas and not focusable
  const menu = narrow.page.locator('#btn-nav-open');
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(narrow.page.locator('.nav-item[data-tab="routes"]')).toBeVisible();
  await narrow.page.locator('.nav-item[data-tab="routes"]').click();
  await expect(narrow.page.locator('#tab-routes')).toHaveClass(/active/);
  await expect(narrow.sidebar).toBeHidden(); // choosing a view closes the drawer
  await expect(narrow.page.locator('#mobile-title')).toHaveText('Routes & Hooks');
  await narrow.context.close();
});

/** Tabs from the active nav item through the active view; returns what was reached and what had no ring. */
async function tabThrough(page: Page, presses: number) {
  const reached = new Set<string>();
  const noRing: string[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || (s.boxShadow && s.boxShadow !== 'none');
      const key = el.dataset?.tab ?? (el.id || `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}:${(el.textContent ?? '').trim().slice(0, 30)}`);
      return { key, ring };
    });
    if (!info || reached.has(info.key)) continue;
    reached.add(info.key);
    if (!info.ring) noRing.push(info.key);
  }
  return { reached, noRing };
}

test('every control of every view is reached with Tab and shows a focus ring', async ({ browser }) => {
  const { context, page } = await open(browser);
  const missing: string[] = [];
  const noRing: string[] = [];
  for (const tab of TABS.filter((t) => t !== 'graph')) {
    await page.click(`.nav-item[data-tab="${tab}"]`);
    await page.waitForLoadState('networkidle');
    if (tab === 'context') {
      await page.fill('#context-task', 'orders');
      await page.click('#btn-build-context');
      await expect(page.locator('#context-results')).toContainText('Key Context Files');
    }
    if (tab === 'architecture') await expect(page.locator('#arch-smells-list')).not.toContainText('Loading');
    await page.focus(`.nav-item[data-tab="${tab}"]`);
    // Every visible, enabled control of the view (inactive sub-tabs are reached with arrow keys).
    const expected: string[] = await page.evaluate(() => [...document.querySelectorAll('.tab-pane.active :is(a[href], button, input, select, textarea, [tabindex="0"], [data-go-id])')]
      .filter((e: any) => !e.disabled && e.offsetParent !== null && e.getAttribute('tabindex') !== '-1')
      .map((el: any) => el.id || `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}:${(el.textContent ?? '').trim().slice(0, 30)}`));
    const result = await tabThrough(page, expected.length + 12);
    for (const k of expected) if (!result.reached.has(k)) missing.push(`${tab}: ${k}`);
    noRing.push(...result.noRing.map((k) => `${tab}: ${k}`));
  }
  expect(missing).toEqual([]);
  expect(noRing).toEqual([]);
  await context.close();
});

test('every navigation item and graph control is reached with Tab and shows a focus ring', async ({ browser }) => {
  const { context, page } = await open(browser);
  const expected = await page.evaluate(() => [
    ...[...document.querySelectorAll('.nav-item')].map((e: any) => e.dataset.tab),
    ...[...document.querySelectorAll('#btn-theme, .graph-toolbar select, .graph-toolbar button')]
      .filter((e: any) => !e.disabled && e.offsetParent !== null)
      .map((e: any) => e.id),
  ]);
  const reached = new Set<string>();
  const noRing: string[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || (s.boxShadow && s.boxShadow !== 'none');
      return { key: el.dataset?.tab ?? el.id, ring };
    });
    if (!info) continue;
    if (reached.has(info.key)) continue;
    reached.add(info.key);
    if (!info.ring) noRing.push(info.key);
  }
  expect(expected.filter((k: string) => !reached.has(k))).toEqual([]);
  expect(noRing).toEqual([]);
  await context.close();
});

test('the theme follows the system until chosen, and the choice persists', async ({ browser }) => {
  const { context, page } = await open(browser, { colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#btn-theme');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('mapx-theme'))).toBe('dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bgLight);
  await page.reload();
  await graphReady(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await context.close();
});

test('the details panel takes room only while something is selected', async ({ browser }) => {
  const { context, page } = await open(browser);
  await expect(page.locator('#graph-details')).toBeHidden();
  // Selecting a node fills the details; the panel opens, and its close button empties it again.
  await page.evaluate(() => {
    const d = document.getElementById('details-content');
    d.innerHTML = '<strong>src/d0/m0.ts</strong>';
  });
  await expect(page.locator('#graph-details')).toBeVisible();
  await page.click('#btn-details-close');
  await expect(page.locator('#graph-details')).toBeHidden();
  await context.close();
});

/** Shows the Full Codebase graph and selects a file node as a tap would (the __mapxSelect hook). */
async function selectFile(page: Page, id = 'src/d0/m0.ts') {
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  expect(await page.evaluate((i) => window.__mapxSelect(i), id)).toBe(true);
  await expect(page.locator('#graph-details')).toBeVisible();
}

async function axeSerious(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  const result: any = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  return result.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical')
    .map((v: any) => `${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: the selection details and a symbol's details pass axe (review 2026-11-01)`, async ({ browser }) => {
    for (const { width, height } of [WIDTHS[0]!, WIDTHS[2]!]) {
      const { context, page, errors } = await open(browser, { width, height, colorScheme: theme });
      // A file with classification signals, whose roles are drawn in their layer's colour.
      await selectFile(page, 'app/Http/Controllers/OrderController.php');
      await expect(page.locator('#classification-signals-container li').first()).toBeVisible();
      await page.waitForTimeout(300);
      const graph = await axeSerious(page);
      await showTab(page, 'symbols');
      await page.locator('#table-symbols tbody .link-btn').first().click();
      await expect(page.locator('#symbol-detail-view pre')).toBeVisible();
      await page.waitForTimeout(300);
      const symbols = await axeSerious(page);
      expect(errors).toEqual([]);
      expect([...graph.map((g) => `${width} graph: ${g}`), ...symbols.map((s) => `${width} symbols: ${s}`)]).toEqual([]);
      await context.close();
    }
  });
}

test('Escape closes one thing at a time, and not from a text field (review 2026-11-01)', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 390, height: 844 });
  await selectFile(page);
  // The drawer over an open details panel: Escape closes the drawer only.
  await page.click('#btn-nav-open');
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.locator('#graph-details')).toBeVisible();
  // Escape in the focus search belongs to the search.
  await page.selectOption('#select-graph-mode', 'focus');
  await graphReady(page);
  expect(await page.evaluate(() => window.__mapxSelect())).toBe(true);
  await expect(page.locator('#graph-details')).toBeVisible();
  await page.focus('#focus-search-input');
  await page.keyboard.press('Escape');
  await expect(page.locator('#graph-details')).toBeVisible();
  // Elsewhere (a button), Escape closes the details panel.
  await page.focus('#btn-details-close');
  await page.keyboard.press('Escape');
  await expect(page.locator('#graph-details')).toBeHidden();
  await context.close();
});

test('the open drawer takes focus and keeps it (review 2026-11-01)', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 390, height: 844 });
  await page.click('#btn-nav-open');
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement)), `after ${i + 1} Tab presses`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement))).toBe(true);
  await context.close();
});

test('the focus mode controls are reached with Tab and show a focus ring (review 2026-11-01)', async ({ browser }) => {
  const { context, page } = await open(browser);
  await page.selectOption('#select-graph-mode', 'focus');
  await graphReady(page);
  await page.focus('#select-graph-mode');
  const { reached, noRing } = await tabThrough(page, 25);
  for (const id of ['focus-search-input']) expect([...reached]).toContain(id);
  const depth = [...reached].filter((k) => k.includes('depth-btn'));
  expect(depth.length).toBe(3);
  expect(noRing).toEqual([]);
  await context.close();
});

test('an open drawer stops trapping focus once the window is wide (review 2026-11-02)', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 390, height: 844 });
  await page.click('#btn-nav-open');
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.app-layout')).not.toHaveClass(/nav-open/);
  await page.focus('#select-layout');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('select-graph-mode');
  await context.close();
});
