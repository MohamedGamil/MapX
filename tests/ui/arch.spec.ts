// The Architecture tab's "Layer rules" view and the graph's declared-layer overlay (M5-15), on the
// TypeScript app of the M5-01 fixture (tests/fixtures/arch-rules/ts, synthetic) with:
//   - the empty Reporting layer renamed `<img src=x onerror=alert(1)>` and selecting src/plugins/**,
//     where Widget.ts imports Money (a violation from that layer);
//   - Infrastructure renamed `Infra, Ops"><img src=x onerror=window.__xss=1>`, which also breaks out
//     of a quoted attribute (`data-arch-layer="…"`) and holds ", " (a filter must not split it);
//   - a baseline holding the Shared → Domain violations, drawn skipped.
// Each payload must show as text, no dialog may open and window.__xss must stay unset. The last
// test removes the configuration and expects the `mapx arch init` hint. With MAPX_UI_SHOTS=<dir>,
// each panel is also captured in the light and dark themes (the report's walkthrough).
import { test, expect, type Page } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO, cli, initAndScan } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, servedWorkspace, watchErrors } from './harness.js';

declare const window: any;
declare const document: any;
declare function getComputedStyle(el: any): any;

test.skip(!!browserMissing(), browserMissing() ?? '');
test.describe.configure({ mode: 'serial' });

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const PLUGINS = '<img src=x onerror=alert(1)>';
const INFRA = 'Infra, Ops"><img src=x onerror=window.__xss=1>';
const SHOTS = process.env.MAPX_UI_SHOTS ?? '';

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('arch', (root) => {
    cpSync(join(REPO, 'tests/fixtures/arch-rules/ts'), root, { recursive: true });
    const file = join(root, '.mapx/architecture.jsonc');
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\/\/.*\n/, ''));
    delete doc.$schema;
    for (const l of doc.layers) {
      if (l.name === 'Reporting') Object.assign(l, { name: PLUGINS, selectors: [{ path: 'src/plugins/**' }] });
      if (l.name === 'Infrastructure') l.name = INFRA;
    }
    doc.rules[INFRA] = doc.rules.Infrastructure;
    delete doc.rules.Infrastructure;
    writeFileSync(file, JSON.stringify(doc, null, 2));
    mkdirSync(join(root, 'src/plugins'));
    writeFileSync(join(root, 'src/plugins/Widget.ts'), "import { Money } from '../domain/Money';\n\nexport class Widget {\n  run(): void {\n    new Money();\n  }\n}\n");
    initAndScan(root);
    try { cli(root, 'check', '--generate-baseline'); } catch { /* exits 0; tolerate a non-zero exit */ }
    const baselineFile = join(root, '.mapx/architecture.baseline.json');
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    baseline.entries = baseline.entries.filter((e: { source: string }) => e.source.startsWith('src/shared/'));
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  });
});
test.afterAll(() => served?.stop());

/** Opens the dashboard with dialogs recorded (and dismissed) and errors collected. */
async function open(page: Page, theme: 'light' | 'dark' = 'dark') {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.emulateMedia({ colorScheme: theme });
  const errors = watchErrors(page);
  await page.goto(served.url);
  await graphReady(page);
  return { dialogs, errors };
}

async function openRules(page: Page) {
  await page.click('.nav-item[data-tab="architecture"]');
  await page.click('#subtab-btn-arch-rules');
  await expect(page.locator('#arch-rules-health .stat-tile').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

const tile = (page: Page, label: string) => page.locator('#arch-rules-health .stat-tile')
  .filter({ has: page.locator('.stat-tile-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-tile-value');

async function shot(page: Page, selector: string, name: string, theme: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300); // fade-in
  await page.locator(selector).screenshot({ path: join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
}

test('health tiles, the layer diagram with drill-down, the layer DSM and the findings', async ({ page }) => {
  const { dialogs, errors } = await open(page);
  await openRules(page);
  await expect(tile(page, 'Violations')).toHaveText('16');
  await expect(tile(page, 'Baseline debt')).toHaveText('2');
  await expect(tile(page, 'Uncovered')).toHaveText('4');
  await expect(tile(page, 'Unassigned')).toHaveText('4');
  await expect(tile(page, 'Warnings')).toHaveText('1'); // mapx check's Warnings: the multi-layer OrderId (review of M5-15)
  await expect(tile(page, 'Warn-level violations')).toHaveText('0');

  // The diagram: every layer, an edge per status; the baselined pair dashed, violations another colour.
  const diagram = await page.evaluate(() => window.__mapxArchDiagram());
  expect(diagram.layers).toEqual(['Controller', 'Application', 'Domain', 'Shared', INFRA, PLUGINS]);
  const edge = (from: string, to: string, status: string) => diagram.edges.find((e: any) => e.from === from && e.to === to && e.status === status);
  expect(edge('Shared', 'Domain', 'skipped')).toMatchObject({ count: 2, lineStyle: 'dashed' });
  expect(edge('Controller', 'Application', 'violation')).toMatchObject({ count: 4, lineStyle: 'solid' });
  expect(edge('Controller', 'Application', 'allowed').color).not.toBe(edge('Controller', 'Application', 'violation').color);

  // Edge → its concrete dependencies with file:line.
  expect(await page.evaluate(() => window.__mapxArchTap('Controller', 'Application'))).toBe(true);
  const drill = page.locator('#arch-drill-body');
  await expect(page.locator('#arch-drill-title')).toHaveText('Controller → Application');
  await expect(drill).toContainText('src/controller/OrderController.ts:4');
  await expect(drill).toContainText('private-layer (error)');
  await expect(drill).toContainText('4 allowed, 4 violating (0 at warn), 0 baselined');
  // Baselined dependencies say so.
  expect(await page.evaluate(() => window.__mapxArchTap('Shared', 'Domain'))).toBe(true);
  await expect(drill.locator('.arch-dep > .arch-kind')).toHaveText(['Skipped', 'Skipped']);
  // Layer → its members and the selector that matched.
  expect(await page.evaluate(() => window.__mapxArchTap('Shared'))).toBe(true);
  await expect(drill).toContainText('src/domain/ids/OrderId.ts');
  await expect(drill).toContainText('selectors[1].path');

  // The DSM: coloured by policy, a faint 0 for an unused allowance; a cell drills like an edge.
  const dsm = page.locator('#arch-layer-dsm');
  await expect(dsm.locator('.arch-dsm-cell.is-skipped button')).toHaveText(['2']);
  await expect(dsm.locator('.arch-dsm-cell.is-unused button').first()).toHaveAttribute('title', /and nothing does/);
  await dsm.locator('button[data-arch-from="Controller"][data-arch-to="Domain"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#arch-drill-title')).toHaveText('Controller → Domain');
  await expect(drill).toContainText('src/controller/OrderController.ts:3');
  // The unused allowance is a button too (review of M5-15), with what it means.
  const unused = dsm.locator('.arch-dsm-cell.is-unused button').first();
  await expect(unused).toHaveAttribute('aria-label', /and nothing does/);
  await unused.focus();
  await page.keyboard.press('Enter');
  await expect(drill).toContainText('a dead allowance');
  // The DSM cell, the diagram's edges and the drill-down count the same findings (review of M5-15, P1).
  const cellCount = Number(await dsm.locator('button[data-arch-from="Controller"][data-arch-to="Application"]').textContent());
  const drawn = diagram.edges.filter((e: any) => e.from === 'Controller' && e.to === 'Application').reduce((n: number, e: any) => n + e.count, 0);
  await dsm.locator('button[data-arch-from="Controller"][data-arch-to="Application"]').click();
  await expect(drill.locator('.arch-dep')).toHaveCount(cellCount);
  expect(drawn).toBe(cellCount);

  // Findings: filters by kind, rule, layer and verifiability.
  const rows = page.locator('#table-arch-findings tbody tr:has(.arch-kind)');
  const total = await rows.count();
  await page.selectOption('#arch-filter-kind', 'uncovered');
  await expect(rows).toHaveCount(4);
  await expect(page.locator('#arch-findings-count')).toContainText(`4 of ${total} findings`);
  await page.selectOption('#arch-filter-kind', '');
  await page.selectOption('#arch-filter-rule', 'private-layer');
  await expect(rows).toHaveCount(4);
  await page.selectOption('#arch-filter-layer', 'Domain');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#table-arch-findings tbody')).toContainText('No finding matches the filters.');
  await page.selectOption('#arch-filter-rule', '');
  await page.selectOption('#arch-filter-verifiability', 'verified');
  await page.selectOption('#arch-filter-layer', INFRA); // a name with ", " (review of M5-15)
  await expect(rows).toHaveCount(6);
  await page.selectOption('#arch-filter-layer', PLUGINS);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(`(${PLUGINS} on Domain)`);

  // A row opens its file in the graph's details panel.
  await rows.first().locator('.involved-file-badge').click();
  await expect(page.locator('#tab-graph')).toHaveClass(/active/);
  await expect(page.locator('#details-content')).toContainText('Widget.ts');

  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('the declared-layer overlay colours files by layer, files in none grey', async ({ page }) => {
  const { dialogs, errors } = await open(page);
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  const before = await page.evaluate(() => window.__mapxNodeColor('src/controller/OrderController.ts'));
  await page.click('#btn-arch-overlay');
  await expect(page.locator('#btn-arch-overlay')).toHaveAttribute('aria-pressed', 'true');
  const legend = page.locator('#arch-overlay-legend');
  await expect(legend).toContainText('Declared layers');
  await expect(legend.locator('li')).toHaveText(['Controller', 'Application', 'Domain', 'Shared', INFRA, PLUGINS, 'No layer']);
  const colour = (id: string) => page.evaluate((i) => window.__mapxNodeColor(i), id);
  await expect.poll(() => colour('src/controller/OrderController.ts')).toBe('rgb(97,175,239)'); // the palette's first
  expect(await colour('src/plugins/Widget.ts')).toBe('rgb(86,182,194)'); // the sixth layer's
  const grey = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--graph-node').trim());
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')})`;
  expect(await colour('src/support/Clock.ts')).toBe(rgb(grey));
  await page.click('#btn-arch-overlay');
  await expect(legend).toBeHidden();
  expect(await colour('src/controller/OrderController.ts')).toBe(before);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: the layer rules pass axe; each panel captured`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { dialogs, errors } = await open(page, theme);
    await openRules(page);
    expect(await page.evaluate(() => window.__mapxArchTap('Controller', 'Application'))).toBe(true);
    await expect(page.locator('#arch-drill-body')).toContainText('OrderController.ts:4');
    await page.waitForTimeout(400);
    await page.addScriptTag({ path: AXE });
    const result: any = await page.evaluate(() => window.axe.run(document.querySelector('#subtab-arch-rules'), { resultTypes: ['violations'] }));
    const serious = result.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: any) => `${v.id}: ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
    expect(serious).toEqual([]);
    await shot(page, '#arch-rules-health', 'health', theme);
    await shot(page, '#arch-layer-diagram', 'diagram', theme);
    await shot(page, '#arch-drill', 'drill-edge', theme);
    await shot(page, '#arch-layer-dsm', 'dsm', theme);
    await page.selectOption('#arch-filter-kind', 'violation');
    await page.selectOption('#arch-filter-rule', 'private-layer');
    await page.locator('#table-arch-findings').scrollIntoViewIfNeeded();
    await shot(page, '#subtab-arch-rules > .arch-rules > .arch-card:last-child', 'findings', theme);
    if (SHOTS) {
      await page.click('.nav-item[data-tab="graph"]');
      await page.selectOption('#select-graph-mode', 'full');
      await graphReady(page);
      await page.click('#btn-arch-overlay');
      await expect(page.locator('#arch-overlay-legend')).toContainText('Declared layers');
      await page.waitForTimeout(600);
      await shot(page, '#tab-graph .graph-container', 'overlay', theme);
    }
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('payload layer names show as text everywhere they appear', async ({ page }) => {
  const { dialogs, errors } = await open(page);
  await openRules(page);
  const dsm = page.locator('#arch-layer-dsm');
  await expect(dsm.locator('.arch-dsm-layer').filter({ hasText: PLUGINS })).toHaveText(`L6: ${PLUGINS}`);
  await expect(dsm.locator('.arch-dsm-layer').filter({ hasText: 'Ops"' })).toHaveText(`L5: ${INFRA}`);
  await expect(dsm.locator(`button[data-arch-layer="${INFRA.replace(/"/g, '\\"')}"]`)).toHaveCount(1);
  await expect(page.locator('#arch-filter-layer option')).toContainText([INFRA, PLUGINS]);
  await dsm.locator('.arch-dsm-layer').filter({ hasText: 'Ops"' }).click();
  await expect(page.locator('#arch-drill-title')).toHaveText(INFRA);
  await expect(page.locator('#arch-drill-body')).toContainText('src/infrastructure/MailGateway.ts');
  await dsm.locator('.arch-dsm-layer').filter({ hasText: PLUGINS }).click();
  await expect(page.locator('#arch-drill-body')).toContainText('src/plugins/Widget.ts');
  await expect(page.locator('#table-arch-findings')).toContainText(`(${PLUGINS} on Domain)`);
  await page.click('.nav-item[data-tab="graph"]');
  await page.click('#btn-arch-overlay');
  await expect(page.locator('#arch-overlay-legend')).toContainText(INFRA);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

test('a stale index shows a banner with mapx check\'s reason (review of M5-15)', async ({ page }) => {
  const late = join(served.root, 'src/shared/Late.ts');
  writeFileSync(late, "import { PlaceOrder } from '../application/PlaceOrder';\nexport const late = PlaceOrder;\n");
  try {
    await page.waitForTimeout(2_500); // the server reuses the index gate's answer for 2 s
    const { errors } = await open(page);
    await openRules(page);
    await expect(page.locator('#arch-rules-stale')).toContainText('The index is stale: 1 file(s) changed since the last scan');
    await expect(page.locator('#arch-rules-stale')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    rmSync(late);
  }
});

test('without a configuration the view shows the mapx arch init hint', async ({ page }) => {
  const config = join(served.root, '.mapx/architecture.jsonc');
  renameSync(config, `${config}.off`);
  try {
    const { errors } = await open(page);
    await page.click('.nav-item[data-tab="architecture"]');
    await page.click('#subtab-btn-arch-rules');
    const state = page.locator('#arch-rules-state');
    await expect(state).toContainText('No architecture rules yet');
    await expect(state.locator('code')).toHaveText('mapx arch init');
    await expect(page.locator('#arch-rules-body')).toBeHidden();
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await shot(page, '#arch-rules-state .arch-empty', 'no-config', theme);
    }
    await page.click('.nav-item[data-tab="graph"]');
    await page.click('#btn-arch-overlay');
    await expect(page.locator('#arch-overlay-legend')).toContainText('mapx arch init');
    expect(errors).toEqual([]);
  } finally {
    renameSync(`${config}.off`, config);
  }
});
