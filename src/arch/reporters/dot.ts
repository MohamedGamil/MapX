// The layer graph as Graphviz DOT (M5-13, AR-16): counts on edges, violations red, warn-level
// violations amber, skipped (baselined) dependencies dashed, groups as clusters, hidden layers left
// out, and point-to-group through `lhead`.
//
// IDs are synthetic (`n0`, `n1` … for layers, `cluster_0` … for groups, numbered in name order), so no
// layer name can mean something to Graphviz as an ID (`%Domain` is an internal name there; review of
// M5-13). Names are labels, quoted by `dotLabel`.
import { dotQuote } from '../../exporters/dot-exporter.js';
import { drawnEdges, STATUS_COLORS, totalsLine, visibleGroups, visibleLayers, type EdgeStatus, type LayerGraph, type LayerGraphLayer } from './graph.js';

const EDGE_ATTRS: Record<EdgeStatus, string> = {
  allowed: '',
  violation: `, color="${STATUS_COLORS.violation}", fontcolor="${STATUS_COLORS.violation}", penwidth=2`,
  warning: `, color="${STATUS_COLORS.warning}", fontcolor="${STATUS_COLORS.warning}"`,
  skipped: `, color="${STATUS_COLORS.skipped}", fontcolor="${STATUS_COLORS.skipped}", style=dashed`,
};

/**
 * A label that Graphviz shows as written: `dotQuote` (which keeps `\N`, `\G` … literal by doubling
 * the backslash) after `&` becomes `&amp;`, since Graphviz decodes entities such as `&lt;` in labels.
 */
export const dotLabel = (s: string) => dotQuote(s.replace(/&/g, '&amp;'));

/** Synthetic IDs for `names`: `${prefix}0`, `${prefix}1` … in code-unit order of the names. */
function ids(prefix: string, names: string[]): Map<string, string> {
  return new Map([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((n, i) => [n, `${prefix}${i}`]));
}

export function renderDot(graph: LayerGraph): string {
  const layers = visibleLayers(graph);
  const groups = visibleGroups(graph);
  const nodeId = ids('n', layers.map((l) => l.name));
  const clusterId = ids('cluster_', groups.map((g) => g.name));
  const node = (l: LayerGraphLayer) => {
    const attrs = [
      `label=${dotLabel(l.name)}`,
      ...(l.color ? [`fillcolor=${dotQuote(l.color)}`] : []),
      ...(l.overlay ? ['style="rounded,filled,dashed"'] : []),
    ];
    return `${nodeId.get(l.name)} [${attrs.join(', ')}];`;
  };
  const lines = [
    'digraph "MapX layers" {',
    `  graph [compound=true, rankdir=TB, label=${dotLabel(totalsLine(graph))}, labelloc=b, fontname="Helvetica", fontsize=10];`,
    '  node [shape=box, style="rounded,filled", fillcolor="#f8fafc", color="#475569", fontname="Helvetica"];',
    `  edge [color="${STATUS_COLORS.allowed}", fontcolor="#475569", fontname="Helvetica", fontsize=10];`,
  ];
  const byName = new Map(layers.map((l) => [l.name, l]));
  for (const g of groups) {
    lines.push('', `  subgraph ${clusterId.get(g.name)} {`, `    label=${dotLabel(g.name)};`, '    labelloc=t;', '    style="rounded,dashed";', '    color="#94a3b8";');
    for (const l of g.layers) lines.push(`    ${node(byName.get(l)!)}`);
    lines.push('  }');
  }
  const loose = layers.filter((l) => l.group === null);
  if (loose.length) lines.push('', ...loose.map((l) => `  ${node(l)}`));
  const edges = drawnEdges(graph);
  if (edges.length) lines.push('');
  for (const e of edges) {
    const head = e.toGroup !== null ? `, lhead=${clusterId.get(e.toGroup)}` : '';
    lines.push(`  ${nodeId.get(e.from)} -> ${nodeId.get(e.to)} [label="${e.count}"${EDGE_ATTRS[e.status]}${head}];`);
  }
  lines.push('}', '');
  return lines.join('\n');
}
