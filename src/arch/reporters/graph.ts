// The layer graph (M5-13; docs/research/deptrac AR-16, Deptrac's graphviz-* and mermaidjs
// formatters): one node per layer and, per layer pair, the dependencies `mapx check` counted
// (`report.layerEdges`), split by status. Built from the report itself, so every count and status
// comes from the evaluator's own decisions (`decideEdge`). The DOT, Mermaid, SVG and DSM renderers
// draw it; the dashboard (M5-15) and MCP (M5-14) can use the JSON as is.
//
//   groups      `report.groups` (group → layers), else a layer's own `group`: drawn as subgraphs
//   hidden      `report.hidden`: analysed and counted in `totals`, never drawn
//   pointTo     with `report.pointToGroups`, an edge into the layer named like its group points at
//               the group (a module's public API), as Deptrac's pointToGroups
import type { ArchReport, LayerEdge } from '../report.js';
import type { ArchitectureConfig } from '../schema.js';

export interface LayerGraphLayer {
  name: string;
  overlay: boolean;
  elements: number;
  files: number;
  group: string | null;
  /** The layer's `color` when it is `#rrggbb`, `#rrggbbaa` or a colour name; otherwise null. */
  color: string | null;
  hidden: boolean;
  /** Uncovered dependencies (targets in no layer) from this layer. */
  uncovered: number;
}

export interface LayerGraphGroup {
  name: string;
  /** Its layers in configuration order, hidden ones included. */
  layers: string[];
  /** With `pointToGroups`: the visible member named like the group, whose incoming edges point at the group. */
  pointTo: string | null;
}

export interface LayerGraphEdge extends LayerEdge {
  /** Either end is a hidden layer: counted in `totals`, not drawn. */
  hidden: boolean;
}

export interface LayerGraph {
  version: 1;
  view: string | null;
  /** In configuration order. */
  layers: LayerGraphLayer[];
  /** Ordered by their first layer. */
  groups: LayerGraphGroup[];
  /** Ordered by source, then target layer, in configuration order. */
  edges: LayerGraphEdge[];
  /**
   * The report's counts of dependencies (findings), whatever is hidden: `warnings` are the violations
   * reported at warn. A dependency on a target in two layers is one here and counts on both pairs.
   */
  totals: { allowed: number; violations: number; warnings: number; skipped: number; uncovered: number; hiddenLayers: number };
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-zA-Z]{3,20})$/;

/** The layer graph of a report evaluated under `config`. */
export function layerGraph(report: ArchReport, config: ArchitectureConfig): LayerGraph {
  const order = new Map(config.layers.map((l, i) => [l.name, i]));
  const hidden = new Set(config.report.hidden);
  const sizes = new Map(report.layers.map((l) => [l.name, l]));

  // A layer's group: the first of `report.groups` that lists it, else its own `group`.
  const groupOf = new Map<string, string>();
  for (const [g, members] of Object.entries(config.report.groups)) for (const l of members) if (!groupOf.has(l)) groupOf.set(l, g);
  for (const l of config.layers) if (l.group && !groupOf.has(l.name)) groupOf.set(l.name, l.group);

  const layers: LayerGraphLayer[] = config.layers.map((l) => ({
    name: l.name,
    overlay: !!l.overlay,
    elements: sizes.get(l.name)?.elements ?? 0,
    files: sizes.get(l.name)?.files ?? 0,
    group: groupOf.get(l.name) ?? null,
    color: l.color && SAFE_COLOR.test(l.color) ? l.color : null,
    hidden: hidden.has(l.name),
    uncovered: sizes.get(l.name)?.uncovered ?? 0,
  }));

  const groups: LayerGraphGroup[] = [];
  for (const l of layers) {
    if (l.group === null) continue;
    let g = groups.find((x) => x.name === l.group);
    if (!g) groups.push(g = { name: l.group, layers: [], pointTo: null });
    g.layers.push(l.name);
    if (config.report.pointToGroups && l.name === l.group && !l.hidden) g.pointTo = l.name;
  }

  const rank = (n: string) => order.get(n) ?? Number.MAX_SAFE_INTEGER;
  const edges: LayerGraphEdge[] = [...report.layerEdges]
    .sort((a, b) => rank(a.from) - rank(b.from) || rank(a.to) - rank(b.to) || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
    .map((e) => ({ from: e.from, to: e.to, allowed: e.allowed, violations: e.violations, warnings: e.warnings, skipped: e.skipped, hidden: hidden.has(e.from) || hidden.has(e.to) }));

  // The totals are the report's own counts, one per finding: a finding counted on two layer pairs
  // (a target in Domain and Shared) is one dependency (review of M5-13), never a sum over pairs.
  const c = report.counts;
  const totals = {
    allowed: c.allowed, violations: c.violation, skipped: c.skipped, uncovered: c.uncovered,
    warnings: report.findings.filter((f) => f.kind === 'violation' && f.severity === 'warn').length,
    hiddenLayers: layers.filter((l) => l.hidden).length,
  };
  return { version: 1, view: config.view, layers, groups, edges, totals };
}

/** How one drawn edge looks: each status of a pair is its own edge. */
export type EdgeStatus = 'allowed' | 'violation' | 'warning' | 'skipped';
export const EDGE_STATUSES: readonly EdgeStatus[] = ['allowed', 'violation', 'warning', 'skipped'];

export interface DrawnEdge { from: string; to: string; status: EdgeStatus; count: number; /** The group it points at, or null. */ toGroup: string | null }

/** The edges a renderer draws: visible pairs, one edge per non-zero status, in graph order. */
export function drawnEdges(graph: LayerGraph): DrawnEdge[] {
  const groupOf = new Map(graph.layers.map((l) => [l.name, l.group]));
  const pointed = new Map(graph.groups.filter((g) => g.pointTo).map((g) => [g.pointTo!, g.name]));
  const out: DrawnEdge[] = [];
  for (const e of graph.edges) {
    if (e.hidden) continue;
    const group = pointed.get(e.to);
    // An edge from inside the group reaches the layer itself (a cluster cannot be its own head).
    const toGroup = group !== undefined && groupOf.get(e.from) !== group ? group : null;
    const counts: Record<EdgeStatus, number> = { allowed: e.allowed, violation: e.violations - e.warnings, warning: e.warnings, skipped: e.skipped };
    for (const status of EDGE_STATUSES) if (counts[status] > 0) out.push({ from: e.from, to: e.to, status, count: counts[status], toGroup });
  }
  return out;
}

/** The colours every renderer uses. */
export const STATUS_COLORS: Record<EdgeStatus, string> = { allowed: '#64748b', violation: '#dc2626', warning: '#d97706', skipped: '#94a3b8' };

/** What each picture leaves out: counts over every layer, hidden ones included (named by number only). */
export function totalsLine(graph: LayerGraph): string {
  const t = graph.totals;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const hidden = t.hiddenLayers ? `; ${plural(t.hiddenLayers, 'hidden layer')} counted, not drawn` : '';
  return `Dependencies: ${t.allowed} allowed, ${plural(t.violations, 'violation')} (${t.warnings} at warn), ${t.skipped} skipped, ${t.uncovered} uncovered${hidden}`;
}

/** Visible layers, in configuration order. */
export const visibleLayers = (graph: LayerGraph) => graph.layers.filter((l) => !l.hidden);

/** Groups with a visible layer, with only their visible layers. */
export function visibleGroups(graph: LayerGraph): LayerGraphGroup[] {
  const shown = new Set(visibleLayers(graph).map((l) => l.name));
  return graph.groups.map((g) => ({ ...g, layers: g.layers.filter((l) => shown.has(l)) })).filter((g) => g.layers.length);
}
