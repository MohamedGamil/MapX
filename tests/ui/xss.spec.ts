// Scanned values never run as script in the dashboard (M4-24, M4-24-R1). The payload
// `<img src=x onerror=window.__xss=1>` is carried by a route path, a route handler, a symbol name
// (a Vuex action keyed by a string), file names (one in an import cycle, one breaking out of a
// quoted attribute), a logged tool call, a registered repo's name (whose axios calls reach the
// handler, and miss), and config values (a user exclude pattern, an unknown key, an invalid value).
// The repo name and the config key also break out of a quoted attribute (`">`). Every tab the
// navigation lists is opened; each payload must show as text, and no payload may run: checked
// after every tab and panel and before every navigation, and recorded across documents by a
// setter on window.__xss. All synthetic.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { XSS, cli, write, xssWorkspace } from '../../scripts/ui/workspace.js';
import { browserMissing, graphReady, navTabs, openTab, servedWorkspace } from './harness.js';

declare const window: any;

test.skip(!!browserMissing(), browserMissing() ?? '');
// The last test checks that the earlier ones, together, opened every tab.
test.describe.configure({ mode: 'serial' });

/** A payload that also closes a double-quoted attribute (`data-repo="…"`, `value="…"`). */
const QUOTE = `">${XSS}`;
/** A registered repo whose folder, and so its name, carries the payload. */
const WEB = `web${QUOTE}`;
const HANDLER = `PageController@show${XSS}`;
/**
 * The symbol's payload has no dot: /api/symbol/ reads `a.b` as member b of a, so a name holding
 * `window.__xss` cannot be opened. A bare `__xss=1` in an inline handler still sets window.__xss.
 */
const SYMBOL = 'save<img src=x onerror=__xss=1>';

let served: Awaited<ReturnType<typeof servedWorkspace>>;

test.beforeAll(async () => {
  served = await servedWorkspace('xss', (root) => {
    xssWorkspace(root);
    write(root, 'routes/api.php', `<?php\nuse Illuminate\\Support\\Facades\\Route;\nuse App\\Http\\Controllers\\PageController;\n\nRoute::get('/orders${XSS}', [PageController::class, 'show${XSS}']);\n`);
    write(root, 'src/store/actions.js', `export const actions = {\n  '${SYMBOL}': (ctx) => ctx.commit('saved'),\n};\n`);
    write(root, `${WEB}/package.json`, JSON.stringify({ name: 'web', dependencies: { axios: '^1.7.0' } }));
    write(root, `${WEB}/src/api.ts`, `import axios from 'axios';\n\nexport function listOrders() { return axios.get('/api/orders${XSS}'); }\nexport function missing() { return axios.get('/api/nowhere${XSS}'); }\n`);
    execFileSync('git', ['init', '-q', join(root, WEB)]);
    cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    cli(root, 'workspaces', 'add', WEB);
    cli(root, 'scan');
    const path = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.settings.excludePatterns.push(`gen${XSS}/**`);
    config.settings.parseWorkers = XSS;
    config.settings[`colour${QUOTE}`] = XSS;
    writeFileSync(path, JSON.stringify(config, null, 2));
    const call = { tool: `mapx_query${XSS}`, input: { pattern: XSS }, timestamp: new Date().toISOString(), durationMs: 3, success: false, error: XSS };
    writeFileSync(join(root, '.mapx/tool-calls.jsonl'), JSON.stringify(call) + '\n');
  });
});
test.afterAll(() => served?.stop());

const opened = new Set<string>();
/** Each page's payload runs, in any document it loaded (a navigation resets window, not this). */
const runs = new WeakMap<Page, string[]>();

/** Records every write of window.__xss in every document `page` loads, before its scripts run. */
async function watchPayloads(page: Page) {
  const list: string[] = [];
  runs.set(page, list);
  await page.exposeFunction('__xssRan', (href: string) => { list.push(href); });
  await page.addInitScript(() => {
    let value: unknown;
    Object.defineProperty(window, '__xss', {
      configurable: true,
      get: () => value,
      set: (v: unknown) => { value = v; window.__xssRan(window.location.href); },
    });
  });
}

/** No payload ran: an injected <img> fails to load asynchronously, so wait a little first. */
async function noScriptRan(page: Page, after: string) {
  await page.waitForTimeout(500);
  expect(runs.get(page), `a payload ran after: ${after}`).toEqual([]);
  expect(await page.evaluate(() => window.__xss), `window.__xss after: ${after}`).toBeUndefined();
}

async function open(page: Page, tab: string) {
  await openTab(page, tab);
  opened.add(tab);
  await noScriptRan(page, `opening ${tab}`);
}

test('route, symbol, file, tool-log and context views show each payload as text', async ({ page }) => {
  await watchPayloads(page);
  await page.goto(served.url);
  await graphReady(page);
  await noScriptRan(page, 'loading the dashboard');

  await open(page, 'routes');
  await expect(page.locator('#table-routes tbody')).toContainText(`/x${XSS}`);
  await expect(page.locator('#table-routes tbody')).toContainText(HANDLER);

  await open(page, 'symbols');
  await page.fill('#symbol-search', 'evilFn');
  await expect(page.locator('#table-symbols tbody')).toContainText(`evil${XSS}.ts`);
  await page.locator('#table-symbols tbody .link-btn').first().click();
  await expect(page.locator('#symbol-detail-view')).toContainText(`evil${XSS}.ts`);
  await noScriptRan(page, 'the evilFn symbol detail');
  // A symbol whose own name carries the payload.
  await page.fill('#symbol-search', 'save');
  await expect(page.locator('#table-symbols tbody')).toContainText(SYMBOL);
  await page.locator('#table-symbols tbody .link-btn').first().click();
  await expect(page.locator('#symbol-detail-view')).toContainText(SYMBOL);
  await noScriptRan(page, 'the payload symbol detail');

  await open(page, 'architecture');
  await expect(page.locator('#arch-smells-list')).toContainText(`evil${XSS}.ts`);

  await open(page, 'metrics');
  await expect(page.locator('#tab-metrics')).not.toContainText('Loading');

  await open(page, 'tool-log');
  await expect(page.locator('#tool-log-container .log-entry')).toContainText(`mapx_query${XSS}`);

  await open(page, 'context');
  await page.fill('#context-task', 'evilFn loop');
  await page.click('#btn-build-context');
  await expect(page.locator('#context-results')).toContainText('Key Context Files');
  await noScriptRan(page, 'building a context');

  await open(page, 'graph');
  await page.selectOption('#select-graph-mode', 'focus');
  await page.fill('#focus-search-input', 'onerror');
  await expect(page.locator('#focus-autocomplete')).toContainText(`evil${XSS}.ts`);
  await noScriptRan(page, 'the focus autocomplete');

  // The graph's details panel for each payload file (review 2026-11-02).
  await page.selectOption('#select-graph-mode', 'full');
  await graphReady(page);
  for (const id of [`src/evil${XSS}.ts`, `src/quote"><img src=x onerror=window.__xss=1>.ts`, `src/store/actions.js`]) {
    expect(await page.evaluate((i) => window.__mapxSelect(i), id)).toBe(true);
    await expect(page.locator('#details-content')).toContainText(id.split('/').pop()!);
    await noScriptRan(page, `the details panel of ${id}`);
  }

  // Metrics lists files by PageRank: the payload files rank highly in this small fixture.
  await open(page, 'metrics');
  await expect(page.locator('#top-files-list')).toContainText('onerror');
  await noScriptRan(page, 'the metrics top files');
});

test('workspace, HTTP and config views show repo names, handlers and config values as text', async ({ page }) => {
  await watchPayloads(page);
  await page.goto(served.url);
  await graphReady(page);
  await noScriptRan(page, 'loading the dashboard');

  // The repo switcher (option values) and the Workspace tab (data-repo attributes).
  await expect(page.locator('#select-repo option')).toContainText([WEB]);
  expect(await page.locator('#select-repo option').evaluateAll((os) => os.map((o: any) => o.value))).toContain(WEB);
  await open(page, 'workspace');
  await expect(page.locator('#table-repos tbody')).toContainText(WEB);
  await expect(page.locator('#table-repos tbody .link-btn').filter({ hasText: WEB })).toHaveAttribute('data-repo', WEB);
  await expect(page.locator('#workspace-cross .cross-pair')).toContainText(WEB);

  // The HTTP tab: the flow, the pair filter, the table and both ends of the matched call.
  await open(page, 'http');
  await expect(page.locator('#table-http tbody tr')).toHaveCount(2);
  await expect(page.locator('#table-http tbody')).toContainText(`/api/orders${XSS}`);
  await expect(page.locator('#table-http tbody')).toContainText(`/api/nowhere${XSS}`);
  await expect(page.locator('#table-http tbody')).toContainText(HANDLER);
  await expect(page.locator('#http-flow')).toContainText('web"><img');
  await expect(page.locator('#http-filter-pair option')).toContainText([`${WEB} → no route (1)`]);
  await page.selectOption('#http-filter-status', 'matched');
  await page.locator('#table-http tbody .link-btn').first().click();
  const detail = page.locator('#http-detail');
  await expect(detail).toContainText(`Caller, in ${WEB}`);
  await expect(detail).toContainText(`${WEB}/src/api.ts:`);
  await expect(detail).toContainText(`axios.get('/api/orders${XSS}')`); // the caller's code
  await expect(detail).toContainText(HANDLER);
  await expect(detail.locator('[data-go-id]').first()).toHaveAttribute('data-go-id', `${WEB}/src/api.ts`);
  await noScriptRan(page, 'the HTTP call detail');

  // The Configuration tab: a user pattern, an unknown key and an invalid value.
  await open(page, 'config');
  await expect(page.locator('#table-config tr[data-setting="excludePatterns"] .config-chip.is-user')).toHaveText([`gen${XSS}/**`]);
  await expect(page.locator('#config-warnings')).toContainText(`settings.colour${QUOTE}: unknown setting`);
  await expect(page.locator('#table-config tr[data-setting="parseWorkers"]')).toContainText(XSS);
  await expect(page.locator('#table-config-repos tbody')).toContainText(WEB);

  // Choosing the repo puts its name in the URL and scopes the views to it.
  await page.selectOption('#select-repo', WEB);
  await expect.poll(() => new URL(page.url()).searchParams.get('repo')).toBe(WEB);
  await graphReady(page);
  await expect(page.locator('#repo-name')).toHaveText(WEB);
  await noScriptRan(page, 'choosing the payload repo');
  await open(page, 'symbols');
  await expect(page.locator('#table-symbols tbody td:last-child').first()).toContainText(`${WEB}/src/api.ts`);
  await open(page, 'workspace');
  await expect(page.locator('#table-repos tr.current-repo')).toContainText(WEB);

  // A payload as an unknown repo in the URL falls back to all repos.
  await page.goto(`${served.url}?repo=${encodeURIComponent(QUOTE)}`);
  await expect(page.locator('#select-repo')).toHaveValue('');
  await graphReady(page);
  await noScriptRan(page, 'a payload as the repo in the URL');
});

test('the specs above opened every tab the navigation lists', async ({ page }) => {
  await page.goto(served.url);
  const tabs = await navTabs(page);
  expect(tabs).toEqual(expect.arrayContaining(['workspace', 'http', 'config']));
  expect([...opened].sort()).toEqual(tabs);
});
