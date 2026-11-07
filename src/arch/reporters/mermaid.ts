// The layer graph as a Mermaid flowchart (M5-13, AR-16; Deptrac's mermaidjs): `-->|count|` edges,
// violations red and warn-level ones amber through `linkStyle`, skipped dependencies dotted
// (`-.->`), groups as subgraphs (an edge can point at one), hidden layers left out.
//
// Mermaid IDs are derived from names (`layer_Http_Api`): anything but [A-Za-z0-9] becomes `_`, a
// clash takes `_2`, `_3` … in configuration order, and the prefix keeps keywords (`end`) out.
// Labels are quoted with Mermaid's entity codes for `#`, `"`, `<`, `>`, `&` and backticks.
import { drawnEdges, STATUS_COLORS, totalsLine, visibleGroups, visibleLayers, type EdgeStatus, type LayerGraph, type LayerGraphLayer } from './graph.js';

/** A quoted Mermaid label: `["…"]` content. */
export function mermaidLabel(s: string): string {
  const text = s
    .replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/&/g, '#amp;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/`/g, '#96;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ');
  return `"${text}"`;
}

/** Stable, distinct Mermaid IDs for `names` (in order) under `prefix`. */
export function mermaidIds(prefix: string, names: string[], taken = new Set<string>()): Map<string, string> {
  const ids = new Map<string, string>();
  for (const name of names) {
    const base = `${prefix}_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    ids.set(name, id);
  }
  return ids;
}

const LINK_STYLE: Record<EdgeStatus, string | null> = {
  allowed: null,
  violation: `stroke:${STATUS_COLORS.violation},stroke-width:2px,color:${STATUS_COLORS.violation}`,
  warning: `stroke:${STATUS_COLORS.warning},color:${STATUS_COLORS.warning}`,
  skipped: `stroke:${STATUS_COLORS.skipped},color:${STATUS_COLORS.skipped}`,
};

export function renderMermaid(graph: LayerGraph): string {
  const layers = visibleLayers(graph);
  const groups = visibleGroups(graph);
  const taken = new Set<string>();
  const layerId = mermaidIds('layer', layers.map((l) => l.name), taken);
  const groupId = mermaidIds('group', groups.map((g) => g.name), taken);
  const node = (l: LayerGraphLayer) => `${layerId.get(l.name)}[${mermaidLabel(l.name)}]`;

  const lines = ['flowchart TB', `  %% ${totalsLine(graph)}`];
  const byName = new Map(layers.map((l) => [l.name, l]));
  for (const g of groups) {
    lines.push(`  subgraph ${groupId.get(g.name)}[${mermaidLabel(g.name)}]`);
    for (const l of g.layers) lines.push(`    ${node(byName.get(l)!)}`);
    lines.push('  end');
  }
  for (const l of layers) if (l.group === null) lines.push(`  ${node(l)}`);

  const styles: string[] = [];
  drawnEdges(graph).forEach((e, i) => {
    const to = e.toGroup !== null ? groupId.get(e.toGroup)! : layerId.get(e.to)!;
    lines.push(`  ${layerId.get(e.from)} ${e.status === 'skipped' ? '-.->' : '-->'}|${e.count}| ${to}`);
    if (LINK_STYLE[e.status]) styles.push(`  linkStyle ${i} ${LINK_STYLE[e.status]}`);
  });
  lines.push(...styles);
  for (const l of layers) {
    const style = [...(l.color ? [`fill:${l.color}`] : []), ...(l.overlay ? ['stroke-dasharray:4 4'] : [])];
    if (style.length) lines.push(`  style ${layerId.get(l.name)} ${style.join(',')}`);
  }
  lines.push('');
  return lines.join('\n');
}
