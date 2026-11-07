// The layer DSM (M5-13, AR-16): a layer × layer matrix whose cells are the dependencies `mapx
// check` counted, marked by their worst status. The text is printed by the same `formatDsmText`
// as the cluster DSM of `mapx arch --dsm`; hidden layers are left out, and counted in the totals.
import { formatDsmText } from '../../core/metrics.js';
import { totalsLine, visibleLayers, type LayerGraph } from './graph.js';

export type DsmCellStatus = 'none' | 'allowed' | 'violation' | 'warning' | 'skipped';

export interface LayerDsm {
  /** Visible layers, in configuration order: rows depend on columns. */
  layers: string[];
  /** Dependencies from row to column: allowed, violating and skipped. */
  matrix: number[][];
  /** The cell's worst status: violation (error), then warning (warn-level violation), skipped, allowed. */
  status: DsmCellStatus[][];
}

export function layerDsm(graph: LayerGraph): LayerDsm {
  const layers = visibleLayers(graph).map((l) => l.name);
  const index = new Map(layers.map((l, i) => [l, i]));
  const matrix = layers.map(() => layers.map(() => 0));
  const status = layers.map(() => layers.map((): DsmCellStatus => 'none'));
  for (const e of graph.edges) {
    const i = index.get(e.from);
    const j = index.get(e.to);
    if (i === undefined || j === undefined) continue;
    matrix[i]![j] = e.allowed + e.violations + e.skipped;
    status[i]![j] = e.violations > e.warnings ? 'violation' : e.warnings ? 'warning' : e.skipped ? 'skipped' : e.allowed ? 'allowed' : 'none';
  }
  return { layers, matrix, status };
}

const MARK: Record<DsmCellStatus, string> = { none: '', allowed: '', violation: '!', warning: '~', skipped: 's' };

export function renderLayerDsm(graph: LayerGraph): string {
  const dsm = layerDsm(graph);
  if (!dsm.layers.length) return `No layer to show.\n${totalsLine(graph)}\n`;
  const text = formatDsmText(dsm.layers, dsm.matrix, {
    title: '── Layer Dependency Structure Matrix (DSM) ────────────',
    prefix: 'L',
    legend: [
      'number = dependencies from row layer to column layer',
      '! = violations, ~ = warn-level violations only, s = skipped (baselined) violations only',
    ],
    keyTitle: 'Layer Key:',
    alignRows: true,
    cell: (i, j, n) => `${n}${MARK[dsm.status[i]![j]!]}`,
  });
  return `${text}\n\n${totalsLine(graph)}\n`;
}
