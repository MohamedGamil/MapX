import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cli } from '../scripts/ui/workspace.js';
import { Store } from '../src/core/store.js';
import { loadArchitectureConfig } from '../src/arch/config.js';
import { computeMembership } from '../src/arch/membership.js';
import { buildElementView } from '../src/arch/elements.js';
import { decide, expandPolicy } from '../src/arch/policy.js';
import { buildReport, fingerprint, runArchitecture, type ArchReport } from '../src/arch/report.js';
import type { ArchitectureConfig, Layer } from '../src/arch/schema.js';

// M5-04: policy expansion (AR-05), the evaluation chain (AR-08), the report (AR-09, AR-12).
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');

describe('policy expansion (AR-05)', () => {
  const layers = (...names: string[]): Layer[] => names.map((name) => ({ name, selectors: [{ path: `${name}/**` }] }));
  const allowedOf = (config: Pick<ArchitectureConfig, 'layers' | 'rules'>, source: string) => [...(expandPolicy(config).allowed.get(source)?.keys() ?? [])].sort();

  it('"+" is transitive: A: +B, B: +C, C: D gives A the layers B, C and D', () => {
    const config = { layers: layers('A', 'B', 'C', 'D', 'E'), rules: { A: ['+B'], B: ['+C'], C: ['D'], D: [] } };
    expect(allowedOf(config, 'A')).toEqual(['B', 'C', 'D']);
    expect(allowedOf(config, 'B')).toEqual(['C', 'D']);
    expect(allowedOf(config, 'C')).toEqual(['D']);
    expect(expandPolicy(config).allowed.get('A')!.get('D')![0]!.via).toBe('+B');
  });

  it('"*" allows every non-overlay layer but the source', () => {
    const config = { layers: [...layers('A', 'B', 'C'), { name: 'Deprecated', overlay: true, selectors: [{ path: 'old/**' }] }], rules: { A: ['*'] } };
    expect(allowedOf(config, 'A')).toEqual(['B', 'C']);
  });

  it('"!" beats "*", "+" and explicit allows, and a "*" key gives every layer its defaults', () => {
    const config = { layers: layers('A', 'B', 'C', 'Legacy'), rules: { '*': ['Legacy', '!C'], A: ['*', '!B'], B: ['+A', 'C'] } };
    expect(allowedOf(config, 'A')).toEqual(['Legacy']); // * minus its own !B and the default !C
    expect(allowedOf(config, 'B')).toEqual(['A', 'Legacy']); // C is explicit but the default denies it
    expect(allowedOf(config, 'C')).toEqual(['Legacy']);
    expect(decide(expandPolicy(config), 'A', 'B', 'call')).toEqual({ allowed: false, advisory: false, denied: true });
  });

  it('explicit beats "+" beats "*": the strongest form decides the edge types', () => {
    const config = { layers: layers('A', 'B', 'C'), rules: { A: ['*', '+B', { to: 'C', types: ['import'] }], B: [{ to: 'C', types: ['call'] }] } } as any;
    const policy = expandPolicy(config);
    // A's own C allowance (import only) beats the call-only one inherited through +B, and A's "*".
    expect(decide(policy, 'A', 'C', 'import').allowed).toBe(true);
    expect(decide(policy, 'A', 'C', 'call').allowed).toBe(false);
  });

  it('a types-scoped allowance allows only those edge types; inherited ones keep the narrower scope', () => {
    const config = { layers: layers('View', 'Model', 'X'), rules: { View: [{ to: 'Model', types: ['param_type', 'return_type'] }], X: ['+View'] } } as any;
    const policy = expandPolicy(config);
    expect(decide(policy, 'View', 'Model', 'param_type').allowed).toBe(true);
    expect(decide(policy, 'View', 'Model', 'call').allowed).toBe(false);
    expect(decide(policy, 'X', 'Model', 'return_type').allowed).toBe(true);
    expect(decide(policy, 'X', 'Model', 'call').allowed).toBe(false);
  });

  it('severity "warn" makes a pair advisory: reported as a warning, never allowed', () => {
    const config = { layers: layers('A', 'B', 'C'), rules: { A: [{ allow: ['B'], severity: 'warn' }, 'C'] } } as any;
    const policy = expandPolicy(config);
    expect(decide(policy, 'A', 'B', 'call')).toEqual({ allowed: false, advisory: true, denied: false });
    expect(decide(policy, 'A', 'C', 'call').allowed).toBe(true);
  });

  it('"+" paths each bring their own scope and severity, whatever the rule order (review of M5-04)', () => {
    const forms = [[{ allow: ['+C'], types: ['import'] }, '+B'], ['+B', { allow: ['+C'], types: ['import'] }]];
    for (const A of forms) {
      const policy = expandPolicy({ layers: layers('A', 'B', 'C', 'E'), rules: { A, B: ['+C'], C: ['E'] } } as any);
      expect(decide(policy, 'A', 'E', 'call').allowed, JSON.stringify(A)).toBe(true); // through +B, unscoped
      expect(decide(policy, 'A', 'E', 'import').allowed, JSON.stringify(A)).toBe(true);
    }
    for (const A of [[{ allow: ['+C'], severity: 'warn' }, '+B'], ['+B', { allow: ['+C'], severity: 'warn' }]]) {
      const policy = expandPolicy({ layers: layers('A', 'B', 'C', 'E'), rules: { A, B: ['+C'], C: ['E'] } } as any);
      expect(decide(policy, 'A', 'E', 'call').allowed, JSON.stringify(A)).toBe(true); // a full path beats an advisory one
    }
  });

  it('reports what the loader already rejects (defence in depth)', () => {
    const config = { layers: [...layers('A'), { name: 'O', overlay: true, selectors: [{ path: 'o/**' }] }], rules: { A: ['Nope'], O: ['A'], Ghost: [] } };
    expect(expandPolicy(config).errors).toEqual([
      'rules: overlay layer "O" cannot be a source',
      'rules: unknown source layer "Ghost"',
      'rules: unknown target layer "Nope"',
    ]);
  });
});

// ─── On real scans ───────────────────────────────────────────────────────────────────────────

function scan(app: string, repos: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), `mapx-arch-eval-${app}-`));
  cpSync(join(FIXTURE, app), root, { recursive: true });
  cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
  for (const r of repos) { execFileSync('git', ['init', '-q', join(root, r)]); cli(root, 'workspaces', 'add', r); }
  cli(root, 'scan');
  return root;
}
const roots: Record<string, string> = {};
beforeAll(() => {
  roots['php'] = scan('php');
  roots['workspace'] = scan('workspace', ['frontend', 'backend']);
}, 300_000);
afterAll(() => { for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true }); });

/** The report of `app` with its configuration changed by `edit`. */
function reportWith(app: string, edit: (c: ArchitectureConfig) => ArchitectureConfig = (c) => c, repoPaths: Record<string, string> = {}): ArchReport {
  const root = roots[app]!;
  const store = new Store(join(root, '.mapx/mapx.db'));
  try {
    const config = edit(loadArchitectureConfig(root)!);
    return buildReport(store, config, computeMembership(buildElementView(store, root, repoPaths), config));
  } finally { store.close(); }
}
const key = (f: ArchReport['findings'][number]) => `${f.kind} ${f.rule ?? ''} ${f.source?.element ?? f.layer} -> ${f.target?.element ?? ''} ${f.edgeType ?? ''}`;

describe('the evaluation chain on the PHP app (AR-08)', () => {
  it('reports each dependency once per edge type at the class level, with the AR-08 rule', () => {
    const r = runArchitecture(roots['php']!)!;
    const shown = r.findings.filter((f) => f.kind !== 'allowed' && f.edgeType === 'instantiation').map(key);
    expect(shown).toEqual([
      'violation disallowed-layer App\\Controller\\OrderController -> App\\Domain\\Order instantiation',
      'violation disallowed-layer App\\Controller\\ReportController -> App\\Infrastructure\\SqlOrderRepository instantiation',
      'violation disallowed-layer App\\Domain\\Order -> App\\Infrastructure\\SqlOrderRepository instantiation',
      'violation disallowed-layer App\\Shared\\Result -> App\\Domain\\Money instantiation',
      'violation private-layer App\\Controller\\OrderController -> App\\Application\\Internal\\PricingRules instantiation',
      'violation private-layer App\\Controller\\ReportController -> App\\Application\\Internal\\TaxRules instantiation',
      'uncovered uncovered App\\Application\\PlaceOrder -> App\\Support\\Clock instantiation',
      'uncovered uncovered App\\Infrastructure\\MailGateway -> App\\Support\\Uuid instantiation',
    ]);
    // Same-layer dependencies (OrderController → BaseController) record nothing; Application → Domain
    // is allowed through "+Domain".
    expect(r.findings.some((f) => f.target?.element === 'App\\Controller\\BaseController')).toBe(false);
    expect(r.findings.find((f) => f.source?.element === 'App\\Application\\PlaceOrder' && f.target?.element === 'App\\Domain\\Order' && f.edgeType === 'instantiation')?.kind).toBe('allowed');
    expect(r.findings.filter((f) => f.kind === 'warning').map(key)).toEqual([
      'warning empty-layer Reporting ->  ',
      'warning multi-layer App\\Domain\\Ids\\OrderId ->  ',
    ]);
    // Order (Domain) → OrderId (Domain and Shared) is checked against Shared too (AR-08: same layer
    // only when every target layer is the source's), and Domain may use Shared.
    expect(r.findings.find((f) => f.source?.element === 'App\\Domain\\Order' && f.target?.element === 'App\\Domain\\Ids\\OrderId' && f.edgeType === 'instantiation')?.kind).toBe('allowed');
    expect(r.counts).toEqual({ violation: 12, skipped: 0, uncovered: 4, allowed: 20, warning: 2, error: 0 });
    // Unique fingerprints within a report.
    expect(new Set(r.findings.map((f) => f.fingerprint)).size).toBe(r.findings.length);
  });

  it('layerEdges counts allowed and violating dependencies per layer pair', () => {
    const r = runArchitecture(roots['php']!)!;
    const pair = (from: string, to: string) => r.layerEdges.find((e) => e.from === from && e.to === to);
    // Controller → Application: PlaceOrder and CancelOrder allowed, PricingRules and TaxRules private (import + instantiation each).
    expect(pair('Controller', 'Application')).toEqual({ from: 'Controller', to: 'Application', allowed: 4, violations: 4, skipped: 0 });
    expect(pair('Controller', 'Domain')).toEqual({ from: 'Controller', to: 'Domain', allowed: 0, violations: 2, skipped: 0 });
    expect(pair('Domain', 'Shared')).toMatchObject({ allowed: 4, violations: 0 }); // Money → Text, Order → OrderId
    expect(r.layerEdges.map((e) => `${e.from}>${e.to}`)).toEqual(r.layerEdges.map((e) => `${e.from}>${e.to}`).sort());
    expect(pair('Controller', 'Controller')).toBeUndefined();
  });

  it('a source in two layers is evaluated once per layer (AR-12)', () => {
    const r = reportWith('php', (c) => ({
      ...c,
      layers: [...c.layers, { name: 'Legacy', selectors: [{ path: 'app/Controller/OrderController.php' }] }],
      rules: { ...c.rules, Legacy: [] },
    }));
    const placeOrder = r.findings.filter((f) => f.source?.element === 'App\\Controller\\OrderController' && f.target?.element === 'App\\Application\\PlaceOrder' && f.edgeType === 'instantiation');
    expect(placeOrder.map((f) => [f.source!.layer, f.kind])).toEqual([['Legacy', 'violation'], ['Controller', 'allowed']].sort((a, b) => (a[1]! < b[1]! ? 1 : -1)));
    expect(r.findings.find((f) => f.rule === 'multi-layer' && f.source?.element === 'App\\Controller\\OrderController')?.source?.layer).toBe('Controller, Legacy');
    // Disallowed from both layers (Controller → Domain, Legacy → anything): one finding naming both,
    // so fingerprints stay unique within the report (review of M5-04).
    const toOrder = r.findings.filter((f) => f.source?.element === 'App\\Controller\\OrderController' && f.target?.element === 'App\\Domain\\Order' && f.edgeType === 'instantiation');
    expect(toOrder.map((f) => [f.kind, f.source!.layer])).toEqual([['violation', 'Controller, Legacy']]);
    expect(new Set(r.findings.map((f) => f.fingerprint)).size).toBe(r.findings.length);
    // strictLayers turns the warning into an error.
    const strict = reportWith('php', (c) => ({ ...c, policy: { ...c.policy, strictLayers: true } }));
    expect(strict.findings.find((f) => f.rule === 'multi-layer')!.kind).toBe('error');
  });

  it('fingerprints hash rule, both elements and the edge type: no line number', () => {
    expect(fingerprint('disallowed-layer', 'A', 'B', 'call')).toBe(fingerprint('disallowed-layer', 'A', 'B', 'call'));
    expect(fingerprint('disallowed-layer', 'A', 'B', 'call')).not.toBe(fingerprint('disallowed-layer', 'A', 'B', 'import'));
    expect(fingerprint('disallowed-layer', 'A', 'B', 'call')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the report is deterministic: two runs give identical JSON', () => {
    expect(JSON.stringify(runArchitecture(roots['php']!))).toBe(JSON.stringify(runArchitecture(roots['php']!)));
  });

  it('a + cycle is a plus-cycle error finding naming its first layer', () => {
    const r = runArchitecture(join(FIXTURE, 'php-broken-cycle'))!;
    expect(r.findings.map((f) => [f.kind, f.rule, f.layer])).toEqual([['error', 'plus-cycle', 'Application']]);
    expect(r.counts.error).toBe(1);
  });
});

describe('verifiability policy (AR-05): the two-repo app\'s http edges are inferred', () => {
  const repoPaths = { frontend: 'frontend', backend: 'backend' };
  const http = (r: ArchReport) => r.findings.filter((f) => f.edgeType === 'http').map((f) => [f.kind, f.severity, f.source!.element, f.target!.element]);

  it('warn by default; error under policy.inferred "error"; ignored under "ignore"', () => {
    const violation = ['violation', 'warn', 'frontend/src/admin.ts#listUsers', 'App\\Http\\Controllers\\Admin\\UserController::index'];
    const allowed = ['allowed', 'info', 'frontend/src/orders.ts#listOrders', 'App\\Http\\Controllers\\Api\\OrderController::index'];
    expect(http(reportWith('workspace', (c) => c, repoPaths))).toEqual([violation, allowed]);
    expect(http(reportWith('workspace', (c) => ({ ...c, policy: { ...c.policy, inferred: 'error' } }), repoPaths))).toEqual([[...violation.slice(0, 1), 'error', ...violation.slice(2)], allowed]);
    expect(http(reportWith('workspace', (c) => ({ ...c, policy: { ...c.policy, inferred: 'ignore' } }), repoPaths))).toEqual([]);
  });

  it('an edge type outside scope.types is not evaluated', () => {
    const r = reportWith('workspace', (c) => ({ ...c, scope: { ...c.scope, types: c.scope.types.filter((t) => t !== 'http') } }), repoPaths);
    expect(r.findings.some((f) => f.edgeType === 'http')).toBe(false);
    expect(r.findings.some((f) => f.edgeType === 'import')).toBe(true);
  });
});

describe('fingerprints survive line shifts (AR-09)', () => {
  it('inserting blank lines at the top of every PHP file and syncing leaves every fingerprint unchanged', () => {
    const root = roots['php']!;
    const before = runArchitecture(root)!.findings.map((f) => f.fingerprint).sort();
    const lineBefore = runArchitecture(root)!.findings.find((f) => f.source?.line !== undefined)?.source?.line;
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.php') ? [p] : [];
    });
    for (const file of walk(join(root, 'app'))) writeFileSync(file, readFileSync(file, 'utf8').replace(/^<\?php\n/, '<?php\n\n\n\n\n'));
    cli(root, 'sync');
    const after = runArchitecture(root)!;
    expect(after.findings.map((f) => f.fingerprint).sort()).toEqual(before);
    expect(before.length).toBeGreaterThan(20);
    expect(lineBefore).toBeGreaterThan(0); // the lines did move: each finding's line is 4 later
    expect(after.findings.find((f) => f.source?.line !== undefined)?.source?.line).toBe(lineBefore! + 4);
  }, 120_000);
});

describe('review of M5-04: overlays, several target layers, Go packages, homonyms, unscanned workspaces', () => {
  let root = '';
  const files: Record<string, string> = {
    'go.mod': 'module example.com/shop\n',
    // A Go type with methods in two files, and a file declaring two top-level symbols.
    'app/service.go': 'package app\n\nimport "example.com/shop/infra"\n\ntype Service struct{}\n\nfunc NewService() Service { return Service{} }\n\nfunc (s Service) Run() { _ = infra.Repo{} }\n',
    'app/other.go': 'package app\n\nimport "example.com/shop/infra"\n\nfunc (s Service) Other() { _ = infra.Repo{} }\n',
    // A package used only through a constant, which makes no edge: its import stands.
    'app/calls.go': 'package app\n\nimport "example.com/shop/infra"\n\nfunc Calls() string { return infra.Version }\n',
    'infra/repo.go': 'package infra\n\ntype Repo struct{}\n\nconst Version = "1"\n',
    // TypeScript: an overlay target, a target in two layers, a homonym method/function.
    'package.json': '{"name":"review","version":"1.0.0"}\n',
    'ts/ui/View.ts': "import { Old } from '../domain/Old';\nimport { Both } from '../domain/Both';\nexport class View { show() { return new Old(); } }\n",
    'ts/domain/Old.ts': 'export class Old {}\n',
    'ts/domain/Service.ts': "import { Both } from './Both';\nexport class Service { run() { return new Both(); } }\n",
    'ts/domain/Both.ts': 'export class Both {}\n',
    'ts/ui/Caller.ts': "import { Repo } from '../infra/Repo';\nexport class Caller { go(r: Repo) { r.save(); } }\n",
    'ts/infra/Repo.ts': 'export class Repo { save() { return 1; } }\nexport function save() { return 2; }\n',
  };
  const config = {
    layers: [
      { name: 'App', selectors: [{ path: 'app/**' }] },
      { name: 'Infra', selectors: [{ path: 'infra/**' }, { path: 'ts/infra/**' }, { path: 'ts/domain/Both.ts' }] },
      { name: 'UI', selectors: [{ path: 'ts/ui/**' }] },
      { name: 'Domain', selectors: [{ path: 'ts/domain/**' }] },
      { name: 'Deprecated', overlay: true, selectors: [{ path: 'ts/domain/Old.ts' }] },
    ],
    rules: { '*': ['!Deprecated'], App: [], UI: ['Domain', 'Infra'], Domain: [], Infra: [] },
  };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-arch-review-'));
    for (const [p, c] of Object.entries({ ...files, '.mapx/architecture.jsonc': JSON.stringify(config) })) {
      execFileSync('mkdir', ['-p', join(root, p, '..')]);
      writeFileSync(join(root, p), c);
    }
    cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify(config));
    cli(root, 'scan');
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const find = (r: ArchReport, s: string, t: string, type: string) => r.findings.filter((f) => f.source?.element === s && f.target?.element === t && f.edgeType === type);

  it('a denied overlay makes a dependency a violation, even an otherwise allowed one', () => {
    const r = runArchitecture(root)!;
    expect(find(r, 'ts/ui/View.ts#View', 'ts/domain/Old.ts#Old', 'instantiation').map((f) => [f.kind, f.rule])).toEqual([['violation', 'disallowed-layer']]);
    expect(find(r, 'ts/ui/View.ts#View', 'ts/domain/Old.ts#Old', 'instantiation')[0]!.message).toMatch(/on Deprecated\)$/);
  });

  it('a target in the source layer and another layer is checked against the other one', () => {
    const r = runArchitecture(root)!;
    // Service (Domain) → Both (Domain and Infra): Domain may not use Infra.
    expect(find(r, 'ts/domain/Service.ts#Service', 'ts/domain/Both.ts#Both', 'instantiation').map((f) => [f.kind, f.rule])).toEqual([['violation', 'disallowed-layer']]);
  });

  it('Go: methods in another file report on their type; a package import is subsumed by file, and counted once', () => {
    const r = runArchitecture(root)!;
    const app = r.findings.filter((f) => f.source?.file.startsWith('app/') && f.kind === 'violation').map((f) => `${f.source!.element} -> ${f.target!.element} ${f.edgeType}`).sort();
    expect(app).toEqual([
      'example.com/shop/app.Calls -> example.com/shop/infra import',
      'example.com/shop/app.Service -> example.com/shop/infra.Repo instantiation',
    ]);
    // layerEdges count the findings that remain: Service → Repo, and Calls' package import.
    expect(r.layerEdges.find((e) => e.from === 'App' && e.to === 'Infra')).toMatchObject({ violations: 2 });
  });

  it('a call to a name shared by a method and a function in one file resolves to the file, not to the function', () => {
    const r = runArchitecture(root)!;
    const calls = r.findings.filter((f) => f.source?.element === 'ts/ui/Caller.ts#Caller' && f.edgeType === 'call');
    expect(calls.every((f) => f.target!.element !== 'ts/infra/Repo.ts#save')).toBe(true);
  });

  it('a workspace with a configuration but no index is an error, not a clean report', () => {
    const bare = mkdtempSync(join(tmpdir(), 'mapx-arch-noscan-'));
    try {
      execFileSync('mkdir', ['-p', join(bare, '.mapx')]);
      writeFileSync(join(bare, '.mapx/architecture.jsonc'), JSON.stringify({ layers: [{ name: 'A', selectors: [{ path: 'a/**' }] }], rules: {} }));
      expect(() => runArchitecture(bare)).toThrow(/run `mapx scan` first/);
    } finally { rmSync(bare, { recursive: true, force: true }); }
  });

  it('an unsupported selector is reported as a warning', () => {
    const r = reportWith('php', (c) => ({ ...c, layers: [...c.layers, { name: 'Old', overlay: true, selectors: [{ docTag: '@deprecated' }] }] }));
    expect(r.findings.filter((f) => f.rule === 'unsupported-selector').map((f) => [f.kind, f.layer])).toEqual([['warning', 'Old']]);
  });
});
