// The layer graph as SVG (M5-13, AR-16). Like `mapx export --format svg`, Graphviz renders the DOT
// when it is installed (`graphvizSvg`); otherwise, or with `graphviz: false`, a built-in renderer
// draws it, so no runtime dependency is needed. The built-in layout is deterministic: one column per
// group (ungrouped layers share one), layers stacked in configuration order, edges as curves
// labelled with their counts (arcs on the right going down a column, on the left going up).
import { escapeXml, graphvizSvg } from '../../exporters/svg-exporter.js';
import { renderDot } from './dot.js';
import { drawnEdges, STATUS_COLORS, totalsLine, visibleGroups, visibleLayers, type EdgeStatus, type LayerGraph } from './graph.js';

export interface SvgOptions {
  /** Use Graphviz when it is installed (default true); false always uses the built-in renderer. */
  graphviz?: boolean;
}

export function renderSvg(graph: LayerGraph, options: SvgOptions = {}): string {
  return (options.graphviz !== false ? graphvizSvg(renderDot(graph)) : null) ?? renderBuiltinSvg(graph);
}

interface Box { x: number; y: number; w: number; h: number; col: number }

const NODE_H = 36;
const V_GAP = 36;
const PAD = 16;
const TITLE = 26;
const COL_GAP = 150;
const MARGIN = 100;
/** How far a curve within a column bows out; its extreme (3/4 of it) stays inside MARGIN. */
const BULGE = 100;
/** How far below the columns a curve that passes a column in between runs. */
const LANE = 50;
const TOP = 30;
const FONT = 'font-family="system-ui, -apple-system, Helvetica, sans-serif"';
const r1 = (n: number) => Number(n.toFixed(1));

export function renderBuiltinSvg(graph: LayerGraph): string {
  const layers = visibleLayers(graph);
  const groups = visibleGroups(graph);
  const nodeW = Math.max(140, Math.ceil(Math.max(0, ...layers.map((l) => l.name.length)) * 7.5) + 32);
  const colW = nodeW + 2 * PAD;

  // Columns: each group where its first layer comes, the ungrouped layers in one column.
  const columns: Array<{ group: string | null; layers: string[] }> = [];
  for (const l of layers) {
    const key = l.group;
    let col = columns.find((c) => c.group === key);
    if (!col) columns.push(col = { group: key, layers: [] });
    if (key === null || col.layers.length === 0) col.layers.push(...(key === null ? [l.name] : groups.find((g) => g.name === key)!.layers));
  }
  const nodes = new Map<string, Box>();
  const groupBoxes = new Map<string, Box>();
  let bottom = TOP;
  columns.forEach((c, ci) => {
    const x = MARGIN + ci * (colW + COL_GAP);
    const head = c.group !== null ? TITLE : 0;
    c.layers.forEach((name, k) => nodes.set(name, { x: x + PAD, y: TOP + head + PAD + k * (NODE_H + V_GAP), w: nodeW, h: NODE_H, col: ci }));
    const h = head + 2 * PAD + c.layers.length * NODE_H + (c.layers.length - 1) * V_GAP;
    if (c.group !== null) groupBoxes.set(c.group, { x, y: TOP, w: colW, h, col: ci });
    bottom = Math.max(bottom, TOP + h);
  });
  // Edges: each end gets its own port on its node's side, spread over the side and ordered by the
  // other end's height, so arrowheads never pile up. Down a column the curve runs on the right, up
  // a column on the left, so a pair both ways never overlaps; across columns it runs side to side.
  const edges = drawnEdges(graph);
  const ends = edges.map((e) => {
    const s = nodes.get(e.from)!;
    const t = e.toGroup !== null ? { ...groupBoxes.get(e.toGroup)!, h: TITLE } : nodes.get(e.to)!;
    const same = s.col === t.col;
    const right = same ? t.y > s.y : t.col > s.col;
    return { s, t, same, right, sKey: `${e.from}\u0000${right ? 'r' : 'l'}`, tKey: `${e.toGroup !== null ? `group\u0000${e.toGroup}` : e.to}\u0000${same === right ? 'r' : 'l'}` };
  });
  const ports = new Map<string, Array<{ i: number; end: 's' | 't'; other: number }>>();
  ends.forEach((x, i) => {
    for (const [key, end, other] of [[x.sKey, 's', x.t.y], [x.tKey, 't', x.s.y]] as const) {
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key)!.push({ i, end, other });
    }
  });
  const portY = new Map<string, number>();
  for (const list of ports.values()) {
    list.sort((a, b) => a.other - b.other || a.i - b.i || (a.end < b.end ? -1 : 1));
    list.forEach((p, k) => {
      const box = p.end === 's' ? ends[p.i]!.s : ends[p.i]!.t;
      portY.set(`${p.i}\u0000${p.end}`, box.y + (box.h * (k + 1)) / (list.length + 1));
    });
  }
  const curves = edges.map((_e, i) => {
    const { s, t, same, right } = ends[i]!;
    const sy = portY.get(`${i}\u0000s`)!;
    const ty = portY.get(`${i}\u0000t`)!;
    const sx = right ? s.x + s.w : s.x;
    if (same) {
      const tx = right ? t.x + t.w : t.x;
      const bulge = (right ? 1 : -1) * Math.min(BULGE, 30 + Math.abs(ty - sy) * 0.2);
      return [sx, sy, sx + bulge, sy, tx + bulge, ty, tx, ty].map(r1);
    }
    const tx = right ? t.x : t.x + t.w;
    // Past a column in between, the curve dips below every column instead of crossing one.
    if (Math.abs(t.col - s.col) > 1) {
      const dir = right ? 1 : -1;
      return [sx, sy, sx + dir * 80, bottom + LANE, tx - dir * 80, bottom + LANE, tx, ty].map(r1);
    }
    const mx = (sx + tx) / 2;
    return [sx, sy, mx, sy, mx, ty, tx, ty].map(r1);
  });
  const lane = ends.some((x) => Math.abs(x.t.col - x.s.col) > 1) ? LANE : 0;

  const totals = totalsLine(graph);
  const width = Math.max(2 * MARGIN + columns.length * colW + Math.max(0, columns.length - 1) * COL_GAP, MARGIN + Math.ceil(totals.length * 6.2) + 20);
  const height = bottom + lane + 50;
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `  <title>${escapeXml(`MapX layers. ${totals}`)}</title>`,
    '  <defs>',
    ...(Object.keys(STATUS_COLORS) as EdgeStatus[]).map((st) => `    <marker id="arrow-${st}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="${STATUS_COLORS[st]}"/></marker>`),
    '  </defs>',
    '  <rect width="100%" height="100%" fill="#ffffff"/>',
  ];
  for (const [name, b] of groupBoxes) {
    out.push(`  <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="6 4"/>`);
    out.push(`  <text x="${b.x + PAD}" y="${b.y + 18}" ${FONT} font-size="12" font-weight="600" fill="#334155">${escapeXml(name)}</text>`);
  }
  edges.forEach((e, i) => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = curves[i] as [number, number, number, number, number, number, number, number];
    const color = STATUS_COLORS[e.status];
    const dash = e.status === 'skipped' ? ' stroke-dasharray="6 4"' : '';
    out.push(`  <path d="M${x0},${y0} C${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="none" stroke="${color}" stroke-width="${e.status === 'violation' ? 2 : 1.4}"${dash} marker-end="url(#arrow-${e.status})"><title>${escapeXml(`${e.from} → ${e.toGroup ?? e.to}: ${e.count} ${e.status}`)}</title></path>`);
    // The count at the curve's midpoint (t = 0.5 of the cubic).
    const lx = r1(0.125 * x0 + 0.375 * x1 + 0.375 * x2 + 0.125 * x3);
    const ly = r1(0.125 * y0 + 0.375 * y1 + 0.375 * y2 + 0.125 * y3);
    out.push(`  <text x="${lx}" y="${r1(ly + 4)}" text-anchor="middle" ${FONT} font-size="11" font-weight="600" fill="${color}" stroke="#ffffff" stroke-width="3" paint-order="stroke">${e.count}</text>`);
  });

  for (const l of layers) {
    const b = nodes.get(l.name)!;
    const dash = l.overlay ? ' stroke-dasharray="4 4"' : '';
    out.push(`  <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${escapeXml(l.color ?? '#f8fafc')}" stroke="#475569" stroke-width="1.2"${dash}/>`);
    out.push(`  <text x="${r1(b.x + b.w / 2)}" y="${b.y + b.h / 2 + 4}" text-anchor="middle" ${FONT} font-size="13" fill="#0f172a">${escapeXml(l.name)}</text>`);
  }
  out.push(`  <text x="${MARGIN}" y="${height - 18}" ${FONT} font-size="11" fill="#475569">${escapeXml(totals)}</text>`);
  out.push('</svg>', '');
  return out.join('\n');
}
