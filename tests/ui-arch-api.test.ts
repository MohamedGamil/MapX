import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { startUiServer } from '../src/ui-server.js';
import { STALE_MS, archEvaluations } from '../src/ui-arch.js';
import { init, mapx, mapxResult, workspace } from './helpers/e2e.js';
import type { ArchReport } from '../src/arch/report.js';

// M5-15: the dashboard's architecture API (/api/arch/report, /api/arch/layers, /api/arch/edges)
// against the real ui-server, on the TypeScript app of the M5-01 fixture (tests/fixtures/arch-rules/ts)
// with two changes, both synthetic:
//   - the empty Reporting layer is renamed to an HTML payload and selects src/plugins/**, where the
//     test adds Widget.ts: two methods and a helper function create Money, a method returns Order
//     (payload → Domain violations whose dependencies are finer than their findings: review of M5-15);
//   - a baseline keeps the Shared → Domain violations (Result → Money), which become skipped, and
//     the first of the payload's.
// Every figure is compared with an independent run of the CLI (`mapx check`, `mapx arch deps`,
// `mapx arch layers`, `mapx arch unassigned`) on the same workspace: the API decides nothing itself.
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules/ts');
const XSS_LAYER = '<img src=x onerror=alert(1)>';
/** Two methods and a helper creating Money, and a method returning Order: several dependencies per finding. */
const WIDGET = "import { Money } from '../domain/Money';\nimport { Order } from '../domain/Order';\n\nexport class Widget {\n  a(): void { new Money(); }\n  b(): void { new Money(); }\n  c(): Order | null { return null; }\n}\n\nexport function helper(): void { new Money(); new Money(); }\n";

async function serve(root: string): Promise<{ server: Server; base: string }> {
  const server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  // The server runs in this process, so a synchronous CLI run blocks it: an idle keep-alive socket
  // must outlive that, or the next fetch reuses a socket the server is closing (ECONNRESET).
  server.keepAliveTimeout = 120_000;
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const getFrom = (base: string) => async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { status: res.status, type: res.headers.get('content-type'), allow: res.headers.get('allow'), body: await res.json() as any };
};
/** The CLI's JSON answer (exit codes 0–2 are answers: violations, uncovered, unassigned). */
const cliJson = (root: string, ...args: string[]) => {
  const r = mapxResult(root, ...args);
  expect(r.status, r.stderr).toBeLessThanOrEqual(2);
  return JSON.parse(r.stdout);
};
/** Every file under .mapx but the index (opened as every endpoint opens it), with size and mtime. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (!/^mapx\.db(-wal|-shm|-journal)?$/.test(name)) out.push(`${p.slice(root.length)} ${s.size} ${s.mtimeMs}`);
    }
  };
  walk(join(root, '.mapx'));
  return out.sort();
}

describe('/api/arch on the arch-rules fixture (M5-15)', () => {
  let root: string;
  let server: Server;
  let get: ReturnType<typeof getFrom>;
  let check: ArchReport;
  let before: string[];
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mapx-ui-arch-'));
    cpSync(FIXTURE, root, { recursive: true });
    const file = join(root, '.mapx/architecture.jsonc');
    const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\/\/.*\n/, ''));
    delete doc.$schema;
    const reporting = doc.layers.find((l: { name: string }) => l.name === 'Reporting');
    Object.assign(reporting, { name: XSS_LAYER, selectors: [{ path: 'src/plugins/**' }] });
    writeFileSync(file, JSON.stringify(doc, null, 2));
    mkdirSync(join(root, 'src/plugins'));
    writeFileSync(join(root, 'src/plugins/Widget.ts'), WIDGET);
    init(root);
    mapx(root, 'scan');
    mapxResult(root, 'check', '--generate-baseline');
    const baselineFile = join(root, '.mapx/architecture.baseline.json');
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const plugins = baseline.entries.filter((e: { source: string }) => e.source.startsWith('src/plugins/'));
    baseline.entries = [...baseline.entries.filter((e: { source: string }) => e.source.startsWith('src/shared/')), plugins[0]];
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
    check = cliJson(root, 'check', '--format', 'json', '--report-uncovered', '--report-skipped');
    ({ server } = await serve(root).then((s) => { get = getFrom(s.base); return s; }));
    before = snapshot(root);
  }, 300_000);
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('report: the layer graph is check\'s layerEdges, with the baseline applied', async () => {
    const { status, body } = await get('/api/arch/report');
    expect(status).toBe(200);
    expect(body).toMatchObject({ configured: true, valid: true, stale: false, repo: null, view: null });
    expect(body.graph.layers.map((l: any) => l.name)).toEqual(['Controller', 'Application', 'Domain', 'Shared', 'Infrastructure', XSS_LAYER]);
    const pairs = (edges: any[]) => edges.map((e) => `${e.from}>${e.to} ${e.allowed}/${e.violations}/${e.warnings}/${e.skipped}`).sort();
    expect(pairs(body.graph.edges)).toEqual(pairs(check.layerEdges));
    const edge = (from: string, to: string) => body.graph.edges.find((e: any) => e.from === from && e.to === to);
    expect(edge('Shared', 'Domain')).toMatchObject({ allowed: 0, violations: 0, skipped: 2 });
    expect(edge(XSS_LAYER, 'Domain')).toMatchObject({ allowed: 0, skipped: 1 });
    expect(body.counts).toEqual(check.counts);
    // The edges as `mapx arch graph` draws them: one per status of a pair.
    expect(body.drawn.filter((e: any) => e.from === 'Controller' && e.to === 'Application').map((e: any) => [e.status, e.count])).toEqual([['allowed', 4], ['violation', 4]]);
    expect(body.drawn).toContainEqual({ from: 'Shared', to: 'Domain', status: 'skipped', count: 2, toGroup: null });
  });

  it('report: the layer DSM marks each cell by its worst status', async () => {
    const { body } = await get('/api/arch/report');
    const { dsm } = body;
    expect(dsm.layers).toEqual(['Controller', 'Application', 'Domain', 'Shared', 'Infrastructure', XSS_LAYER]);
    const cell = (from: string, to: string) => {
      const i = dsm.layers.indexOf(from);
      const j = dsm.layers.indexOf(to);
      return [dsm.matrix[i][j], dsm.status[i][j]];
    };
    expect(cell('Controller', 'Application')).toEqual([8, 'violation']);
    expect(cell('Application', 'Shared')).toEqual([2, 'allowed']);
    expect(cell('Shared', 'Domain')).toEqual([2, 'skipped']);
    expect(cell(XSS_LAYER, 'Domain')[1]).toBe('violation');
    expect(cell('Domain', 'Application')).toEqual([0, 'none']);
    // The faint cells: allowances no dependency uses, as `mapx arch unused` lists them.
    const unused = cliJson(root, 'arch', 'unused', '--format', 'json');
    expect(body.unusedAllowances).toEqual(unused.allowances.map((a: any) => ({ from: a.from, to: a.to, rule: a.rule })));
    expect(body.unusedAllowances).toContainEqual({ from: 'Infrastructure', to: 'Shared', rule: 'explicit' });
  });

  it('report: health figures and findings are check\'s, the rule smells M5-16\'s', async () => {
    const { body } = await get('/api/arch/report');
    const unassigned = cliJson(root, 'arch', 'unassigned', '--format', 'json');
    const warnLevel = check.findings.filter((f) => f.kind === 'violation' && f.severity === 'warn').length;
    expect(body.health).toEqual({
      violations: check.counts.violation, warnLevelViolations: warnLevel, warnings: check.counts.warning, baselineDebt: check.counts.skipped,
      uncovered: check.counts.uncovered, unassigned: unassigned.total, configErrors: 0, ruleSmells: expect.any(Number), trend: null,
    });
    // M5-24: 19 of the uncovered are HttpGateway's and toolingCheck's dependencies on packages in no layer.
    expect(check.counts.uncovered).toBe(23);
    // Review of M5-15: the Warnings tile is check's "Warnings" (the multi-layer OrderId), not warn-level violations.
    expect(check.counts.warning).toBeGreaterThan(0);
    expect(check.counts.skipped).toBe(3); // Result → Money twice, and the payload's first
    expect(unassigned.total).toBe(4);
    // Every finding check shows with --report-uncovered --report-skipped, in its order; allowed ones only counted.
    expect(body.findings.map((f: any) => f.fingerprint)).toEqual(check.findings.map((f) => f.fingerprint));
    expect(body.findings.some((f: any) => f.kind === 'allowed')).toBe(false);
    const skipped = body.findings.filter((f: any) => f.kind === 'skipped' && f.source.file === 'src/shared/Result.ts');
    expect(skipped.map((f: any) => [f.target.file, f.skippedBy])).toEqual([['src/domain/Money.ts', 'baseline'], ['src/domain/Money.ts', 'baseline']]);
    // The rule smells are the ones /api/smells merges (M5-16), one evaluation each.
    const smells = (await get('/api/smells')).body.smells.filter((s: any) => s.source === 'rules');
    expect(body.smells.map((s: any) => [s.type, s.description]).sort()).toEqual(smells.map((s: any) => [s.type, s.description]).sort());
    expect(body.health.ruleSmells).toBe(body.smells.filter((s: any) => s.type !== 'layer-violation' && s.type !== 'architecture-config').length);
  });

  it('layers: sizes, the overlay per file, unassigned files, and members with their selector', async () => {
    const { status, body } = await get('/api/arch/layers');
    expect(status).toBe(200);
    expect(body.layers.map((l: any) => [l.name, l.files])).toEqual(check.layers.map((l) => [l.name, l.files]));
    expect(body.files['src/controller/OrderController.ts']).toEqual(['Controller']);
    expect(body.files['src/domain/ids/OrderId.ts']).toEqual(['Domain', 'Shared']);
    expect(body.files['src/plugins/Widget.ts']).toEqual([XSS_LAYER]);
    expect(body.files['src/support/Clock.ts']).toBeUndefined();
    expect(body.unassigned).toEqual(['src/support/Clock.ts', 'src/support/Uuid.ts']);

    for (const layer of ['Shared', XSS_LAYER]) {
      const cli = cliJson(root, 'arch', 'layers', layer, '--why', '--format', 'json');
      const one = (await get(`/api/arch/layers?layer=${encodeURIComponent(layer)}`)).body.layer;
      expect(one).toEqual(cli);
      expect(one.members.length).toBeGreaterThan(0);
    }
    const missing = await get('/api/arch/layers?layer=Nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('"Nope" is not a layer');
  });

  it('edges: every pair counts as the report, the DSM and mapx check count it (review of M5-15, P1)', async () => {
    const { body } = await get('/api/arch/report');
    const at = (from: string, to: string) => body.dsm.matrix[body.dsm.layers.indexOf(from)][body.dsm.layers.indexOf(to)];
    expect(check.layerEdges.length).toBeGreaterThan(5);
    for (const e of check.layerEdges) {
      const r = (await get(`/api/arch/edges?from=${encodeURIComponent(e.from)}&to=${encodeURIComponent(e.to)}`)).body;
      const graph = body.graph.edges.find((g: any) => g.from === e.from && g.to === e.to);
      const pair = `${e.from} → ${e.to}`;
      expect({ allowed: r.counts.allowed, violations: r.counts.violations, warnings: r.counts.warnings, skipped: r.counts.skipped }, pair)
        .toEqual({ allowed: e.allowed, violations: e.violations, warnings: e.warnings, skipped: e.skipped });
      expect(r.findings.length, pair).toBe(e.allowed + e.violations + e.skipped);
      expect(at(e.from, e.to), pair).toBe(r.findings.length);
      expect(graph, pair).toMatchObject({ allowed: e.allowed, violations: e.violations, skipped: e.skipped });
    }
    // The case the review found: Widget's methods and helper are finer than its findings, and one
    // finding is baselined. Counts are findings; their dependencies are listed under each.
    const plugin = check.layerEdges.find((e) => e.from === XSS_LAYER && e.to === 'Domain')!;
    expect(plugin.skipped).toBe(1);
    const r = (await get(`/api/arch/edges?from=${encodeURIComponent(XSS_LAYER)}&to=Domain`)).body;
    const deps = r.findings.flatMap((f: any) => f.dependencies);
    expect(deps.length).toBeGreaterThan(r.findings.length);
    expect(r.findings.map((f: any) => f.fingerprint)).toEqual(check.findings.filter((f) => f.source?.file === 'src/plugins/Widget.ts').map((f) => f.fingerprint));
    const instantiation = r.findings.find((f: any) => f.source.element.endsWith('#Widget') && f.edgeType === 'instantiation');
    expect(instantiation.dependencies.map((d: any) => d.source.element).sort()).toEqual(['src/plugins/Widget.ts#Widget.a', 'src/plugins/Widget.ts#Widget.b']);
    expect(r.findings.filter((f: any) => f.kind === 'skipped')).toHaveLength(1);
  });

  it('edges: the dependencies are mapx arch deps\', grouped under their findings', async () => {
    for (const [from, to] of [['Controller', 'Application'], ['Shared', 'Domain'], [XSS_LAYER, 'Domain']] as const) {
      const cli = cliJson(root, 'arch', 'deps', from, to, '--format', 'json');
      const { status, body } = await get(`/api/arch/edges?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      expect(status).toBe(200);
      const key = (d: any) => JSON.stringify(d);
      expect(body.findings.flatMap((f: any) => f.dependencies).map(key).sort()).toEqual(cli.dependencies.map(key).sort());
      expect(body.findings.every((f: any) => (f.kind === 'skipped') === (from === 'Shared' || f.skippedBy === 'baseline'))).toBe(true);
    }
    const r = (await get('/api/arch/edges?from=Controller&to=Application')).body;
    expect(r.counts).toEqual({ allowed: 4, violations: 4, warnings: 0, skipped: 0, uncovered: 0 });
    const pricing = r.findings.find((f: any) => f.target.file === 'src/application/internal/PricingRules.ts' && f.edgeType === 'import');
    expect(pricing).toMatchObject({ kind: 'violation', rule: 'private-layer', source: { file: 'src/controller/OrderController.ts', line: 4 } });
    expect(pricing.dependencies).toHaveLength(1);
    // Without `to`: every finding from the layer, uncovered ones included.
    const any = (await get('/api/arch/edges?from=Application')).body;
    expect(any.counts.uncovered).toBe(2);
    expect((await get('/api/arch/edges?to=Domain')).status).toBe(400);
    expect((await get('/api/arch/edges?from=Controller&to=Nope')).status).toBe(404);
  });

  it('a layer named like HTML comes back as JSON data, byte for byte', async () => {
    const r = await get('/api/arch/report');
    expect(r.type).toBe('application/json');
    expect(r.body.graph.layers.at(-1).name).toBe(XSS_LAYER);
    const v = r.body.findings.find((f: any) => f.source?.file === 'src/plugins/Widget.ts' && f.kind === 'violation');
    expect(v.source.layer).toBe(XSS_LAYER);
    expect(v.source.layers).toEqual([XSS_LAYER]);
    expect(v.message).toContain(`(${XSS_LAYER} on Domain)`);
  });

  it('repo= follows M4-21: unknown repos 404, the primary repo keeps every list', async () => {
    const primary = basename(root);
    for (const path of ['/api/arch/report', '/api/arch/layers', '/api/arch/edges?from=Controller']) {
      expect((await get(`${path}${path.includes('?') ? '&' : '?'}repo=nope`)).status, path).toBe(404);
    }
    const all = (await get('/api/arch/report')).body;
    const one = (await get(`/api/arch/report?repo=${primary}`)).body;
    expect(one.repo).toBe(primary);
    expect(one.findings).toEqual(all.findings);
    expect((await get(`/api/arch/layers?repo=${primary}`)).body.files).toEqual((await get('/api/arch/layers')).body.files);
  });

  it('evaluates once per batch of requests, and again when the configuration changes (review of M5-15)', async () => {
    await get('/api/arch/report');
    const n = archEvaluations();
    for (const path of ['/api/arch/report', '/api/arch/layers', '/api/arch/layers?layer=Shared', '/api/arch/edges?from=Controller&to=Application', '/api/arch/edges?from=Shared']) {
      expect((await get(path)).status, path).toBe(200);
    }
    expect(archEvaluations()).toBe(n);
    // The same configuration with a new mtime: evaluated again (a size or mtime change of a watched file).
    const file = join(root, '.mapx/architecture.jsonc');
    const text = readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, text);
    await get('/api/arch/report');
    expect(archEvaluations()).toBe(n + 1);
    await get('/api/arch/layers');
    expect(archEvaluations()).toBe(n + 1);
  });

  it('is read-only: other methods get 405, unknown routes 404, and no file under .mapx changed', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await get('/api/arch/report', { method });
      expect(r.status, method).toBe(405);
      expect(r.allow).toBe('GET, HEAD');
    }
    expect((await get('/api/arch/nope')).status).toBe(404);
    // The previous test rewrote architecture.jsonc with the same bytes: only its mtime may differ.
    const sameBytes = (lines: string[]) => lines.map((l) => (l.startsWith('/.mapx/architecture.jsonc ') ? l.replace(/ [\d.]+$/, '') : l));
    expect(sameBytes(snapshot(root))).toEqual(sameBytes(before));
  });

  it('a stale index is answered with mapx check\'s reason, still 200 (review of M5-15)', async () => {
    const late = join(root, 'src/shared/Late.ts');
    writeFileSync(late, "import { PlaceOrder } from '../application/PlaceOrder';\nexport const late = PlaceOrder;\n");
    try {
      await new Promise((r) => setTimeout(r, STALE_MS + 200));
      const checkRun = mapxResult(root, 'check', '--format', 'json');
      expect(checkRun.status).toBe(4);
      for (const path of ['/api/arch/report', '/api/arch/layers', '/api/arch/edges?from=Controller&to=Application']) {
        const r = await get(path);
        expect(r.status, path).toBe(200);
        expect(r.body.stale, path).toBe(true);
        expect(r.body.staleReason, path).toContain('The index is stale: 1 file(s) changed since the last scan (src/shared/Late.ts (new))');
      }
    } finally {
      rmSync(late);
    }
  });
});

describe('/api/arch without a configuration, and with an invalid one (M5-15)', () => {
  let root: string;
  let server: Server;
  let get: ReturnType<typeof getFrom>;
  beforeAll(async () => {
    root = workspace({ 'src/a.ts': "import { b } from './b';\nexport const a = () => b();\n", 'src/b.ts': 'export const b = () => 1;\n' });
    init(root);
    mapx(root, 'scan');
    const s = await serve(root);
    server = s.server;
    get = getFrom(s.base);
  }, 180_000);
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('every endpoint answers 200 with the "no config" state and the mapx arch init hint', async () => {
    for (const path of ['/api/arch/report', '/api/arch/layers', '/api/arch/layers?layer=Domain', '/api/arch/edges?from=Domain']) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.body.configured, path).toBe(false);
      expect(r.body.hint, path).toContain('mapx arch init');
    }
  });

  it('an invalid configuration is a "not valid" state with its problems, not a 500', async () => {
    writeFileSync(join(root, '.mapx/architecture.jsonc'), '{ "layers": "nope" }');
    try {
      for (const path of ['/api/arch/report', '/api/arch/layers', '/api/arch/edges?from=A']) {
        const r = await get(path);
        expect(r.status, path).toBe(200);
        expect(r.body, path).toMatchObject({ configured: true, valid: false });
        expect(r.body.errors.length, path).toBeGreaterThan(0);
        expect(r.body.errors.join('\n')).toContain('architecture.jsonc');
      }
    } finally {
      rmSync(join(root, '.mapx/architecture.jsonc'));
    }
  });
});

// Review of M5-15: a workspace of two registered repos (the primary and `web`, its own git checkout)
// under one configuration, whose app layer is named `App, UI` (a comma in a layer name). Each repo
// has an App → Domain violation and a dependency on an unassigned file. All synthetic.
describe('/api/arch narrowed to a repo, and a layer named with a comma (review of M5-15)', () => {
  const APP = 'App, UI';
  let root: string;
  let server: Server;
  let get: ReturnType<typeof getFrom>;
  let check: ArchReport;
  beforeAll(async () => {
    root = workspace({
      'src/domain/Order.ts': 'export class Order {}\n',
      'src/util/Clock.ts': 'export function now(): number { return 0; }\n',
      'src/app/PlaceOrder.ts': "import { Order } from '../domain/Order';\nimport { now } from '../util/Clock';\n\nexport class PlaceOrder {\n  run(): number { new Order(); return now(); }\n}\n",
      'web/src/domain/Cart.ts': 'export class Cart {}\n',
      'web/src/util/Log.ts': 'export function log(): void {}\n',
      'web/src/app/AddToCart.ts': "import { Cart } from '../domain/Cart';\nimport { log } from '../util/Log';\n\nexport class AddToCart {\n  run(): void { new Cart(); log(); }\n}\n",
      '.mapx/architecture.jsonc': JSON.stringify({
        layers: [
          { name: 'Domain', selectors: [{ path: 'src/domain/**' }, { path: 'web/src/domain/**' }] },
          { name: APP, selectors: [{ path: 'src/app/**' }, { path: 'web/src/app/**' }] },
        ],
        rules: {},
      }, null, 2),
    }, ['web']);
    init(root);
    mapx(root, 'workspaces', 'add', 'web');
    mapx(root, 'scan');
    check = cliJson(root, 'check', '--format', 'json', '--report-uncovered');
    const s = await serve(root);
    server = s.server;
    get = getFrom(s.base);
  }, 300_000);
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('repo=web narrows findings, files, members and dependencies to web; the overview stays the workspace\'s', async () => {
    const web = (f: string | undefined) => !!f && f.startsWith('web/');
    const all = (await get('/api/arch/report')).body;
    const one = (await get('/api/arch/report?repo=web')).body;
    expect(all.findings.some((f: any) => web(f.source?.file))).toBe(true);
    expect(all.findings.some((f: any) => f.source && !web(f.source.file))).toBe(true);
    expect(one.findings.length).toBeGreaterThan(0);
    expect(one.findings.every((f: any) => web(f.source.file))).toBe(true);
    expect(one.findings.map((f: any) => f.fingerprint)).toEqual(all.findings.filter((f: any) => web(f.source?.file)).map((f: any) => f.fingerprint));
    // The workspace's figures, whatever the repo (the stated scope), rule smells included.
    for (const k of ['graph', 'dsm', 'health', 'counts', 'smells']) expect(one[k], k).toEqual(all[k]);

    const layers = (await get('/api/arch/layers?repo=web')).body;
    expect(Object.keys(layers.files).sort()).toEqual(['web/src/app/AddToCart.ts', 'web/src/domain/Cart.ts']);
    expect(layers.unassigned).toEqual(['web/src/util/Log.ts']);
    expect((await get('/api/arch/layers')).body.unassigned).toEqual(['src/util/Clock.ts', 'web/src/util/Log.ts']);
    const members = (await get('/api/arch/layers?layer=Domain&repo=web')).body.layer.members;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m: any) => m.file === 'web/src/domain/Cart.ts')).toBe(true);

    const q = `/api/arch/edges?from=${encodeURIComponent(APP)}&to=Domain`;
    const pairAll = (await get(q)).body;
    const pairWeb = (await get(`${q}&repo=web`)).body;
    expect(pairAll.counts.violations).toBe(check.layerEdges.find((e) => e.from === APP && e.to === 'Domain')!.violations);
    expect(pairWeb.counts.violations).toBe(pairAll.findings.filter((f: any) => web(f.source.file)).length);
    expect(pairWeb.counts.violations).toBeGreaterThan(0);
    expect(pairWeb.counts.violations).toBeLessThan(pairAll.counts.violations);
    expect(pairWeb.findings.flatMap((f: any) => f.dependencies).every((d: any) => web(d.source.file))).toBe(true);
  });

  it('mapx check --layer and the findings name a layer with a comma as one layer', async () => {
    const mine = check.findings.filter((f) => f.source?.layers?.includes(APP));
    expect(mine.length).toBeGreaterThanOrEqual(4); // a violation and an uncovered dependency per repo, at least
    expect(mine.every((f) => f.source!.layer === APP)).toBe(true);
    const selected = cliJson(root, 'check', '--format', 'json', '--report-uncovered', '--layer', APP);
    expect(selected.findings.map((f: any) => f.fingerprint)).toEqual(mine.map((f) => f.fingerprint));
    const domain = cliJson(root, 'check', '--format', 'json', '--report-uncovered', '--layer', 'Domain');
    expect(domain.findings.length).toBeGreaterThan(0);
    expect(domain.findings.every((f: any) => f.target?.layers?.includes('Domain'))).toBe(true);
  });
});
