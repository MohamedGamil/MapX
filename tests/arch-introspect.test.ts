import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { init, mapx, mapxResult, query } from './helpers/e2e.js';
import { Store } from '../src/core/store.js';
import { changedLayers, isAllowed, openArchitecture } from '../src/arch/introspect.js';
import { runArchitecture } from '../src/arch/report.js';
import { exitCode as checkExit } from '../src/arch/check.js';

// M5-08: `mapx arch` introspection (AR-13a–g) on the TypeScript app of the M5-01 fixture, scanned
// with the source CLI. Every subcommand's JSON is asserted whole: identities, not counts.
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules/ts');
const LEGACY = resolve(__dirname, 'fixtures/arch-introspect/legacy');
// Each test runs the CLI a few times, a few seconds each on a loaded machine.
const CLI = { timeout: 180_000 };
let root = '';

const json = (...args: string[]) => {
  const r = mapxResult(root, 'arch', ...args, '--format', 'json');
  return { status: r.status, body: JSON.parse(r.stdout), stderr: r.stderr };
};
const file = (path: string) => ({ element: path, kind: 'file', file: path });
const cls = (path: string, name: string) => ({ element: `${path}#${name}`, kind: 'symbol', symbolKind: 'class', file: path });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mapx-arch-introspect-'));
  cpSync(FIXTURE, root, { recursive: true });
  // A view whose rules give the `unused` and `allowed` cases: an allowance used once (Application
  // on Shared over imports only), an advisory one used twice (Controller on Domain).
  const doc = JSON.parse(readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8').replace(/^\/\/.*\n/, ''));
  delete doc.$schema;
  doc.rules = {
    Controller: ['Application', { allow: ['Domain'], severity: 'warn' }],
    Application: ['Domain', { to: 'Shared', types: ['import'] }],
    Domain: ['Shared'],
    Infrastructure: ['Domain', 'Shared'],
    Shared: [],
  };
  mkdirSync(join(root, '.mapx/architecture'), { recursive: true });
  writeFileSync(join(root, '.mapx/architecture/introspect.jsonc'), JSON.stringify(doc, null, 2));
  init(root);
  mapx(root, 'scan');
}, 300_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('mapx arch layers (AR-13a)', CLI, () => {
  it('lists every layer with its size', () => {
    expect(json('layers')).toEqual({ status: 0, stderr: '', body: { layers: [
      { name: 'Controller', overlay: false, elements: 9, files: 3 },
      { name: 'Application', overlay: false, elements: 12, files: 4 },
      { name: 'Domain', overlay: false, elements: 15, files: 5 },
      { name: 'Shared', overlay: false, elements: 9, files: 3 },
      { name: 'Infrastructure', overlay: false, elements: 11, files: 3 }, // HttpGateway.ts came with M5-19
      { name: 'Reporting', overlay: false, elements: 0, files: 0 },
    ] } });
  });

  it('lists a layer\'s files and top-level symbols, --why naming the selector that matched', () => {
    const why = (selector: string) => ({ selector, via: 'self' });
    expect(json('layers', 'Shared', '--why').body).toEqual({
      name: 'Shared', overlay: false, elements: 9, files: 3, total: 6, members: [
        { ...file('src/domain/ids/OrderId.ts'), ...why('selectors[1].path') },
        { ...cls('src/domain/ids/OrderId.ts', 'OrderId'), ...why('selectors[1].path') },
        { ...file('src/shared/Result.ts'), ...why('selectors[0].path') },
        { ...cls('src/shared/Result.ts', 'Result'), ...why('selectors[0].path') },
        { ...file('src/shared/Text.ts'), ...why('selectors[0].path') },
        { ...cls('src/shared/Text.ts', 'Text'), ...why('selectors[0].path') },
      ],
    });
    // Without --why, no trace; --nested adds the methods.
    expect(json('layers', 'Shared').body.members[0]).toEqual(file('src/domain/ids/OrderId.ts'));
    expect(json('layers', 'Shared', '--nested').body.members.map((m: { element: string }) => m.element)).toContain('src/shared/Text.ts#Text.run');
    expect(json('layers', 'Reporting').body).toEqual({ name: 'Reporting', overlay: false, elements: 0, files: 0, total: 0, members: [] });
  });

  it('an unknown layer is a usage error (exit 3) naming the layers', () => {
    const r = json('layers', 'Nope');
    expect(r.status).toBe(3);
    expect(r.body).toEqual({
      error: '"Nope" is not a layer of this configuration (Controller, Application, Domain, Shared, Infrastructure, Reporting)',
      candidates: ['Controller', 'Application', 'Domain', 'Shared', 'Infrastructure', 'Reporting'],
    });
  });
});

describe('mapx arch which (AR-13b)', CLI, () => {
  it('names every layer of an element and the selector of each, by symbol name or file path', () => {
    expect(json('which', 'OrderId')).toEqual({ status: 0, stderr: '', body: {
      query: 'OrderId',
      matches: [{
        ...cls('src/domain/ids/OrderId.ts', 'OrderId'), layers: ['Domain', 'Shared'], private: [],
        trace: [{ layer: 'Domain', selector: 'selectors[0].all', via: 'self' }, { layer: 'Shared', selector: 'selectors[1].path', via: 'self' }], inScope: true,
      }],
    } });
    expect(json('which', 'src/application/internal/PricingRules.ts').body).toEqual({
      query: 'src/application/internal/PricingRules.ts',
      matches: [{ ...file('src/application/internal/PricingRules.ts'), layers: ['Application'], private: ['Application'], trace: [{ layer: 'Application', selector: 'selectors[0].path', via: 'self' }], inScope: true }],
    });
    expect(json('which', 'Clock').body.matches[0]).toEqual({ ...cls('src/support/Clock.ts', 'Clock'), layers: [], private: [], trace: [], inScope: true });
  });

  it('an element no query resolves is exit 3', () => {
    const r = json('which', 'NoSuchThing');
    expect(r.status).toBe(3);
    expect(r.body).toEqual({ error: '"NoSuchThing" is not an indexed file or symbol' });
  });
});

describe('mapx arch unassigned (AR-13c)', CLI, () => {
  it('lists the files and top-level symbols in no layer and exits 2; files nothing can depend on are not listed', () => {
    // tsconfig.json and package.json declare no symbol and no evaluated edge reaches them.
    expect(json('unassigned')).toEqual({ status: 2, stderr: '', body: { total: 4, elements: [
      file('src/support/Clock.ts'), cls('src/support/Clock.ts', 'Clock'),
      file('src/support/Uuid.ts'), cls('src/support/Uuid.ts', 'Uuid'),
    ] } });
  });

  it('an unknown --kind, or a --path that matches no indexed file, is a usage error (exit 3), not a pass', () => {
    expect(json('unassigned', '--kind', 'classes')).toMatchObject({ status: 3, body: { error: expect.stringContaining('--kind "classes"') } });
    expect(json('unassigned', '--path', 'src/nosuch')).toMatchObject({ status: 3, body: { error: '--path "src/nosuch" matches no indexed file' } });
  });

  it('a workspace `mapx init` set up (AGENTS.md and the rest) is not unassigned for those files', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mapx-arch-introspect-init-'));
    try {
      writeFileSync(join(fresh, 'package.json'), '{"name":"fresh"}\n');
      mkdirSync(join(fresh, 'src/app'), { recursive: true });
      writeFileSync(join(fresh, 'src/app/a.ts'), 'export class A {}\n');
      mkdirSync(join(fresh, '.mapx'), { recursive: true });
      writeFileSync(join(fresh, '.mapx/architecture.jsonc'), JSON.stringify({ layers: [{ name: 'App', selectors: [{ path: 'src/app/**' }] }], rules: { App: [] } }));
      // A real init: agent files included.
      mapx(fresh, 'init', fresh, '--no-suggestions', '--no-mcp-configs', '--no-discover');
      mapx(fresh, 'scan');
      expect(query<{ path: string }>(fresh, "SELECT path FROM files WHERE path = 'AGENTS.md'")).toEqual([{ path: 'AGENTS.md' }]);
      const r = mapxResult(fresh, 'arch', 'unassigned', '--json');
      expect([r.status, JSON.parse(r.stdout)]).toEqual([0, { total: 0, elements: [] }]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('--kind and --path filter; nothing left is exit 0', () => {
    expect(json('unassigned', '--kind', 'class').body).toEqual({ total: 2, elements: [cls('src/support/Clock.ts', 'Clock'), cls('src/support/Uuid.ts', 'Uuid')] });
    expect(json('unassigned', '--path', 'src/support/Uuid.ts').body).toEqual({ total: 2, elements: [file('src/support/Uuid.ts'), cls('src/support/Uuid.ts', 'Uuid')] });
    expect(json('unassigned', '--path', 'src/**/C*.ts', '--kind', 'file').body).toEqual({ total: 1, elements: [file('src/support/Clock.ts')] });
    expect(json('unassigned', '--path', 'src/domain')).toEqual({ status: 0, stderr: '', body: { total: 0, elements: [] } });
    expect(mapxResult(root, 'arch', 'unassigned', '--path', 'src/domain').stdout).toBe('Every element is in a layer.\n');
  });
});

describe('mapx arch deps (AR-13d)', CLI, () => {
  it('lists the concrete edges from one layer to another with file:line, type, verifiability and decision', () => {
    const violation = { targetLayers: ['Infrastructure'], verifiability: 'verified', kind: 'violation', rule: 'disallowed-layer', severity: 'error', violatedLayers: ['Infrastructure'] };
    expect(json('deps', 'Domain', 'Infrastructure')).toEqual({ status: 0, stderr: '', body: {
      from: 'Domain', to: 'Infrastructure', counts: { allowed: 0, violation: 2, uncovered: 0 },
      dependencies: [
        { source: { ...file('src/domain/Order.ts'), line: 1 }, target: file('src/infrastructure/SqlOrderRepository.ts'), edgeType: 'import', ...violation },
        { source: { element: 'src/domain/Order.ts#Order.run', kind: 'symbol', symbolKind: 'method', file: 'src/domain/Order.ts', line: 8 }, target: cls('src/infrastructure/SqlOrderRepository.ts', 'SqlOrderRepository'), edgeType: 'instantiation', ...violation },
      ],
    } });
  });

  it('without a target layer: every decided edge of the layer, uncovered ones included', () => {
    const r = json('deps', 'Infrastructure').body;
    expect(r.counts).toEqual({ allowed: 4, violation: 0, uncovered: 2 });
    expect(r.dependencies.filter((d: { kind: string }) => d.kind === 'uncovered')).toEqual([
      { source: { ...file('src/infrastructure/MailGateway.ts'), line: 2 }, target: file('src/support/Uuid.ts'), targetLayers: [], edgeType: 'import', verifiability: 'verified', kind: 'uncovered', rule: 'uncovered', severity: 'warn' },
      { source: { element: 'src/infrastructure/MailGateway.ts#MailGateway.run', kind: 'symbol', symbolKind: 'method', file: 'src/infrastructure/MailGateway.ts', line: 7 }, target: cls('src/support/Uuid.ts', 'Uuid'), targetLayers: [], edgeType: 'instantiation', verifiability: 'verified', kind: 'uncovered', rule: 'uncovered', severity: 'warn' },
    ]);
    expect(json('deps', 'Domain', 'Nope').status).toBe(3);
  });

  it('`deps L L` lists nothing: Order → OrderId (Domain and Shared) is a Domain → Shared edge', () => {
    expect(json('deps', 'Domain', 'Domain').body).toEqual({ from: 'Domain', to: 'Domain', counts: { allowed: 0, violation: 0, uncovered: 0 }, dependencies: [] });
    expect(json('deps', 'Domain', 'Shared').body.dependencies.map((d: { target: { element: string } }) => d.target.element)).toEqual(['src/shared/Text.ts', 'src/shared/Text.ts#Text', 'src/domain/ids/OrderId.ts', 'src/domain/ids/OrderId.ts#OrderId']);
  });
});

describe('mapx arch unused (AR-13e)', CLI, () => {
  it('lists the dead allowances by default', () => {
    expect(json('unused')).toEqual({ status: 0, stderr: '', body: { limit: 0, total: 6, allowances: [
      { from: 'Infrastructure', to: 'Shared', rule: 'explicit', types: null, severity: 'error', uses: 0 },
    ] } });
  });

  it('--limit 1 lists the allowances used at most once, with counts', () => {
    expect(json('unused', '--view', 'introspect', '--limit', '1').body).toEqual({ limit: 1, total: 7, allowances: [
      { from: 'Application', to: 'Shared', rule: 'explicit', types: ['import'], severity: 'error', uses: 1 },
      { from: 'Infrastructure', to: 'Shared', rule: 'explicit', types: null, severity: 'error', uses: 0 },
    ] });
    // An advisory allowance is used by the warnings it reports: twice here.
    expect(json('unused', '--view', 'introspect', '--limit', '2').body.allowances[0]).toEqual({ from: 'Controller', to: 'Domain', rule: 'explicit', types: null, severity: 'warn', uses: 2 });
    expect(mapxResult(root, 'arch', 'unused', '--limit', 'x').status).toBe(3);
  });
});

describe('mapx arch changed (AR-13f)', CLI, () => {
  it('names the layers of the files, and with --with-dependents the layers of the files that depend on them', () => {
    expect(json('changed', 'src/domain/Money.ts', './src/support/Clock.ts', 'src/new.ts', '--with-dependents')).toEqual({ status: 0, stderr: '', body: {
      files: [
        { file: 'src/domain/Money.ts', indexed: true, inScope: true, layers: ['Domain'] },
        { file: 'src/new.ts', indexed: false, inScope: true, layers: [] },
        { file: 'src/support/Clock.ts', indexed: true, inScope: true, layers: [] },
      ],
      layers: ['Domain'],
      // PlaceOrder uses Clock, Order and Result use Money; layers in configuration order.
      dependents: [{ layer: 'Application', files: ['src/application/PlaceOrder.ts'] }, { layer: 'Domain', files: ['src/domain/Order.ts'] }, { layer: 'Shared', files: ['src/shared/Result.ts'] }],
      unassignedDependents: [],
    } });
    expect(json('changed', 'src/support/Clock.ts', '--with-dependents').body).toEqual({
      files: [{ file: 'src/support/Clock.ts', indexed: true, inScope: true, layers: [] }], layers: [], dependents: [{ layer: 'Application', files: ['src/application/PlaceOrder.ts'] }], unassignedDependents: [],
    });
    expect(json('changed').status).toBe(3); // neither files nor --since
  });
});

describe('mapx arch allowed (AR-13g)', CLI, () => {
  const TYPES = ['import', 'require', 'extends', 'implements', 'call', 'instantiation', 'param_type', 'return_type'];
  const layer = (name: string) => ({ query: name, kind: 'layer', layers: [name], overlays: [], private: [], inScope: true });
  const hypothetical = (sourceLayer: string, f: (type: string) => Record<string, unknown>) =>
    TYPES.map((edgeType) => ({ edgeType, observed: false, verifiability: 'verified', sourceLayer, ...f(edgeType) }));

  it('a disallowed pair: one decision per edge type, exit 1, the layers the source may depend on', () => {
    const refused = (t: string) => ({ allowed: false, rule: 'disallowed-layer', severity: 'error', violatedLayers: ['Domain'], reason: `Controller may not depend on Domain over ${t}: no rule allows it` });
    expect(json('allowed', 'Controller', 'Domain')).toEqual({ status: 1, stderr: '', body: {
      from: layer('Controller'), to: layer('Domain'), edgeType: null, allowed: false, rule: 'disallowed-layer', severity: 'error',
      reason: 'Controller may not depend on Domain over import: no rule allows it', exitCode: 1,
      decisions: hypothetical('Controller', refused), allowedTypes: [], allowedLayers: ['Application'],
    } });
  });

  it('two elements the index connects: their stored edges, decided as mapx check decides them', () => {
    const reason = 'src/application/internal/PricingRules.ts#PricingRules is private to Application: only that layer may depend on it';
    const decision = (edgeType: string) => ({ edgeType, observed: true, verifiability: 'verified', sourceLayer: 'Controller', allowed: false, rule: 'private-layer', severity: 'error', violatedLayers: ['Application'], reason });
    expect(json('allowed', 'OrderController', 'PricingRules')).toEqual({ status: 1, stderr: '', body: {
      from: { query: 'OrderController', kind: 'symbol', element: 'src/controller/OrderController.ts#OrderController', file: 'src/controller/OrderController.ts', layers: ['Controller'], overlays: [], private: [], inScope: true },
      to: { query: 'PricingRules', kind: 'symbol', element: 'src/application/internal/PricingRules.ts#PricingRules', file: 'src/application/internal/PricingRules.ts', layers: ['Application'], overlays: [], private: ['Application'], inScope: true },
      edgeType: null, allowed: false, rule: 'private-layer', severity: 'error', reason, exitCode: 1,
      decisions: [decision('import'), decision('instantiation')], allowedTypes: [], allowedLayers: ['Application'],
    } });
  });

  it('an allowed pair names how the policy grants it; a types-scoped grant fails the other types; advisory is warn, exit 0', () => {
    const allowed = json('allowed', 'PlaceOrder', 'src/domain/Order.ts');
    expect(allowed.status).toBe(0);
    expect(allowed.body).toMatchObject({ allowed: true, rule: 'allowed', severity: 'info', exitCode: 0, allowedTypes: ['import', 'instantiation'] });
    expect(json('allowed', 'Application', 'src/domain/Order.ts').body).toMatchObject({ allowed: true, allowedTypes: TYPES }); // a layer: hypothetical, every type
    expect(allowed.body.decisions[0]).toEqual({ edgeType: 'import', observed: true, verifiability: 'verified', sourceLayer: 'Application', allowed: true, rule: 'allowed', severity: 'info', via: ['+Domain'], reason: 'Application may depend on Domain over import (+Domain)' });
    // Imports only: the import decision is allowed, every other type is an error.
    const scoped = json('allowed', 'Application', 'Shared', '--view', 'introspect');
    expect(scoped).toMatchObject({ status: 1, body: { allowed: false, rule: 'disallowed-layer', severity: 'error', allowedTypes: ['import'] } });
    expect(scoped.body.decisions[1]).toMatchObject({ edgeType: 'require', reason: 'Application may not depend on Shared over require: the allowance of Shared does not cover require edges' });
    expect(json('allowed', 'Application', 'Shared', '--view', 'introspect', '--type', 'import')).toMatchObject({ status: 0, body: { allowed: true, edgeType: 'import' } });
    const advisory = json('allowed', 'Controller', 'Domain', '--view', 'introspect');
    expect(advisory).toMatchObject({ status: 0, body: { allowed: false, rule: 'disallowed-layer', severity: 'warn', exitCode: 0, reason: 'Controller on Domain over import is advisory (severity warn): `mapx check` reports it as a warning' } });
  });

  it('same layer, uncovered target, unassigned source, an edge type out of scope', () => {
    expect(json('allowed', 'Order', 'Money').body).toMatchObject({ allowed: true, rule: 'same-layer', reason: 'both are in Domain: dependencies within a layer are always allowed' });
    expect(json('allowed', 'Application', 'Clock')).toMatchObject({ status: 0, body: { allowed: true, rule: 'uncovered', severity: 'warn' } });
    const unassigned = json('allowed', 'Clock', 'Domain').body;
    expect(unassigned).toMatchObject({ allowed: true, rule: 'unassigned-source', allowedLayers: [] });
    expect(unassigned.decisions).toEqual([{ edgeType: null, observed: false, verifiability: null, sourceLayer: null, allowed: true, rule: 'unassigned-source', severity: 'info', reason: 'src/support/Clock.ts#Clock is in no layer, so no rule applies to it' }]);
    expect(json('allowed', 'Controller', 'Domain', '--type', 'render').body).toMatchObject({ allowed: true, rule: 'out-of-scope', decisions: [{ edgeType: 'render', sourceLayer: null }] });
  });

  it('an unknown or ambiguous end, or an unknown edge type, is exit 3', () => {
    expect(json('allowed', 'Nope', 'Domain').status).toBe(3);
    const ambiguous = json('allowed', 'Controller', 'run');
    expect(ambiguous.status).toBe(3);
    expect(ambiguous.body.candidates).toContain('src/domain/Order.ts#Order.run');
    expect(json('allowed', 'Controller', 'Domain', '--type', 'nope').status).toBe(3);
  });
});

// The integration owner's principle (review of M5-08): `allowed` answers exactly what `mapx check`
// reports for the same pair, in severity and exit code. Checked over every pair the check reports,
// with and without an edge type, on a variant with a multi-layer source, an advisory and a
// types-scoped advisory allowance, an overlay denied by "*" and an excluded path; and on the
// two-repo workspace, whose HTTP edges are inferred.
describe('allowed agrees with mapx check (property, in process)', CLI, () => {
  const roots: string[] = [];
  let variant = '';
  let ws = '';
  beforeAll(() => {
    variant = mkdtempSync(join(tmpdir(), 'mapx-arch-introspect-variant-'));
    cpSync(FIXTURE, variant, { recursive: true });
    // OrderId is in Domain and Shared; it now uses SqlOrderRepository.
    writeFileSync(join(variant, 'src/domain/ids/OrderId.ts'), "import { SqlOrderRepository } from '../../infrastructure/SqlOrderRepository';\nexport class OrderId {\n  run(): void {\n    new SqlOrderRepository();\n  }\n}\n");
    const doc = JSON.parse(readFileSync(join(variant, '.mapx/architecture.jsonc'), 'utf8').replace(/^\/\/.*\n/, ''));
    delete doc.$schema;
    doc.scope = { exclude: ['src/infrastructure/MailGateway.ts'] };
    doc.layers.push({ name: 'Legacy', overlay: true, selectors: [{ path: 'src/support/Clock.ts' }] });
    doc.rules = {
      '*': ['!Legacy'],
      Controller: ['Application', { to: 'Domain', types: ['import'], severity: 'warn' }],
      Application: ['+Domain'],
      Domain: ['Shared', { to: 'Infrastructure', severity: 'warn' }],
      Infrastructure: ['Domain', 'Shared'],
      Shared: [],
    };
    writeFileSync(join(variant, '.mapx/architecture.jsonc'), JSON.stringify(doc, null, 2));
    init(variant);
    mapx(variant, 'scan');
    ws = mkdtempSync(join(tmpdir(), 'mapx-arch-introspect-ws-'));
    cpSync(resolve(__dirname, 'fixtures/arch-rules/workspace'), ws, { recursive: true });
    init(ws);
    for (const repo of ['frontend', 'backend']) {
      execFileSync('git', ['init', '-q', join(ws, repo)]);
      mapx(ws, 'workspaces', 'add', repo);
    }
    mapx(ws, 'scan');
    roots.push(variant, ws);
  }, 300_000);
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

  const RANK = { error: 2, warn: 1, info: 0 } as const;
  function agree(dir: string) {
    const store = new Store(join(dir, '.mapx', 'mapx.db'));
    try {
      const repoPaths = Object.fromEntries((JSON.parse(readFileSync(join(dir, '.mapx', 'config.json'), 'utf8')).repos as Array<{ name: string; path: string }>).map((r) => [r.name, r.path]));
      const report = runArchitecture(dir, { store, repoPaths, baseline: false })!;
      const ctx = openArchitecture(dir, store, { repoPaths })!;
      const decided = report.findings.filter((f) => ['violation', 'allowed', 'uncovered'].includes(f.kind));
      const pairs = new Map<string, typeof decided>();
      for (const f of decided) {
        const key = JSON.stringify([f.source!.element, f.target!.element]);
        pairs.set(key, [...(pairs.get(key) ?? []), f]);
      }
      const worst = (fs: typeof decided) => fs.reduce((a, f) => (RANK[f.severity] > RANK[a] ? f.severity : a), 'info' as keyof typeof RANK);
      const checked: string[] = [];
      for (const [key, fs] of pairs) {
        const [s, t] = JSON.parse(key) as [string, string];
        const expected = (sel: typeof decided) => ({ severity: worst(sel), exitCode: checkExit({ ...report, findings: sel }, {}), allowed: !sel.some((f) => f.kind === 'violation') });
        const a = isAllowed(ctx, s, t);
        expect({ severity: a.severity, exitCode: a.exitCode, allowed: a.allowed }, `${s} → ${t}`).toEqual(expected(fs));
        for (const type of new Set(fs.map((f) => f.edgeType!))) {
          const b = isAllowed(ctx, s, t, { edgeType: type });
          expect({ severity: b.severity, exitCode: b.exitCode, allowed: b.allowed }, `${s} → ${t} over ${type}`).toEqual(expected(fs.filter((f) => f.edgeType === type)));
        }
        checked.push(`${s} → ${t}`);
      }
      return { checked, ctx, report };
    } finally {
      store.close();
    }
  }

  it('on the variant: multi-layer source, advisory, types-scoped advisory, a denied overlay, an excluded path', () => {
    const { checked } = agree(variant);
    expect(checked).toEqual(expect.arrayContaining([
      'src/domain/ids/OrderId.ts#OrderId → src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository', // Domain warn, Shared error
      'src/domain/Order.ts#Order → src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository', // advisory
      'src/controller/OrderController.ts#OrderController → src/domain/Order.ts#Order', // advisory on import, error on instantiation
      'src/application/PlaceOrder.ts#PlaceOrder → src/support/Clock.ts#Clock', // the denied overlay
    ]));
    // The two P1 repros of the review, through the CLI.
    expect(mapxResult(variant, 'arch', 'allowed', 'OrderId', 'SqlOrderRepository', '--json').status).toBe(1);
    expect(mapxResult(variant, 'check').status).toBe(1);
    const controller = JSON.parse(mapxResult(variant, 'arch', 'allowed', 'OrderController', 'Order', '--json').stdout);
    expect(controller).toMatchObject({ severity: 'error', exitCode: 1, allowedTypes: [] });
    expect(controller.decisions.map((d: { edgeType: string; severity: string }) => [d.edgeType, d.severity])).toEqual([['import', 'warn'], ['instantiation', 'error']]);
    const store = new Store(join(variant, '.mapx', 'mapx.db'));
    try {
      const ctx = openArchitecture(variant, store)!;
      // An excluded path is out of scope: check reports nothing for it.
      expect(isAllowed(ctx, 'MailGateway', 'Order')).toMatchObject({ allowed: true, rule: 'out-of-scope', exitCode: 0 });
      // An overlay layer as the target: denied by "*" here.
      expect(isAllowed(ctx, 'Application', 'Legacy')).toMatchObject({ allowed: false, rule: 'disallowed-layer', severity: 'error', exitCode: 1 });
      // changed --with-dependents follows evaluated edges only: MailGateway (excluded) is no dependent of Order.
      const dependents = changedLayers(ctx, ['src/domain/Order.ts'], { withDependents: true }).dependents!.flatMap((d) => d.files);
      expect(dependents).not.toContain('src/infrastructure/MailGateway.ts');
      expect(dependents).toContain('src/infrastructure/SqlOrderRepository.ts');
    } finally {
      store.close();
    }
  });

  it('on the two-repo workspace: inferred HTTP edges are warnings under policy.inferred "warn"', () => {
    const { checked } = agree(ws);
    expect(checked).toContain('frontend/src/admin.ts#listUsers → App\\Http\\Controllers\\Admin\\UserController::index');
    const r = mapxResult(ws, 'arch', 'allowed', 'listUsers', 'App\\Http\\Controllers\\Admin\\UserController::index', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ allowed: false, severity: 'warn', decisions: [{ edgeType: 'http', observed: true, verifiability: 'inferred', severity: 'warn' }] });
  });

  it('an overlay layer nothing denies is `overlay`, not uncovered', () => {
    const store = new Store(join(root, '.mapx', 'mapx.db'));
    try {
      const doc = JSON.parse(readFileSync(join(root, '.mapx/architecture/introspect.jsonc'), 'utf8'));
      doc.layers.push({ name: 'Deprecated', overlay: true, selectors: [{ path: 'src/support/**' }] });
      writeFileSync(join(root, '.mapx/architecture/overlay.jsonc'), JSON.stringify(doc));
      const ctx = openArchitecture(root, store, { view: 'overlay' })!;
      expect(isAllowed(ctx, 'Application', 'Deprecated')).toMatchObject({ allowed: true, rule: 'overlay', severity: 'info', exitCode: 0 });
    } finally {
      store.close();
    }
  });

  it('changed --since on a workspace whose root is no git repository: each repo is asked', () => {
    const git = (repo: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: join(ws, repo), stdio: 'ignore' });
    for (const repo of ['frontend', 'backend']) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base'); }
    appendFileSync(join(ws, 'frontend/src/orders.ts'), '// changed\n');
    const r = mapxResult(ws, 'arch', 'changed', '--since', 'HEAD', '--json');
    expect([r.status, JSON.parse(r.stdout)]).toEqual([0, { files: [{ file: 'frontend/src/orders.ts', indexed: true, inScope: true, layers: ['Frontend'] }], layers: ['Frontend'] }]);
    expect(mapxResult(ws, 'arch', 'changed', '--since', 'no-such-ref').status).toBe(3);
  });
});


describe('mapx arch: legacy flags and the exit contract', CLI, () => {
  it('`mapx arch` with only legacy flags prints exactly what it printed before M5-08', () => {
    for (const [args, golden] of [[[], 'arch.txt'], [['--smells'], 'arch-smells.txt'], [['--dsm'], 'arch-dsm.txt'], [['--violations'], 'arch-violations.txt']] as const) {
      const r = mapxResult(root, 'arch', ...args);
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.stdout, args.join(' ')).toBe(readFileSync(join(LEGACY, golden), 'utf8'));
    }
    // The path argument and --dir still select the workspace from anywhere.
    expect(mapxResult(tmpdir(), 'arch', root, '--violations').stdout).toBe(readFileSync(join(LEGACY, 'arch-violations.txt'), 'utf8'));
    expect(mapxResult(tmpdir(), 'arch', '--dsm', '-d', root).stdout).toBe(readFileSync(join(LEGACY, 'arch-dsm.txt'), 'utf8'));
  });

  it('no configuration or no such view is exit 3; no index is exit 4', () => {
    expect(json('layers', '--view', 'missing')).toMatchObject({ status: 3, body: { error: expect.stringContaining('No view "missing"') } });
    const bare = mkdtempSync(join(tmpdir(), 'mapx-arch-introspect-bare-'));
    try {
      writeFileSync(join(bare, 'a.ts'), 'export const a = 1;\n');
      expect(mapxResult(bare, 'arch', 'layers').status).toBe(4);
      // JSON consumers get an error object whatever the exit code (review of M5-08).
      const noIndex = mapxResult(bare, 'arch', 'layers', '--json');
      expect([noIndex.status, JSON.parse(noIndex.stdout)]).toEqual([4, { error: `No MapX index in ${bare}: run \`mapx init\` and \`mapx scan\` first.` }]);
      init(bare);
      mapx(bare, 'scan');
      expect(mapxResult(bare, 'arch', 'unassigned').status).toBe(3);
      writeFileSync(join(bare, '.mapx/architecture.jsonc'), '{ "layers": [{ "name": "A", "selectors": [{ "paht": "x" }] }], "rules": {} }');
      const invalid = mapxResult(bare, 'arch', 'layers', '--json');
      expect(invalid.status).toBe(3);
      expect(JSON.parse(invalid.stdout)).toMatchObject({ error: 'Invalid architecture configuration', issues: [{ file: '.mapx/architecture.jsonc', pointer: expect.any(String), message: expect.any(String) }] });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 120_000);

  it('a stale index is exit 4 (unless --sync), except for `changed`, which reads it as it is; --since asks git', () => {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    appendFileSync(join(root, 'src/domain/Money.ts'), '// changed\n');
    writeFileSync(join(root, 'src/support/Later.ts'), 'export class Later {}\n');
    const stale = mapxResult(root, 'arch', 'layers');
    expect(stale.status).toBe(4);
    expect(stale.stderr).toContain('`mapx arch layers --sync`');
    expect(json('changed', '--since', 'HEAD', '--with-dependents')).toEqual({ status: 0, stderr: '', body: {
      files: [{ file: 'src/domain/Money.ts', indexed: true, inScope: true, layers: ['Domain'] }, { file: 'src/support/Later.ts', indexed: false, inScope: true, layers: [] }],
      layers: ['Domain'],
      dependents: [{ layer: 'Domain', files: ['src/domain/Order.ts'] }, { layer: 'Shared', files: ['src/shared/Result.ts'] }],
      unassignedDependents: [],
    } });
    expect(json('changed', '--since', 'no-such-ref').status).toBe(3);
    expect(mapxResult(root, 'arch', 'layers', '--sync').status).toBe(0);
  }, 120_000);
});
