import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { init, mapx, mapxResult, mapxResultEnv } from './helpers/e2e.js';
import { layerGraph, renderLayerGraph, type LayerGraph } from '../src/arch/reporters/index.js';
import { renderBuiltinSvg } from '../src/arch/reporters/svg.js';
import { mermaidIds } from '../src/arch/reporters/mermaid.js';
import { escapeXml } from '../src/exporters/svg-exporter.js';
import type { ArchReport } from '../src/arch/report.js';
import type { ArchitectureConfig } from '../src/arch/schema.js';

// M5-13 (AR-16): `mapx arch graph`, the layer graph as DOT, SVG, Mermaid, a layer DSM and JSON, on the
// TypeScript app of the M5-01 fixture with a view `graph.jsonc` that exercises every drawing rule:
//   - groups by both forms: `report.groups` puts Domain and Shared in "Domain", and Controller's own
//     `group` is `Web & "UI"` (quotes and an ampersand to escape); `pointToGroups` makes edges into
//     Domain from outside the group point at the group;
//   - `report.hidden` hides Infrastructure, renamed `Infra, Ops` (a ", " in a name), with edges both ways;
//   - an advisory allowance (Controller → Domain, warn) and a colour (Controller);
//   - Reporting renamed `Reports "v2" <beta>` (no edges: a label to escape);
//   - a baseline holding the Shared → Domain violations, which are drawn skipped (dashed);
//   - two files the test adds (review of M5-13): IdController imports OrderId, which is in Domain
//     and Shared, so one finding counts on two layer pairs; and src/domain/ids/OrderRef.ts, in Domain
//     and Shared, imports PlaceOrder, advisory for Domain and an error for Shared: one finding whose
//     two pairs have different severities.
// Golden files: tests/fixtures/arch-graph/ts.{dot,mmd,dsm.txt}. Regenerate with UPDATE_GOLDEN=1
// after a deliberate change, and review the diff.
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules/ts');
const GOLDEN = resolve(__dirname, 'fixtures/arch-graph');
const CLI = { timeout: 180_000 };
const REPORTS = 'Reports "v2" <beta>';
const INFRA = 'Infra, Ops';
const HAS_DOT = spawnSync('dot', ['-V']).status === 0;
let root = '';

const graph = (...args: string[]) => {
  const r = mapxResult(root, 'arch', 'graph', '--view', 'graph', ...args);
  expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
  return r.stdout;
};
function golden(name: string, actual: string) {
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN) { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(file, actual); }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}
/** `mapx check --view graph --format json`, run on its own: what the graph must agree with. */
const checkReport = () => JSON.parse(mapxResult(root, 'check', '--view', 'graph', '--format', 'json').stdout) as ArchReport;
/** The caption every format prints, built from check's own counts. */
function caption(check: ArchReport): string {
  const warn = check.findings.filter((f) => f.kind === 'violation' && f.severity === 'warn').length;
  const c = check.counts;
  return `Dependencies: ${c.allowed} allowed, ${c.violation} violations (${warn} at warn), ${c.skipped} skipped, ${c.uncovered} uncovered; 1 hidden layer counted, not drawn`;
}
/** Graphviz's own reading of a DOT text: its nodes (id, label) and edges (tail, head). */
function plain(dot: string): { nodes: Array<{ id: string; label: string }>; edges: Array<{ tail: string; head: string }> } {
  const r = spawnSync('dot', ['-Tplain'], { input: dot, encoding: 'utf8' });
  expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
  const nodes: Array<{ id: string; label: string }> = [];
  const edges: Array<{ tail: string; head: string }> = [];
  for (const line of r.stdout.split('\n')) {
    const n = /^node (\S+) \S+ \S+ \S+ \S+ ("(?:[^"\\]|\\.)*"|\S+)/.exec(line);
    if (n) nodes.push({ id: n[1]!, label: n[2]!.startsWith('"') ? n[2]!.slice(1, -1) : n[2]! });
    const e = /^edge (\S+) (\S+)/.exec(line);
    if (e) edges.push({ tail: e[1]!, head: e[2]! });
  }
  return { nodes, edges };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mapx-arch-graph-'));
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, 'src/controller/IdController.ts'), "import { OrderId } from '../domain/ids/OrderId';\n\nexport class IdController {\n  run(): void {\n    new OrderId().run();\n  }\n}\n");
  writeFileSync(join(root, 'src/domain/ids/OrderRef.ts'), "import { PlaceOrder } from '../../application/PlaceOrder';\n\nexport class OrderRef {\n  run(): void {\n    new PlaceOrder().run();\n  }\n}\n");
  const doc = JSON.parse(readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8').replace(/^\/\/.*\n/, ''));
  delete doc.$schema;
  for (const l of doc.layers) {
    if (l.name === 'Controller') Object.assign(l, { group: 'Web & "UI"', color: '#fde68a' });
    if (l.name === 'Reporting') l.name = REPORTS;
    if (l.name === 'Infrastructure') l.name = INFRA;
  }
  doc.rules[INFRA] = doc.rules.Infrastructure;
  delete doc.rules.Infrastructure;
  doc.rules.Controller = ['Application', { allow: ['Domain'], severity: 'warn' }];
  doc.rules.Domain = ['Shared', { allow: ['Application'], severity: 'warn' }];
  doc.report = { groups: { Domain: ['Domain', 'Shared'] }, hidden: [INFRA], pointToGroups: true };
  mkdirSync(join(root, '.mapx/architecture'), { recursive: true });
  writeFileSync(join(root, '.mapx/architecture/graph.jsonc'), JSON.stringify(doc, null, 2));
  init(root);
  mapx(root, 'scan');
  // The baseline of the view keeps only the Shared → Domain violations (Result → Money).
  mapx(root, 'check', '--view', 'graph', '--generate-baseline');
  const file = join(root, '.mapx/architecture/graph.baseline.json');
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  baseline.entries = baseline.entries.filter((e: { source: string }) => e.source.startsWith('src/shared/'));
  writeFileSync(file, JSON.stringify(baseline, null, 2));
}, 300_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('mapx arch graph on the fixture (AR-16)', CLI, () => {
  it('builds the layer graph from what mapx check reports: statuses, groups, hidden layers, totals', () => {
    const g = JSON.parse(graph('--format', 'json')) as LayerGraph;
    const check = checkReport();
    const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      'Controller>Application', 'Controller>Domain', 'Controller>Shared', `Controller>${INFRA}`,
      'Application>Domain', 'Application>Shared',
      'Domain>Application', 'Domain>Shared', `Domain>${INFRA}`, 'Shared>Application', 'Shared>Domain', `${INFRA}>Domain`,
    ]);
    // Every pair as check's own layerEdges (an independent CLI run), plus `hidden`.
    expect(g.edges.map(({ hidden: _h, ...e }) => e)).toEqual(expect.arrayContaining(check.layerEdges));
    expect(g.edges).toHaveLength(check.layerEdges.length);
    // Private-layer violations next to allowed dependencies; the baselined pair skipped.
    expect(edge('Controller', 'Application')).toEqual({ from: 'Controller', to: 'Application', allowed: 4, violations: 4, warnings: 0, skipped: 0, hidden: false });
    expect(edge('Shared', 'Domain')).toEqual({ from: 'Shared', to: 'Domain', allowed: 0, violations: 0, warnings: 0, skipped: 2, hidden: false });
    // IdController → OrderId: Shared refuses it, so it is an error on both of its pairs; with the
    // advisory OrderController → Order (warn) next to it on Controller → Domain.
    expect(edge('Controller', 'Domain')).toEqual({ from: 'Controller', to: 'Domain', allowed: 0, violations: 4, warnings: 2, skipped: 0, hidden: false });
    expect(edge('Controller', 'Shared')).toEqual({ from: 'Controller', to: 'Shared', allowed: 0, violations: 2, warnings: 0, skipped: 0, hidden: false });
    // OrderRef → PlaceOrder: one error finding (source in Domain and Shared) whose Domain pair is advisory.
    const ref = check.findings.filter((f) => f.source?.element === 'src/domain/ids/OrderRef.ts#OrderRef' && f.kind === 'violation');
    expect(ref.map((f) => [f.source!.layer, f.severity, f.edgeType])).toEqual([['Domain, Shared', 'error', 'import'], ['Domain, Shared', 'error', 'instantiation']]);
    expect(edge('Domain', 'Application')).toEqual({ from: 'Domain', to: 'Application', allowed: 0, violations: 2, warnings: 2, skipped: 0, hidden: false });
    expect(edge('Shared', 'Application')).toEqual({ from: 'Shared', to: 'Application', allowed: 0, violations: 2, warnings: 0, skipped: 0, hidden: false });
    expect(edge(INFRA, 'Domain')).toMatchObject({ allowed: 4, hidden: true });
    expect(edge('Domain', INFRA)).toMatchObject({ violations: 2, hidden: true });
    expect(g.groups).toEqual([
      { name: 'Web & "UI"', layers: ['Controller'], pointTo: null },
      { name: 'Domain', layers: ['Domain', 'Shared'], pointTo: 'Domain' },
    ]);
    expect(g.layers.find((l) => l.name === 'Controller')).toMatchObject({ group: 'Web & "UI"', color: '#fde68a', hidden: false });
    // Uncovered per layer, a name with ", " included: MailGateway → Uuid and PlaceOrder → Clock.
    expect(g.layers.map((l) => [l.name, l.uncovered])).toEqual([['Controller', 0], ['Application', 2], ['Domain', 0], ['Shared', 0], [INFRA, 2], [REPORTS, 0]]);
    // Totals are check's counts: a finding on two pairs is one dependency, not two.
    const w = check.findings.filter((f) => f.kind === 'violation' && f.severity === 'warn').length;
    expect(g.totals).toEqual({ allowed: check.counts.allowed, violations: check.counts.violation, warnings: w, skipped: check.counts.skipped, uncovered: check.counts.uncovered, hiddenLayers: 1 });
    expect(g.edges.reduce((n, e) => n + e.violations, 0)).toBeGreaterThan(check.counts.violation); // the pairs do double-count
  });

  it('golden DOT: counts on edges, red and amber violations, dashed skipped, clusters, lhead; hidden layers absent but counted', () => {
    const dot = graph();
    golden('ts.dot', dot);
    expect(dot).not.toContain('Infra');
    expect(dot).toContain(`label="${caption(checkReport())}"`);
    expect(dot).toContain('n1 -> n2 [label="2", color="#d97706", fontcolor="#d97706", lhead=cluster_0];'); // Controller → Domain (advisory)
    expect(dot).toContain('subgraph cluster_1 {\n    label="Web &amp; \\"UI\\"";');
    expect(graph('--format', 'dot')).toBe(dot); // byte-stable
    if (!HAS_DOT) return;
    // Graphviz reads it as drawn: one node per visible layer with its name, no self-loop.
    const p = plain(dot);
    expect(p.nodes.map((n) => n.label).sort()).toEqual(['Application', 'Controller', 'Domain', REPORTS.replace(/"/g, '\\"'), 'Shared'].sort());
    expect(p.edges.filter((e) => e.tail === e.head)).toEqual([]);
    expect(p.edges).toHaveLength(dot.split('\n').filter((l) => l.includes(' -> ')).length);
  });

  it('golden Mermaid: escaped labels, derived IDs, linkStyle per status, edges to a group; hidden layers absent', () => {
    const mmd = graph('--format', 'mermaid');
    golden('ts.mmd', mmd);
    expect(mmd).not.toContain('Infra');
    expect(mmd).toContain(`%% ${caption(checkReport())}`);
    expect(mmd).toContain('subgraph group_Web____UI_["Web #amp; #quot;UI#quot;"]');
    expect(mmd).toContain(`layer_Reports__v2___beta_["Reports #quot;v2#quot; #lt;beta#gt;"]`);
    expect(mmd).toContain('layer_Controller -->|2| group_Domain');
    expect(mmd).toContain('layer_Shared -.->|2| layer_Domain');
  });

  it('golden layer DSM: counts with status marks, hidden layers absent but counted', () => {
    const dsm = graph('--format', 'dsm');
    golden('ts.dsm.txt', dsm);
    expect(dsm).not.toContain('Infra');
    expect(dsm.trimEnd().split('\n').pop()).toBe(caption(checkReport()));
  });

  it('SVG renders without Graphviz: the built-in renderer, well-formed, the same bytes as --no-graphviz', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mapx-no-dot-'));
    try {
      // No `dot` on PATH: the CLI runs from process.execPath and needs nothing else here.
      const r = mapxResultEnv(root, { PATH: empty }, 'arch', 'graph', '--view', 'graph', '--format', 'svg', '-o', 'out/graph.svg');
      expect({ status: r.status, stderr: r.stderr, stdout: r.stdout }).toEqual({ status: 0, stderr: '', stdout: '' });
      const svg = readFileSync(join(root, 'out/graph.svg'), 'utf8');
      expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toContain('Infra');
      expect(svg).toContain('&quot;v2&quot; &lt;beta&gt;');
      expect(svg).toContain(escapeXml(caption(checkReport())));
      expect(svg).toContain('stroke="#dc2626"');
      expect(svg).toContain('stroke-dasharray="6 4" marker-end="url(#arrow-skipped)"');
      // The fallback is what --no-graphviz renders, and what the library renders in process.
      expect(graph('--format', 'svg', '--no-graphviz')).toBe(svg);
      const g = JSON.parse(graph('--format', 'json')) as LayerGraph;
      expect(renderBuiltinSvg(g)).toBe(svg);
      // Well-formed XML, by python3's own parser when it is there.
      const py = spawnSync('python3', ['-I', '-c', 'import sys, xml.etree.ElementTree as E; E.parse(sys.argv[1]); print("ok")', join(root, 'out/graph.svg')], { encoding: 'utf8' });
      if (py.status !== null && !py.error) expect(py.stdout.trim()).toBe('ok');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // With Graphviz installed, the default uses it.
    if (HAS_DOT) expect(graph('--format', 'svg')).toContain('<!-- Generated by graphviz');
  });

  it('a Graphviz that hangs, prints nothing or prints no SVG: the built-in renderer instead', () => {
    const builtin = graph('--format', 'svg', '--no-graphviz');
    const sleep = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
    const fakes: Record<string, string> = { hang: `#!/bin/sh\nexec ${sleep} 60\n`, empty: '#!/bin/sh\nexit 0\n', text: '#!/bin/sh\necho "not an svg"\n' };
    for (const [name, script] of Object.entries(fakes)) {
      const bin = mkdtempSync(join(tmpdir(), `mapx-fake-dot-${name}-`));
      try {
        writeFileSync(join(bin, 'dot'), script);
        chmodSync(join(bin, 'dot'), 0o755);
        const started = Date.now();
        const r = mapxResultEnv(root, { PATH: bin, MAPX_GRAPHVIZ_TIMEOUT_MS: '1500' }, 'arch', 'graph', '--view', 'graph', '--format', 'svg');
        expect({ name, status: r.status, stderr: r.stderr, same: r.stdout === builtin }).toEqual({ name, status: 0, stderr: '', same: true });
        expect(Date.now() - started).toBeLessThan(45_000);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    }
  });

  it('usage errors exit 3: an unknown format, a missing baseline', () => {
    const bad = mapxResult(root, 'arch', 'graph', '--format', 'png');
    expect(bad.status).toBe(3);
    expect(bad.stderr).toContain('--format must be dot, svg, mermaid, dsm or json, not "png"');
    const missing = mapxResult(root, 'arch', 'graph', '--baseline', 'nope.json');
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain('baseline file not found');
    expect(existsSync(join(root, 'nope.json'))).toBe(false);
  });
});

// ─── In process: escaping and byte stability on hostile names ─────────────────────────────────

function synthetic(names: string[], edges: ArchReport['layerEdges'], report: Partial<ArchitectureConfig['report']> = {}): { report: ArchReport; config: ArchitectureConfig } {
  const config = {
    files: [], view: null, parameters: {}, scope: { types: [], include: [], exclude: [] },
    policy: { inferred: 'warn', inheritDependencies: false, uncovered: { externals: true, builtins: false }, strictLayers: false },
    visibility: { internalTags: [], nativeMarkers: false },
    layers: names.map((name) => ({ name, selectors: [] })), rules: {}, baseline: null,
    report: { groups: {}, hidden: [], pointToGroups: false, codeclimate: {}, ...report },
  } as unknown as ArchitectureConfig;
  const counts = { violation: 0, skipped: 0, uncovered: 0, allowed: 0, warning: 0, error: 0 };
  return { config, report: { version: 1, counts, findings: [], layers: names.map((name) => ({ name, elements: 1, files: 1, overlay: false, uncovered: 0 })), layerEdges: edges, configErrors: [] } };
}
const e = (from: string, to: string, n: Partial<ArchReport['layerEdges'][number]> = {}) => ({ from, to, allowed: 0, violations: 0, warnings: 0, skipped: 0, ...n });

describe('escaping and stability (in process)', () => {
  const names = ['a "q" \\ b', 'line\nbreak', '<&># `x`', 'end', 'a b', 'a_b'];
  const { report, config } = synthetic(names, [e('end', 'a "q" \\ b', { allowed: 1 }), e('a b', 'a_b', { violations: 3, warnings: 1 }), e('line\nbreak', '<&># `x`', { skipped: 2 })], { groups: { 'g "1"': ['a b', 'a_b'] } });
  const g = layerGraph(report, config);

  it('DOT: synthetic IDs in name order, every label quoted', () => {
    const dot = renderLayerGraph('dot', g);
    // Names in code-unit order: "<&># `x`" n0, "a \"q\" \\ b" n1, "a b" n2, "a_b" n3, "end" n4, "line\nbreak" n5.
    expect(dot).toContain('n1 [label="a \\"q\\" \\\\ b"];');
    expect(dot).toContain('n5 [label="line\\nbreak"];');
    expect(dot).toContain('n0 [label="<&amp;># `x`"];');
    expect(dot).toContain('subgraph cluster_0 {\n    label="g \\"1\\"";');
    expect(dot).toContain('n4 -> n1 [label="1"];');
    // No raw line break inside a statement: every line is indented, empty, or opens or closes the graph.
    for (const line of dot.split('\n')) expect(line).toMatch(/^(digraph .*\{| .*|\}|)$/);
  });

  it.skipIf(!HAS_DOT)('Graphviz shows every name as written: %-names, entities, \\N and \\G', () => {
    const odd = ['%Domain', '%Shared', 'x&lt;y &amp; \\N\\G'];
    const s = synthetic(odd, [e('%Domain', '%Shared', { allowed: 2 }), e('x&lt;y &amp; \\N\\G', '%Domain', { violations: 1 })]);
    const dot = renderLayerGraph('dot', layerGraph(s.report, s.config));
    const p = plain(dot);
    expect(p.nodes).toHaveLength(3);
    expect(p.edges.filter((x) => x.tail === x.head)).toEqual([]);
    expect(p.edges).toHaveLength(2);
    const svg = renderLayerGraph('svg', layerGraph(s.report, s.config));
    expect(svg).toContain('<!-- Generated by graphviz');
    for (const name of odd) expect(svg).toContain(`>${escapeXml(name).replace(/&#39;/g, "'")}</text>`);
  });

  it('Mermaid IDs are distinct and safe, labels use entity codes', () => {
    expect([...mermaidIds('layer', ['a b', 'a_b', 'a-b']).values()]).toEqual(['layer_a_b', 'layer_a_b_2', 'layer_a_b_3']);
    const mmd = renderLayerGraph('mermaid', g);
    expect(mmd).toContain('layer_end["end"]');
    expect(mmd).toContain('layer_a__q____b["a #quot;q#quot; \\ b"]');
    expect(mmd).toContain('layer_______x_["#lt;#amp;#gt;#35; #96;x#96;"]');
    expect(mmd).toContain('layer_line_break["line break"]');
    expect(mmd).toContain('layer_a_b -->|2| layer_a_b_2');
    expect(mmd).toContain('layer_a_b -->|1| layer_a_b_2');
    for (const line of mmd.split('\n').filter((l) => /-->|-\.->/.test(l))) expect(line).toMatch(/^ {2}\w+ (-->|-\.->)\|\d+\| \w+$/);
  });

  it('SVG escapes text and stays well-formed', () => {
    const svg = renderBuiltinSvg(g);
    expect(svg).toContain('&quot;q&quot;');
    expect(svg).toContain('&lt;&amp;&gt;# `x`');
    expect(svg).not.toMatch(/<text[^>]*>[^<]*[&](?!amp;|lt;|gt;|quot;|#39;)/);
  });

  it('the DSM keeps its columns aligned when a cell is wider than 4', () => {
    const s = synthetic(['A', 'B', 'C'], [e('A', 'B', { violations: 1234 }), e('B', 'C', { allowed: 3 })]);
    const rows = renderLayerGraph('dsm', layerGraph(s.report, s.config)).split('\n').slice(1, 6);
    expect(rows.map((r) => r.length)).toEqual(Array(5).fill(rows[0]!.length));
    expect(rows[2]).toBe('L1 A      * 1234!     .');
  });

  it('output does not depend on the order of the report', () => {
    const shuffled = layerGraph({ ...report, layerEdges: [...report.layerEdges].reverse() }, config);
    for (const f of ['dot', 'mermaid', 'dsm', 'json', 'svg'] as const) {
      expect(renderLayerGraph(f, shuffled, { graphviz: false })).toBe(renderLayerGraph(f, g, { graphviz: false }));
    }
  });
});
