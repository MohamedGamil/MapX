import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { cli } from '../scripts/ui/workspace.js';
import { Store } from '../src/core/store.js';
import { loadArchitectureConfig } from '../src/arch/config.js';
import { buildElementView, qualifiedName, QUALIFIED_NAME_RULES, type Element, type ElementView } from '../src/arch/elements.js';
import { matchSelector } from '../src/arch/selectors/index.js';
import { computeMembership, getMembership, membershipComputations } from '../src/arch/membership.js';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import type { ArchitectureConfig, Selector } from '../src/arch/schema.js';

// M5-03: the element view, the core selectors and layer membership, on the M5-01 fixture apps.
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');
interface App { root: string; store: Store; view: ElementView; config: ArchitectureConfig }
const apps: Record<string, App> = {};

function scanApp(name: string, repos: string[] = []): App {
  const root = mkdtempSync(join(tmpdir(), `mapx-arch-sel-${name}-`));
  cpSync(join(FIXTURE, name), root, { recursive: true });
  cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
  for (const r of repos) { execFileSync('git', ['init', '-q', join(root, r)]); cli(root, 'workspaces', 'add', r); }
  cli(root, 'scan');
  const store = new Store(join(root, '.mapx/mapx.db'));
  return { root, store, view: buildElementView(store, root), config: loadArchitectureConfig(root)! };
}

beforeAll(() => {
  apps['php'] = scanApp('php');
  apps['ts'] = scanApp('ts');
  apps['python'] = scanApp('python');
  apps['workspace'] = scanApp('workspace', ['frontend', 'backend']);
}, 300_000);
afterAll(() => {
  for (const a of Object.values(apps)) { a.store.close(); rmSync(a.root, { recursive: true, force: true }); }
});

const el = (app: string, qn: string): Element => {
  const found = apps[app]!.view.elements.find((e) => e.qualifiedName === qn);
  if (!found) throw new Error(`${app}: no element ${qn}`);
  return found;
};
const fileEl = (app: string, path: string) => apps[app]!.view.byId.get(`file:${path}`)!;
const noLayers = { view: undefined as unknown as ElementView, inLayer: () => false };
const matches = (app: string, sel: Selector, e: Element) => matchSelector(sel, e, { ...noLayers, view: apps[app]!.view }).matched;

describe('selectors (PHP, TypeScript and Python apps)', () => {
  it('path: a glob or /regex/ on the workspace-relative path, judged on a symbol\'s file', () => {
    expect(matches('php', { path: 'app/Domain/**' }, el('php', 'App\\Domain\\Order'))).toBe(true);
    expect(matches('php', { path: 'app/Domain/**' }, el('php', 'App\\Application\\PlaceOrder'))).toBe(false);
    expect(matches('ts', { path: '/^src\\/domain\\/ids\\//' }, fileEl('ts', 'src/domain/ids/OrderId.ts'))).toBe(true);
    expect(matches('ts', { path: '/^src\\/domain\\/ids\\//' }, fileEl('ts', 'src/domain/Order.ts'))).toBe(false);
    expect(matches('python', { path: 'app/support/*.py' }, el('python', 'app.support.clock.Clock'))).toBe(true);
    expect(matches('python', { path: 'app/support/*.py' }, el('python', 'app.shared.text.Text'))).toBe(false);
  });

  it('name: a case-insensitive regex on the qualified name, kinds optional; files never match', () => {
    expect(matches('php', { name: '^app\\\\domain\\\\' }, el('php', 'App\\Domain\\Order'))).toBe(true);
    expect(matches('php', { name: '/^app\\\\domain\\\\/' }, el('php', 'App\\Domain\\Order'))).toBe(false); // /…/ without i is case-sensitive
    expect(matches('php', { name: '^App\\\\Domain\\\\', kind: ['class'] }, el('php', 'App\\Domain\\Order::run'))).toBe(false);
    expect(matches('php', { name: '^App\\\\Domain\\\\', kind: ['method'] }, el('php', 'App\\Domain\\Order::run'))).toBe(true);
    expect(matches('php', { name: 'Domain' }, fileEl('php', 'app/Domain/Order.php'))).toBe(false);
    expect(matches('ts', { name: '#OrderController$' }, el('ts', 'src/controller/OrderController.ts#OrderController'))).toBe(true);
    expect(matches('ts', { name: '#OrderController$' }, el('ts', 'src/controller/ReportController.ts#ReportController'))).toBe(false);
    expect(matches('python', { name: '^app\\.application\\.internal\\.' }, el('python', 'app.application.internal.pricing_rules.PricingRules'))).toBe(true);
    expect(matches('python', { name: '^app\\.application\\.internal\\.' }, el('python', 'app.application.place_order.PlaceOrder'))).toBe(false);
  });

  it('all, any and not compose selectors', () => {
    const order = el('php', 'App\\Domain\\Order');
    expect(matches('php', { all: [{ path: 'app/**' }, { name: 'Order$' }] }, order)).toBe(true);
    expect(matches('php', { all: [{ path: 'app/**' }, { name: 'Money$' }] }, order)).toBe(false);
    expect(matches('ts', { any: [{ path: 'nope/**' }, { language: 'ts' }] }, el('ts', 'src/domain/Order.ts#Order'))).toBe(true);
    expect(matches('ts', { any: [{ path: 'nope/**' }, { language: 'python' }] }, el('ts', 'src/domain/Order.ts#Order'))).toBe(false);
    expect(matches('python', { not: { path: 'app/support/**' } }, el('python', 'app.domain.order.Order'))).toBe(true);
    expect(matches('python', { not: { path: 'app/support/**' } }, el('python', 'app.support.uuid.Uuid'))).toBe(false);
  });

  it('language: the file\'s language, with common aliases', () => {
    expect(matches('php', { language: 'PHP' }, el('php', 'App\\Domain\\Order'))).toBe(true);
    expect(matches('ts', { language: 'ts' }, el('ts', 'src/domain/Order.ts#Order'))).toBe(true);
    expect(matches('python', { language: 'py' }, el('python', 'app.domain.order.Order'))).toBe(true);
    expect(matches('python', { language: 'typescript' }, el('python', 'app.domain.order.Order'))).toBe(false);
  });

  it('repo: the repo the file belongs to, exactly or by glob', () => {
    for (const app of ['php', 'ts', 'python']) {
      const e = apps[app]!.view.elements.find((x) => x.kind === 'symbol')!;
      expect(matches(app, { repo: basename(apps[app]!.root) }, e)).toBe(true);
      expect(matches(app, { repo: 'mapx-arch-sel-*' }, e)).toBe(true);
      expect(matches(app, { repo: 'other' }, e)).toBe(false);
    }
    expect(matches('workspace', { repo: 'backend' }, fileEl('workspace', 'backend/app/Http/Controllers/Api/OrderController.php'))).toBe(true);
    expect(matches('workspace', { repo: 'backend' }, fileEl('workspace', 'frontend/src/orders.ts'))).toBe(false);
  });

  it('role: the file\'s MapX role, at a minimum confidence', () => {
    for (const app of ['php', 'ts', 'python']) {
      const e = apps[app]!.view.elements.find((x) => x.kind === 'file' && x.file.role && x.file.role !== 'other')!;
      expect(e, app).toBeDefined();
      expect(matches(app, { role: e.file.role!.toUpperCase() }, e), app).toBe(true);
      expect(matches(app, { role: e.file.role!, confidence: Math.min(1, e.file.roleConfidence + 0.01) }, e), app).toBe(e.file.roleConfidence >= 1);
      expect(matches(app, { role: 'no-such-role' }, e), app).toBe(false);
    }
  });

  it('cluster: a cluster the file is in, exactly or by glob', () => {
    for (const app of ['php', 'ts', 'python']) {
      const e = apps[app]!.view.elements.find((x) => x.kind === 'file' && x.file.clusters.length)!;
      expect(e, app).toBeDefined();
      expect(matches(app, { cluster: e.file.clusters[0]! }, e), app).toBe(true);
      expect(matches(app, { cluster: 'no-such-cluster*' }, e), app).toBe(false);
    }
    expect(matches('php', { cluster: 'App.Application*' }, el('php', 'App\\Application\\PlaceOrder'))).toBe(true);
  });

  it('workspacePackage: the nearest manifest\'s name', () => {
    expect(matches('php', { workspacePackage: 'fixture/arch-php' }, el('php', 'App\\Domain\\Order'))).toBe(true);
    expect(matches('ts', { workspacePackage: 'arch-ts' }, el('ts', 'src/domain/Order.ts#Order'))).toBe(true);
    expect(matches('python', { workspacePackage: 'arch-*' }, el('python', 'app.domain.order.Order'))).toBe(true);
    expect(matches('python', { workspacePackage: 'arch-ts' }, el('python', 'app.domain.order.Order'))).toBe(false);
    expect(matches('workspace', { workspacePackage: 'frontend' }, fileEl('workspace', 'frontend/src/orders.ts'))).toBe(true);
    expect(matches('workspace', { workspacePackage: 'frontend' }, fileEl('workspace', 'backend/routes/api.php'))).toBe(false);
  });

  it('framework: parts derived from stored edges', () => {
    expect(matches('workspace', { framework: 'route-handler' }, fileEl('workspace', 'backend/app/Http/Controllers/Api/OrderController.php'))).toBe(true);
    expect(matches('workspace', { framework: 'http-client' }, fileEl('workspace', 'frontend/src/orders.ts'))).toBe(true);
    expect(matches('workspace', { framework: 'route-handler' }, fileEl('workspace', 'frontend/src/orders.ts'))).toBe(false);
    // The single-language apps have no route, http or render edges: no element is a framework part.
    for (const app of ['php', 'ts', 'python']) {
      expect(apps[app]!.view.elements.some((e) => matches(app, { framework: 'route-handler' }, e) || matches(app, { framework: 'component' }, e)), app).toBe(false);
    }
  });

  it('layer: membership in another layer', () => {
    const m = computeMembership(apps['php']!.view, { layers: [...apps['php']!.config.layers, { name: 'Core', selectors: [{ any: [{ layer: 'Domain' }, { layer: 'Shared' }] }] }] });
    expect(m.of(el('php', 'App\\Domain\\Order'))).toContain('Core');
    expect(m.of(el('php', 'App\\Shared\\Text'))).toContain('Core');
    expect(m.of(el('php', 'App\\Application\\PlaceOrder'))).not.toContain('Core');
    expect(m.explain(el('php', 'App\\Shared\\Text')).find((t) => t.layer === 'Core')!.selector).toBe('selectors[0].any[1].layer');
  });
});

describe('layer membership on the fixture apps', () => {
  // What the M5-01 design puts each directory in (Domain/Ids is also Shared: the multi-layer element).
  const EXPECTED: Record<string, string[]> = {
    controller: ['Controller'], application: ['Application'], 'application/internal': ['Application'], domain: ['Domain'],
    'domain/ids': ['Domain', 'Shared'], shared: ['Shared'], infrastructure: ['Infrastructure'], support: [],
  };
  const dirOf: Record<string, (path: string) => string> = {
    php: (p) => p.replace(/^app\//, '').replace(/\/[^/]+$/, '').toLowerCase(),
    ts: (p) => p.replace(/^src\//, '').replace(/\/[^/]+$/, ''),
    python: (p) => p.replace(/^app\//, '').replace(/\/[^/]+$/, ''),
  };

  it('every class of the PHP, TypeScript and Python apps is in the layers the M5-01 design implies', () => {
    for (const app of ['php', 'ts', 'python']) {
      const m = computeMembership(apps[app]!.view, apps[app]!.config);
      const classes = apps[app]!.view.elements.filter((e) => e.kind === 'symbol' && e.symbolKind === 'class');
      expect(classes.length, app).toBe(18);
      for (const c of classes) {
        const dir = dirOf[app]!(c.file.path);
        expect(m.of(c), `${app} ${c.qualifiedName}`).toEqual(EXPECTED[dir]);
        expect(m.of(fileEl(app, c.file.path)), `${app} ${c.file.path}`).toEqual(EXPECTED[dir]);
        expect(m.privateIn(c), `${app} ${c.qualifiedName}`).toEqual(dir === 'application/internal' ? ['Application'] : []);
      }
      expect(m.emptyLayers, app).toEqual(['Reporting']);
      expect(m.multiLayer.filter((e) => e.symbolKind === 'class').map((e) => e.name), app).toEqual(['OrderId']);
      expect(m.unsupported, app).toEqual([]);
    }
  });

  it('explains a membership: the selector, and the top-level symbol that put a file in a layer', () => {
    const m = computeMembership(apps['php']!.view, apps['php']!.config);
    expect(m.explain(el('php', 'App\\Domain\\Order'))).toEqual([{ layer: 'Domain', selector: 'selectors[0].name', via: 'self' }]);
    // Domain selects by namespace, so the file is in Domain through its class.
    expect(m.explain(fileEl('php', 'app/Domain/Order.php'))).toEqual([{ layer: 'Domain', selector: 'selectors[0].name', via: 'App\\Domain\\Order' }]);
    expect(m.explain(el('php', 'App\\Domain\\Ids\\OrderId')).map((t) => [t.layer, t.selector])).toEqual([['Domain', 'selectors[0].name'], ['Shared', 'selectors[1].path']]);
  });

  it('reports selectors later tasks evaluate, and they match nothing', () => {
    const m = computeMembership(apps['ts']!.view, { layers: [{ name: 'Old', overlay: true, selectors: [{ docTag: '@deprecated' }, { any: [{ extends: 'Base' }] }] }] });
    expect(m.unsupported).toEqual([
      { layer: 'Old', selector: 'selectors[0]', key: 'docTag', task: 'M5-10' },
      { layer: 'Old', selector: 'selectors[1]', key: 'extends', task: 'M5-09' },
    ]);
    expect(m.members('Old')).toEqual([]);
    expect(m.emptyLayers).toEqual([]); // an overlay is never "empty-layer"
  });

  it('computes membership once per scan and configuration', () => {
    const a = apps['python']!;
    const key = join(a.root, '.mapx/mapx.db');
    const before = membershipComputations();
    const first = getMembership(a.store, a.root, a.config, key);
    const second = getMembership(a.store, a.root, a.config, key);
    expect(second).toBe(first);
    expect(membershipComputations()).toBe(before + 1);
    // Another configuration: computed again.
    const other = { ...a.config, layers: a.config.layers.filter((l) => l.name !== 'Reporting') };
    expect(getMembership(a.store, a.root, other, key)).not.toBe(first);
    expect(membershipComputations()).toBe(before + 2);
    // A new scan: computed again, on a new view.
    appendFileSync(join(a.root, 'app/domain/money.py'), '\n\nclass Cents:\n    pass\n');
    cli(a.root, 'sync');
    const after = getMembership(a.store, a.root, a.config, key);
    expect(after).not.toBe(first);
    expect(membershipComputations()).toBe(before + 3);
    expect(after.view.elements.some((e) => e.qualifiedName === 'app.domain.money.Cents')).toBe(true);
  }, 120_000);
});

describe('qualified names for every built-in language', () => {
  const symbol = { name: 'Order', scope: 'Shop' };
  // Inputs per normalisation style: [namespace or null, file, expected for the file, expected for Shop.Order].
  const EXPECTED: Record<string, (path: string) => [string | null, string, string]> = {
    php: () => ['App\\Domain', 'App\\Domain', 'App\\Domain\\Shop::Order'],
    java: () => ['com.acme.domain', 'com.acme.domain', 'com.acme.domain.Shop.Order'],
    kotlin: () => ['com.acme.domain', 'com.acme.domain', 'com.acme.domain.Shop.Order'],
    scala: () => ['com.acme.domain', 'com.acme.domain', 'com.acme.domain.Shop.Order'],
    'c-sharp': () => ['Acme.Domain', 'Acme.Domain', 'Acme.Domain.Shop.Order'],
    dart: () => ['acme.domain', 'acme.domain', 'acme.domain.Shop.Order'],
    cpp: () => ['acme::domain', 'acme::domain', 'acme::domain::Shop::Order'],
    go: () => ['example.com/shop/domain', 'example.com/shop/domain', 'example.com/shop/domain.Shop.Order'],
    python: (p) => [null, p.replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '.'), `${p.replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '.')}.Shop.Order`],
    rust: () => [null, 'crate::domain::order', 'crate::domain::order::Shop::Order'],
    ruby: (p) => [null, p, 'Shop::Order'],
    elixir: (p) => [null, p, 'Shop.Order'],
  };
  const pathFor = (lang: string, ext: string) => (lang === 'rust' ? 'src/domain/order.rs' : `src/domain/order${ext}`);

  it('has a rule for every language the registry knows, and applies it', () => {
    const languages = getBuiltinLanguages();
    expect(Object.keys(languages).length).toBeGreaterThanOrEqual(22);
    for (const [lang, def] of Object.entries(languages)) {
      expect(QUALIFIED_NAME_RULES[lang], `${lang} has no rule`).toBeDefined();
      const path = pathFor(lang, (def as any).extensions[0]);
      const style = QUALIFIED_NAME_RULES[lang]!.style;
      if (EXPECTED[lang]) {
        const [ns, file, sym] = EXPECTED[lang]!(path);
        expect(qualifiedName(lang, { path, namespace: ns }), `${lang} file`).toBe(file);
        expect(qualifiedName(lang, { path, namespace: ns, ...symbol }), `${lang} symbol`).toBe(sym);
      } else {
        expect(style, lang).toBe('path');
        expect(qualifiedName(lang, { path }), `${lang} file`).toBe(path);
        expect(qualifiedName(lang, { path, ...symbol }), `${lang} symbol`).toBe(`${path}#Shop.Order`);
        expect(qualifiedName(lang, { path, name: 'top' }), `${lang} top-level`).toBe(`${path}#top`);
      }
    }
  });

  it('falls back to the path where a namespace language has none, and handles module edge cases', () => {
    expect(qualifiedName('java', { path: 'Order.java', name: 'Order' })).toBe('Order.java#Order');
    expect(qualifiedName('php', { path: 'helpers.php', name: 'helper' })).toBe('helpers.php#helper');
    expect(qualifiedName('python', { path: 'app/domain/__init__.py', name: 'X' })).toBe('app.domain.X');
    expect(qualifiedName('python', { path: 'svc/app/a.py', name: 'X', repoPath: 'svc' })).toBe('app.a.X');
    expect(qualifiedName('rust', { path: 'src/domain/mod.rs', name: 'X' })).toBe('crate::domain::X');
    expect(qualifiedName('rust', { path: 'src/lib.rs', name: 'X' })).toBe('crate::X');
    expect(qualifiedName('go', { path: 'domain/order.go', name: 'Order' })).toBe('domain.Order');
  });

  it('the scanned apps get those names: PHP namespaces, Python modules, TypeScript paths', () => {
    expect(el('php', 'App\\Domain\\Order').kind).toBe('symbol');
    expect(el('php', 'App\\Domain\\Order::run').symbolKind).toBe('method');
    expect(el('python', 'app.domain.order.Order.run').symbolKind).toBe('method');
    expect(el('ts', 'src/domain/Order.ts#Order.run').symbolKind).toBe('method');
    expect(fileEl('php', 'app/Domain/Order.php').qualifiedName).toBe('App\\Domain');
  });
});
