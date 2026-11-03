import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { cli } from '../scripts/ui/workspace.js';
import { Store } from '../src/core/store.js';
import { loadArchitectureConfig } from '../src/arch/config.js';
import { buildElementView, qualifiedName, QUALIFIED_NAME_RULES, type Element, type ElementView } from '../src/arch/elements.js';
import { matchSelector } from '../src/arch/selectors/index.js';
import { computeMembership, getMembership, membershipComputations } from '../src/arch/membership.js';
import { getBuiltinLanguages, isCppHeader } from '../src/languages/registry.js';
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
      // 18 from M5-01, and the HttpGateway of the external references (M5-19); Python has two more,
      // M5-11's CloseOrder and the `_journal` module's Journal.
      expect(classes.length, app).toBe(app === 'python' ? 21 : 19);
      for (const c of classes) {
        const dir = dirOf[app]!(c.file.path);
        expect(m.of(c), `${app} ${c.qualifiedName}`).toEqual(EXPECTED[dir]);
        expect(m.of(fileEl(app, c.file.path)), `${app} ${c.file.path}`).toEqual(EXPECTED[dir]);
        expect(m.privateIn(c), `${app} ${c.qualifiedName}`).toEqual(dir === 'application/internal' ? ['Application'] : []);
      }
      // A file is private to a layer through its top-level symbol when the private selector is a
      // symbol-level one (PHP and Python select Application/Internal by name) (M5-03-R1).
      const internal = apps[app]!.view.elements.filter((e) => e.kind === 'file' && /application\/internal\//i.test(e.file.path) && !e.file.path.endsWith('__init__.py'));
      expect(internal.length, app).toBe(2);
      for (const f of internal) expect(m.privateIn(f), `${app} ${f.file.path}`).toEqual(['Application']);
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
    const m = computeMembership(apps['ts']!.view, { layers: [{ name: 'Old', overlay: true, selectors: [{ member: 'run' }, { any: [{ extends: 'Base' }] }] }] });
    expect(m.unsupported).toEqual([
      { layer: 'Old', selector: 'selectors[0]', key: 'member', task: 'M5-09' },
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
    // A sync that keeps every count (review 2026-11-02): still a new scan, so computed again.
    appendFileSync(join(a.root, 'app/domain/money.py'), '\n# a comment changes no count\n');
    cli(a.root, 'sync');
    expect(getMembership(a.store, a.root, a.config, key)).not.toBe(after);
    expect(membershipComputations()).toBe(before + 4);
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
    cpp: (p) => [null, p, 'Shop::Order'], // scoped: namespaces come from enclosing symbols (real-scan test below)
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

describe('M5-03-R1: qualified names from a real scan of every namespace or module language', () => {
  let root = '';
  let view: ElementView;
  let store: Store;
  const FILES: Record<string, string> = {
    'php/src/Order.php': '<?php\nnamespace App\\Domain;\nclass Order { public function run() {} }\n',
    'java/com/acme/domain/Order.java': 'package com.acme.domain;\npublic class Order { public void run() {} }\n',
    'cs/Order.cs': 'namespace Acme.Domain {\n public class Order { public void Run() {} }\n}\n',
    'cs/Repo.cs': 'namespace Acme.Infra;\npublic class Repo { public void Save() {} }\n',
    'cpp/order.cpp': 'namespace acme {\nnamespace domain {\nclass Order { public: void run(); };\nvoid Order::run() {}\n}\n}\nnamespace acme::infra {\nclass Repo {};\n}\n',
    'rb/invoice.rb': 'module Billing\n  module Core\n    class Invoice\n      def pay; end\n    end\n  end\nend\nclass Billing::Receipt\n  def print; end\nend\n',
    'ex/invoice.ex': 'defmodule Billing.Invoice do\n  def pay(x), do: x\nend\n',
    'dart/lib/order.dart': 'library acme.domain;\nclass Order { void run() {} }\n',
    'rsub/crate1/Cargo.toml': '[package]\nname = "crate1"\n',
    'rsub/crate1/src/lib.rs': 'pub mod domain;\n',
    'rsub/crate1/src/domain/order.rs': 'pub struct Order;\nimpl Order { pub fn run(&self) {} }\n',
    'pysub/svc/pyproject.toml': '[project]\nname = "svc"\n',
    'pysub/svc/src/app/__init__.py': '',
    'pysub/svc/src/app/domain/order.py': 'class Order:\n    def run(self):\n        pass\n',
    'go/go.mod': 'module example.com/shop\n',
    'go/domain/order.go': 'package domain\ntype Order struct{}\nfunc (o *Order) Run() {}\n',
    'scala/Order.scala': 'package com.acme.domain\nclass Order { def run(): Unit = {} }\nobject Util { def x = 1 }\n',
    'kt/Order.kt': 'package com.acme.domain\nclass Order { fun run() {} }\n',
    'web/App.tsx': 'export function App() { return null; }\n',
    // Review of M5-03-R1: same-line containers, out-of-line members, namespace-scoped aliases,
    // a root-qualified Ruby class, and an Elixir (Phoenix-style) controller.
    'cpp/oneline.cpp': 'namespace one { class A {}; void freeF() {} }\n',
    'cpp/outer.cpp': 'namespace acme {\nclass Outer {\n  class Inner { void f(); };\n  void g();\n};\nvoid Outer::Inner::f() {}\nvoid Outer::g() {}\nnamespace domain {\nusing OrderId = long;\n}\n}\n',
    'rb/top.rb': 'class ::Top::Thing\n  def m; end\nend\n',
    'ex/order_controller.ex': 'defmodule AppWeb.OrderController do\n  def index(conn), do: conn\nend\n',
    'web/util.ts': 'export function util() { return 1; }\n',
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-arch-qn-'));
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    cli(root, 'scan');
    store = new Store(join(root, '.mapx/mapx.db'));
    view = buildElementView(store, root);
  }, 120_000);
  afterAll(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });

  const names = (prefix: string) => view.elements.filter((e) => e.kind === 'symbol' && e.file.path.startsWith(prefix)).map((e) => e.qualifiedName).sort();

  it('stored symbols get the documented qualified name in each language', () => {
    expect(names('php/')).toEqual(['App\\Domain\\Order', 'App\\Domain\\Order::run']);
    expect(names('java/')).toEqual(['com.acme.domain.Order', 'com.acme.domain.Order.run']);
    expect(names('cs/')).toEqual(['Acme.Domain.Order', 'Acme.Domain.Order.Run', 'Acme.Infra.Repo', 'Acme.Infra.Repo.Save']);
    // Nested namespace blocks, a C++17 `a::b` namespace, and an out-of-line method definition.
    expect(names('cpp/order.cpp')).toEqual(['acme::domain::Order', 'acme::domain::Order::run', 'acme::infra::Repo']);
    // Out-of-line members under their type's full name; a type on one line does not swallow its neighbours.
    expect(names('cpp/outer.cpp')).toEqual(['acme::Outer', 'acme::Outer::Inner', 'acme::Outer::Inner::f', 'acme::Outer::g', 'acme::domain::OrderId']);
    expect(names('cpp/oneline.cpp')).toEqual(['one::A', 'one::freeF']);
    // Nested modules, compact `class Billing::Receipt`, and root-qualified `class ::Top::Thing`.
    expect(names('rb/invoice.rb')).toEqual(['Billing', 'Billing::Core', 'Billing::Core::Invoice', 'Billing::Core::Invoice::pay', 'Billing::Receipt', 'Billing::Receipt::print']);
    expect(names('rb/top.rb')).toEqual(['Top::Thing', 'Top::Thing::m']);
    expect(names('ex/invoice.ex')).toEqual(['Billing.Invoice', 'Billing.Invoice.pay']);
    expect(names('dart/')).toEqual(['acme.domain.Order', 'acme.domain.Order.run']);
    // A crate in a subfolder: module paths start at its Cargo.toml.
    expect(names('rsub/')).toEqual(['crate::domain', 'crate::domain::order::Order', 'crate::domain::order::Order::run']);
    // A package in a subfolder: module paths start at its pyproject.toml, without src/.
    expect(names('pysub/')).toEqual(['app.domain.order.Order', 'app.domain.order.Order.run']);
    expect(names('go/')).toEqual(['example.com/shop/domain.Order', 'example.com/shop/domain.Order.Run']);
    // Members of a Scala object belong to it.
    expect(names('scala/')).toEqual(['com.acme.domain.Order', 'com.acme.domain.Order.run', 'com.acme.domain.Util', 'com.acme.domain.Util.x']);
    // Kotlin's package is not captured: the documented path fallback.
    expect(names('kt/')).toEqual(['kt/Order.kt#Order', 'kt/Order.kt#Order.run']);
  });

  it('marks file-level declarations as top-level, members and nested types not', () => {
    const top = (qn: string) => view.elements.find((e) => e.qualifiedName === qn)!.topLevel;
    expect(top('acme::domain::Order')).toBe(true); // inside namespaces only
    expect(top('acme::domain::Order::run')).toBe(false);
    expect(top('Billing::Core::Invoice')).toBe(true);
    expect(top('Billing::Receipt')).toBe(true);
    expect(top('Billing::Core::Invoice::pay')).toBe(false);
    expect(top('acme::domain::OrderId')).toBe(true); // an alias directly in a namespace
    expect(top('one::freeF')).toBe(true);
    expect(top('acme::Outer::g')).toBe(false);
    // An Elixir module is a type: its functions are members, not file-level declarations.
    expect(top('AppWeb.OrderController')).toBe(true);
    expect(top('AppWeb.OrderController.index')).toBe(false);
    expect(top('Billing.Invoice.pay')).toBe(false);
  });

  it('AR-01 on an Elixir controller: its file is in Controller only (review of M5-03-R1)', () => {
    const m = computeMembership(view, { layers: [
      { name: 'Controller', selectors: [{ name: 'Controller$' }] },
      { name: 'Domain', selectors: [{ all: [{ path: 'ex/**' }, { not: { name: 'Controller$' } }] }] },
    ] });
    expect(m.of(view.byId.get('file:ex/order_controller.ex')!)).toEqual(['Controller']);
    expect(m.of(view.byId.get('file:ex/invoice.ex')!)).toEqual(['Domain']);
  });

  it('language: typescript (and ts) matches .ts and .tsx files; tsx only .tsx', () => {
    const app = view.byId.get('file:web/App.tsx')!;
    const util = view.byId.get('file:web/util.ts')!;
    const ctx = { view, inLayer: () => false };
    expect(app.file.language).toBe('tsx');
    for (const language of ['typescript', 'ts', 'TypeScript']) {
      expect(matchSelector({ language }, app, ctx).matched, language).toBe(true);
      expect(matchSelector({ language }, util, ctx).matched, language).toBe(true);
    }
    expect(matchSelector({ language: 'tsx' }, app, ctx).matched).toBe(true);
    expect(matchSelector({ language: 'tsx' }, util, ctx).matched).toBe(false);
  });
});

describe('M5-03-R1: not over a symbol-level selector (AR-01 file membership)', () => {
  // Domain is "everything under app/ except controllers by name". A file has no name, so the
  // `name` selector is inapplicable to it, and `not` of it does not match either: the file is in
  // Domain only through a top-level symbol that is.
  const layers = [
    { name: 'Controller', selectors: [{ name: 'Controller$', kind: ['class' as const] }] },
    { name: 'Domain', selectors: [{ all: [{ path: 'app/**' }, { not: { name: 'Controller$' } }] }] },
  ];

  it('a controller file is in Controller only; a domain file is in Domain through its class', () => {
    const m = computeMembership(apps['php']!.view, { layers });
    expect(m.of(el('php', 'App\\Controller\\OrderController'))).toEqual(['Controller']);
    expect(m.of(fileEl('php', 'app/Controller/OrderController.php'))).toEqual(['Controller']);
    expect(m.of(el('php', 'App\\Domain\\Order'))).toEqual(['Domain']);
    expect(m.explain(fileEl('php', 'app/Domain/Order.php'))).toEqual([{ layer: 'Domain', selector: 'selectors[0].all', via: 'App\\Domain\\Order' }]);
  });

  it('not, all and any of an inapplicable selector are not matches on a file', () => {
    const file = fileEl('php', 'app/Controller/OrderController.php');
    const ctx = { view: apps['php']!.view, inLayer: () => false };
    expect(matchSelector({ not: { name: 'Controller$' } }, file, ctx)).toEqual({ matched: false, inapplicable: true });
    expect(matchSelector({ not: { not: { name: 'x' } } }, file, ctx).matched).toBe(false);
    expect(matchSelector({ any: [{ not: { name: 'x' } }, { path: 'app/**' }] }, file, ctx).matched).toBe(true);
    expect(matchSelector({ all: [{ path: 'nope/**' }, { not: { name: 'x' } }] }, file, ctx)).toEqual({ matched: false });
    // Three-valued logic: `not` of an `any` that mixes an inapplicable branch with a plain miss
    // does not match a file either (review of M5-03-R1).
    expect(matchSelector({ not: { any: [{ name: 'Controller$' }, { path: 'nope/**' }] } }, file, ctx)).toEqual({ matched: false, inapplicable: true });
    const m = computeMembership(apps['php']!.view, { layers: [
      { name: 'Domain', selectors: [{ all: [{ path: 'app/**' }, { not: { any: [{ name: 'Controller$' }, { path: 'app/Legacy/**' }] } }] }] },
    ] });
    expect(m.of(file)).toEqual([]);
    expect(m.of(fileEl('php', 'app/Domain/Order.php'))).toEqual(['Domain']);
    // Selectors a later task evaluates are inapplicable too: their negation selects nothing.
    expect(matchSelector({ not: { member: 'run' } }, file, ctx).matched).toBe(false);
    // On a symbol, not(name) is an ordinary negation.
    expect(matchSelector({ not: { name: 'Controller$' } }, el('php', 'App\\Domain\\Order'), ctx).matched).toBe(true);
  });
});

describe('M5-03-R2: C++ in .h headers, several C# namespace blocks, one-line C++ namespaces', () => {
  let root = '';
  let view: ElementView;
  let store: Store;
  // A guarded C header whose C++ glue sits in conditionals; the review of M5-03-R2 found its
  // `&& !defined(…)` test taken as C++. Identical content in the unit test below.
  const C_HEADER = '#ifndef BUF_H\n#define BUF_H\n#include <stddef.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n'
    + 'typedef struct buf { char *data; size_t len; } buf_t;\nint buf_init(buf_t *b, size_t n);\n'
    + 'static inline size_t buf_len(const buf_t *b) { return buf_size(b); }\n#define BUF_EMPTY { 0, 0 }\n'
    + '#ifdef __cplusplus\n}\n#endif\n#if defined(__cplusplus) && !defined(BUF_NO_CXX)\n'
    + 'template <typename T> inline int buf_push(buf_t *b, const T &v) { return buf_append(b, &v, sizeof v); }\n#endif\n#endif\n';
  const FILES: Record<string, string> = {
    // A C++ header inside an include guard: parsed as C, it gave no symbols at all.
    'inc/order.h': '#ifndef ACME_ORDER_H\n#define ACME_ORDER_H\nnamespace acme {\nclass Order {\npublic:\n  void run();\n};\n}\n#endif\n',
    'c/buf.h': C_HEADER,
    'c/buf.c': '#include "buf.h"\nsize_t buf_size(const buf_t *b) { return b->len; }\nint buf_append(buf_t *b, const void *p, size_t n) { return 0; }\n',
    // Several namespace blocks, a nested one, blocks on one line, and a type in the global namespace.
    'cs/Two.cs': 'namespace A {\n  public class X { public void Run() {} }\n}\nnamespace B {\n  public class Y { public void Go() {} }\n  namespace C { public class Z {} }\n}\n',
    'cs/OneLine.cs': 'namespace O { class OA {} } namespace O2 { class OB {} }\n',
    'cs/Global.cs': 'namespace A {\n  class X2 {}\n}\nnamespace B {\n  class Y2 {}\n}\nclass G { void M() {} }\n',
    'cs/FileScoped.cs': 'namespace FS;\npublic class F1 { public void M() {} }\n',
    // Nested Scala package blocks, and chained package clauses.
    'scala/N.scala': 'package a {\n  package b {\n    class X\n  }\n  class Y\n}\n',
    'scala/Chained.scala': 'package com.acme\npackage domain\nclass Order\n',
    // One-line namespaces: the call's source symbol is the function, not the namespace or type.
    'cpp/line.cpp': 'namespace a::b { void f() {} void use() { f(); } }\nnamespace k { class K { void m() { f(); } }; }\n',
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-arch-qn2-'));
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    cli(root, 'scan');
    store = new Store(join(root, '.mapx/mapx.db'));
    view = buildElementView(store, root);
  }, 120_000);
  afterAll(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });

  const names = (prefix: string) => view.elements.filter((e) => e.kind === 'symbol' && e.file.path.startsWith(prefix)).map((e) => e.qualifiedName).sort();
  const calls = (file: string) => (store.raw.prepare("SELECT source_symbol, target_file, target_symbol FROM edges WHERE edge_type = 'call' AND source_file = ? ORDER BY source_symbol")
    .all(file) as Array<{ source_symbol: string; target_file: string; target_symbol: string }>).map((e) => `${e.source_symbol} -> ${e.target_file}#${e.target_symbol}`);

  it('a .h header with a C++ class in namespace acme gives acme::Order', () => {
    expect(view.files.get('inc/order.h')!.language).toBe('cpp');
    expect(names('inc/')).toEqual(['acme::Order']);
  });

  it('a guarded C header with C++ glue in conditionals stays C, with its symbols and call edges', () => {
    expect(view.files.get('c/buf.h')!.language).toBe('c');
    expect(names('c/buf.h')).toEqual(['c/buf.h#BUF_EMPTY', 'c/buf.h#BUF_H', 'c/buf.h#buf', 'c/buf.h#buf_len', 'c/buf.h#buf_push', 'c/buf.h#buf_t']);
    expect(calls('c/buf.h')).toEqual(['buf_len -> c/buf.c#buf_size', 'buf_push -> c/buf.c#buf_append']);
  });

  it('a C# symbol takes its own namespace block: A.X and B.Y, blocks on one line, the global namespace', () => {
    expect(names('cs/Two.cs')).toEqual(['A.X', 'A.X.Run', 'B.C.Z', 'B.Y', 'B.Y.Go']);
    expect(names('cs/OneLine.cs')).toEqual(['O.OA', 'O2.OB']);
    // A type outside every block is in the global namespace: the path form.
    expect(names('cs/Global.cs')).toEqual(['A.X2', 'B.Y2', 'cs/Global.cs#G', 'cs/Global.cs#G.M']);
    expect(names('cs/FileScoped.cs')).toEqual(['FS.F1', 'FS.F1.M']);
  });

  it('Scala package blocks nest, and chained package clauses join', () => {
    expect(names('scala/N.scala')).toEqual(['a.Y', 'a.b.X']);
    expect(names('scala/Chained.scala')).toEqual(['com.acme.domain.Order']);
  });

  it('a one-line namespace a::b { void use() { f(); } } gives the call edge from use', () => {
    expect(calls('cpp/line.cpp')).toEqual(['K::m -> cpp/line.cpp#f', 'use -> cpp/line.cpp#f']);
  });

  it('a header is C++ only for C++-only syntax outside every conditional (an include guard is not one)', () => {
    const guarded = (body: string) => `#ifndef H_\n#define H_\n${body}\n#endif\n`;
    for (const cpp of ['namespace a { int x; }', 'namespace a\n{', 'class EXPORT A : public B {', 'class A final {', 'class A\n{',
      'template <typename T> T id(T);', 'using namespace std;', 'extern "C++" {', 'public:']) {
      expect(isCppHeader(cpp), cpp).toBe(true);
      expect(isCppHeader(guarded(cpp)), `guarded ${cpp}`).toBe(true);
    }
    for (const c of [
      C_HEADER,
      // The review's cases: tests mixing __cplusplus with other macros, continued #if lines, #elif, #if 0.
      '#if defined(__cplusplus) && !defined(LIB_NO_CXX)\ntemplate <class T> T id(T);\n#endif\nint f(void);\n',
      '#if defined(__cplusplus) && !defined(CINTERFACE)\n    IFoo : public IUnknown\n    {\n    public:\n    };\n#else\ntypedef struct IFooVtbl { int x; } IFooVtbl;\n#endif\n',
      '#if defined(FOO) && \\\n    defined(__cplusplus)\ntemplate <class T> T id(T);\n#endif\nint f(void);\n',
      '#if 0\nclass Example {};\n#endif\nint f(void);\n',
      '#if defined(_MSC_VER)\nint a;\n#elif defined(__cplusplus)\nnamespace x {}\n#endif\n',
      '#ifndef __cplusplus\nint a;\n#else\nclass A {};\n#endif\n',
      // `namespace` and `class` as C identifiers, C++ words in comments and strings.
      'static inline void set(struct node *n, const char *namespace) {\n  n->ns =\n  namespace = 0;\n}\n',
      'int f(int class);\nint\nclass = 3;\n', 'class A;', '// class A {', '// a line comment continued \\\nclass A {','/* example:\nnamespace a {\n*/', 'const char *s = "\\nclass A {";',
      '#define MSG "hello \\\nclass X {"', 'struct point { int x; };', '#include <vector>', 'int x = 1; [[gnu::unused]] int y;',
      // Not a whole-file guard: its content is conditional.
      '#ifndef H_\n#define H_\nclass A {};\n#endif\nint after;',
    ]) {
      expect(isCppHeader(c), c).toBe(false);
    }
  });

  it('decides a header in time linear in its size', () => {
    const start = performance.now();
    for (const text of ['\n'.repeat(65_000) + 'int x;', ' '.repeat(65_000) + 'int x;', `class ${'a '.repeat(30_000)}\n`, '#if X\n'.repeat(20_000) + '#endif\n'.repeat(20_000)]) {
      expect(isCppHeader(text)).toBe(false);
    }
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
