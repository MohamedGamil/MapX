import picomatch from 'picomatch';
import { Store } from './store.js';

export interface FileMetrics {
  path: string;
  language: string;
  afferent: number;
  efferent: number;
  instability: number;
}

export interface MetricsOptions {
  repo?: string;
  language?: string;
  verifiedOnly?: boolean;
  /** Globs, or bare path segments as in `scan --exclude`: matching files and their edges are left out (M0-03-R3). */
  exclude?: string[];
}

function excludeMatcher(patterns: string[] = []): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  return (path: string) =>
    patterns.some(p => picomatch.isMatch(path, p, { dot: true }) || path.split('/').includes(p));
}

/** Files and edges the metrics are computed on: the repo minus excluded files, inferred edges dropped on request. */
function metricsGraph(store: Store, options: MetricsOptions) {
  const excluded = excludeMatcher(options.exclude);
  const files = store.getAllFiles(options.repo).filter(f => !excluded(f.path as string));
  const edges = store.getAllEdges(options.repo).filter(e =>
    !(options.verifiedOnly && e.verifiability === 'inferred') &&
    !excluded(e.source_file as string) && !excluded(e.target_file as string));
  return { files, edges };
}

export function calculateMetrics(store: Store, options: MetricsOptions = {}): FileMetrics[] {
  const { files, edges } = metricsGraph(store, options);

  const afferentMap = new Map<string, Set<string>>();
  const efferentMap = new Map<string, Set<string>>();

  for (const f of files) {
    afferentMap.set(f.path as string, new Set());
    efferentMap.set(f.path as string, new Set());
  }

  for (const e of edges) {
    const src = e.source_file as string;
    const tgt = e.target_file as string;

    if (src === tgt) continue;

    if (afferentMap.has(tgt)) {
      afferentMap.get(tgt)!.add(src);
    }
    if (efferentMap.has(src)) {
      efferentMap.get(src)!.add(tgt);
    }
  }

  const results: FileMetrics[] = [];
  for (const f of files) {
    const path = f.path as string;
    const lang = (f.language as string | null) ?? '';

    if (options.language && lang.toLowerCase() !== options.language.toLowerCase()) {
      continue;
    }

    const ca = afferentMap.get(path)?.size || 0;
    const ce = efferentMap.get(path)?.size || 0;
    const sum = ca + ce;
    const instability = sum > 0 ? ce / sum : 0.0;

    results.push({
      path,
      language: lang,
      afferent: ca,
      efferent: ce,
      instability,
    });
  }

  return results.sort((a, b) => b.instability - a.instability || b.afferent - a.afferent || a.path.localeCompare(b.path));
}

export interface RankedFileMetrics extends FileMetrics {
  /** Ca + Ce: distinct files depending on this one plus files it depends on. */
  totalDegree: number;
  pagerank: number;
}

/**
 * Metrics ranked by total degree (then PageRank, then path), each with its PageRank; `top` keeps
 * the first N. Used by `mapx metrics --format json / --top` and mapx_metrics (M0-03-R2).
 */
export function rankMetrics(metrics: FileMetrics[], pagerank: Map<string, number>, top?: number): RankedFileMetrics[] {
  const ranked = metrics
    .map(m => ({ ...m, totalDegree: m.afferent + m.efferent, pagerank: pagerank.get(m.path) ?? 0 }))
    .sort((a, b) => b.totalDegree - a.totalDegree || b.pagerank - a.pagerank || a.path.localeCompare(b.path));
  return top && top > 0 ? ranked.slice(0, top) : ranked;
}

/** One file row of `mapx metrics --format json` / mapx_metrics (D012). */
export interface MetricsFileRow {
  path: string;
  language: string;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
  instability: number;
  pagerank: number;
}

/** `mapx metrics --format json` / mapx_metrics: F02's envelope with camelCase keys (D012). */
export interface MetricsReport {
  dir: string;
  generatedAt: string;
  summary: { files: number; edges: number; density: number };
  files: MetricsFileRow[];
}

/** Default number of rows (F02). */
export const METRICS_DEFAULT_TOP = 20;

/**
 * `--top` / `top` as a row count: a whole number >= 0, 0 meaning every file. Anything else is an
 * error message (M0-03-R3: `abc` and `-1` used to be silent no-ops).
 */
export function parseTop(value: unknown): number | { error: string } {
  if (value === undefined || value === null || value === '') return METRICS_DEFAULT_TOP;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return { error: `Invalid top value "${String(value)}": expected a whole number >= 0 (0 lists every file).` };
  return Number(text);
}

/** Output format of metrics and edges: `text` (alias `llm`, the F02/F04 name) or `json`. */
export function parseFormat(value: unknown, fallback: 'text' | 'json'): 'text' | 'json' | { error: string } {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).toLowerCase();
  if (v === 'json') return 'json';
  if (v === 'text' || v === 'llm') return 'text';
  return { error: `Unknown format "${String(value)}": use text or json.` };
}

/**
 * The D012 metrics report. `summary` describes the graph the degrees are computed on (repo files and
 * edges after `exclude` / `verifiedOnly`); `language` and `top` only select rows. `total` is the row
 * count before `top`, for the text footer.
 */
export function buildMetricsReport(
  store: Store,
  pagerank: Map<string, number>,
  options: MetricsOptions & { dir: string; top?: number },
): { report: MetricsReport; total: number } {
  const ranked = rankMetrics(calculateMetrics(store, options), pagerank);
  const { files, edges } = metricsGraph(store, options);
  const n = files.length;
  // Density counts distinct directed file pairs (no self-pairs), so several symbol-level edges between
  // the same two files count once and the value stays in [0, 1]. `edges` stays the raw edge-row count.
  const paths = new Set(files.map(f => f.path as string));
  const pairs = new Set(edges
    .filter(e => e.source_file !== e.target_file && paths.has(e.source_file as string) && paths.has(e.target_file as string))
    .map(e => `${e.source_file}\0${e.target_file}`));
  const top = options.top ?? METRICS_DEFAULT_TOP;
  return {
    total: ranked.length,
    report: {
      dir: options.dir,
      generatedAt: new Date().toISOString(),
      summary: { files: n, edges: edges.length, density: n > 1 ? Number((pairs.size / (n * (n - 1))).toPrecision(3)) : 0 },
      files: (top > 0 ? ranked.slice(0, top) : ranked).map(m => ({
        path: m.path,
        language: m.language,
        inDegree: m.afferent,
        outDegree: m.efferent,
        totalDegree: m.totalDegree,
        instability: Number(m.instability.toFixed(4)),
        pagerank: Number(m.pagerank.toPrecision(4)),
      })),
    },
  };
}

/** F02's text rendering of a metrics report. `total` is the row count before `top`; `lastScan` an ISO time. */
export function formatMetricsText(report: MetricsReport, total: number, lastScan?: string | null): string {
  const scan = lastScan ? `   (last scan: ${lastScan.replace('T', ' ').slice(0, 16)})` : '';
  const { files, edges, density } = report.summary;
  const width = Math.max(4, ...report.files.map(f => f.path.length)) + 2;
  const header = `  RANK  ${'FILE'.padEnd(width)}${'IN'.padStart(4)}${'OUT'.padStart(5)}${'TOTAL'.padStart(7)}  INSTABILITY`;
  const lines = [
    `Metrics for: ${report.dir}${scan}`,
    `Files: ${files} | Edges: ${edges} | Graph density: ${density}`,
    '',
    'Top coupled files (by total degree):',
    '',
    header,
    `  ${'─'.repeat(header.length - 2)}`,
    ...report.files.map((f, i) =>
      `${String(i + 1).padStart(6)}  ${f.path.padEnd(width)}${String(f.inDegree).padStart(4)}${String(f.outDegree).padStart(5)}` +
      `${String(f.totalDegree).padStart(7)}${f.instability.toFixed(2).padStart(9)}`),
  ];
  if (total > report.files.length) lines.push(`  ... ${total - report.files.length} more (--top 0 lists every file)`);
  lines.push(
    '',
    'Instability = out / (in + out).  Range: 0 (stable) → 1 (unstable).',
    'High in-degree  → depended-on bottleneck.',
    'High out-degree → many outgoing deps (potential God Class / low cohesion).',
  );
  return lines.join('\n');
}

export interface GraphMetrics {
  density: number;
  transitivity: number;
}

export function calculateGraphMetrics(store: Store, repo?: string): GraphMetrics {
  const files = store.getAllFiles(repo);
  const edges = store.getAllEdges(repo);

  const fileCount = files.length;
  const edgeCount = edges.length;

  const density = fileCount > 1 ? edgeCount / (fileCount * (fileCount - 1)) : 0;

  // Adjacency list for transitivity
  const adj = new Map<string, Set<string>>();
  for (const f of files) {
    adj.set(f.path as string, new Set());
  }

  for (const e of edges) {
    const src = e.source_file as string;
    const tgt = e.target_file as string;
    if (!src || !tgt || src === tgt) continue;
    
    if (!adj.has(src)) adj.set(src, new Set());
    if (!adj.has(tgt)) adj.set(tgt, new Set());

    adj.get(src)!.add(tgt);
    adj.get(tgt)!.add(src);
  }

  let totalTriplets = 0;
  let closedTriplets = 0;

  for (const neighbors of adj.values()) {
    const k = neighbors.size;
    if (k < 2) continue;
    totalTriplets += (k * (k - 1)) / 2;

    const neighborArr = Array.from(neighbors);
    for (let i = 0; i < neighborArr.length; i++) {
      for (let j = i + 1; j < neighborArr.length; j++) {
        const u = neighborArr[i];
        const w = neighborArr[j];
        if (adj.get(u)?.has(w)) {
          closedTriplets++;
        }
      }
    }
  }

  const transitivity = totalTriplets > 0 ? (closedTriplets / totalTriplets) : 0;

  return { density, transitivity };
}

export interface ClusterMetrics {
  clusterName: string;
  fileCount: number;
  afferentCoupling: number;
  efferentCoupling: number;
  instability: number;
  internalEdges: number;
  externalEdges: number;
  cohesionRatio: number;
  abstractness: number;
  distanceFromMainSeq: number;
}

export interface DependencyMatrix {
  clusterNames: string[];
  matrix: number[][];
  dominantTypes: string[][];
}

export interface DsmTextOptions {
  /** The heading line(s) printed first. */
  title: string;
  /** Row and column key prefix: `C1`, `C2` … for clusters, `L1` … for layers. */
  prefix: string;
  /** Legend lines after `* = self` and `. = no dependency`. */
  legend: string[];
  keyTitle: string;
  /** A non-empty off-diagonal cell's text (at most 4 characters); its count by default. */
  cell?: (row: number, col: number, value: number) => string;
  /**
   * Pad the row labels (`L1 Name`) to the widest one. The cluster DSM pads to the widest name
   * alone, so a long name pushes its row out of line; its output is kept as it was.
   */
  alignRows?: boolean;
}

/**
 * A DSM as text: the matrix with keyed headers, the legend and the key. `mapx arch --dsm` (cluster
 * DSM) and `mapx arch graph --format dsm` (layer DSM, M5-13) both print through it.
 */
export function formatDsmText(names: string[], matrix: number[][], opts: DsmTextOptions): string {
  const lines = [opts.title];
  const maxLength = Math.max(...names.map((n, i) => (opts.alignRows ? `${opts.prefix}${i + 1} ${n}` : n).length), 5);
  // Every column is as wide as the widest cell or key, at least 4: the matrices people read keep
  // their layout, and a large count (`1234!`) no longer shifts its row (review of M5-13).
  const text = matrix.map((row, i) => row.map((val, j) => (i === j ? '*' : val === 0 ? '.' : opts.cell ? opts.cell(i, j, val) : val.toString())));
  const w = Math.max(4, ...names.map((_, idx) => `${opts.prefix}${idx + 1}`.length), ...text.flat().map((t) => t.length));
  const headers = [''.padEnd(maxLength), ...names.map((_, idx) => `${opts.prefix}${idx + 1}`.padStart(w))].join(' ');
  lines.push(headers, '-'.repeat(headers.length));
  names.forEach((name, i) => {
    const cells = text[i]!.map((t) => t.padStart(w)).join(' ');
    lines.push(`${`${opts.prefix}${i + 1} ${name}`.padEnd(maxLength)} ${cells}`);
  });
  lines.push(`\nLegend:\n  * = self\n  . = no dependency${opts.legend.map((l) => `\n  ${l}`).join('')}`);
  lines.push(`\n${opts.keyTitle}`);
  names.forEach((name, idx) => lines.push(`  ${opts.prefix}${idx + 1}: ${name}`));
  return lines.join('\n');
}

export function calculateClusterMetrics(store: Store, repo: string): ClusterMetrics[] {
  // Query all clusters for the repo
  const clusters = store.raw.prepare('SELECT name, source FROM clusters WHERE repo = ?').all(repo) as any[];
  // Query all memberships
  const memberships = store.raw.prepare('SELECT file_path, cluster_name FROM cluster_membership WHERE repo = ? AND is_primary = 1').all(repo) as any[];
  
  // File to cluster mapping
  const fileToCluster = new Map<string, string>();
  const clusterToFiles = new Map<string, string[]>();
  for (const m of memberships) {
    fileToCluster.set(m.file_path, m.cluster_name);
    if (!clusterToFiles.has(m.cluster_name)) {
      clusterToFiles.set(m.cluster_name, []);
    }
    clusterToFiles.get(m.cluster_name)!.push(m.file_path);
  }

  const edges = store.getAllEdges(repo);
  const results: ClusterMetrics[] = [];

  for (const c of clusters) {
    const cName = c.name;
    const cFiles = clusterToFiles.get(cName) || [];
    
    // Compute internal and external edges
    let internalEdges = 0;
    let externalEdges = 0;
    
    const afferentClusters = new Set<string>();
    const efferentClusters = new Set<string>();

    for (const e of edges) {
      const src = e.source_file as string;
      const tgt = e.target_file as string;
      const srcComm = fileToCluster.get(src);
      const tgtComm = fileToCluster.get(tgt);

      if (srcComm === cName && tgtComm === cName) {
        internalEdges++;
      } else if (srcComm === cName && tgtComm && tgtComm !== cName) {
        externalEdges++;
        efferentClusters.add(tgtComm);
      } else if (tgtComm === cName && srcComm && srcComm !== cName) {
        externalEdges++;
        afferentClusters.add(srcComm);
      }
    }

    const afferentCoupling = afferentClusters.size;
    const efferentCoupling = efferentClusters.size;
    const sum = afferentCoupling + efferentCoupling;
    const instability = sum > 0 ? efferentCoupling / sum : 0.0;

    const totalEdges = internalEdges + externalEdges;
    const cohesionRatio = totalEdges > 0 ? internalEdges / totalEdges : 1.0;

    // Abstractness: interfaces/traits ratio in this cluster
    let totalSymbols = 0;
    let abstractSymbols = 0;
    for (const filePath of cFiles) {
      const symbols = store.getSymbolsForFile(filePath);
      totalSymbols += symbols.length;
      abstractSymbols += symbols.filter(s => s.kind === 'interface' || s.kind === 'trait').length;
    }

    const abstractness = totalSymbols > 0 ? abstractSymbols / totalSymbols : 0.0;
    const distanceFromMainSeq = Math.abs(abstractness + instability - 1);

    results.push({
      clusterName: cName,
      fileCount: cFiles.length,
      afferentCoupling,
      efferentCoupling,
      instability,
      internalEdges,
      externalEdges,
      cohesionRatio,
      abstractness,
      distanceFromMainSeq
    });
  }

  return results;
}

export function calculateDSM(store: Store, repo: string): DependencyMatrix {
  const clusters = store.raw.prepare('SELECT name FROM clusters WHERE repo = ?').all(repo) as any[];
  const clusterNames = clusters.map(c => c.name).sort();
  
  const clusterIndex = new Map<string, number>();
  clusterNames.forEach((name, idx) => clusterIndex.set(name, idx));

  const matrix: number[][] = Array.from({ length: clusterNames.length }, () => Array(clusterNames.length).fill(0));
  const typesMap: Record<string, Record<string, number>> = {};

  const memberships = store.raw.prepare('SELECT file_path, cluster_name FROM cluster_membership WHERE repo = ? AND is_primary = 1').all(repo) as any[];
  const fileToCluster = new Map<string, string>();
  for (const m of memberships) {
    fileToCluster.set(m.file_path, m.cluster_name);
  }

  const edges = store.getAllEdges(repo);
  for (const e of edges) {
    const srcComm = fileToCluster.get(e.source_file as string);
    const tgtComm = fileToCluster.get(e.target_file as string);

    if (srcComm && tgtComm && srcComm !== tgtComm) {
      const srcIdx = clusterIndex.get(srcComm);
      const tgtIdx = clusterIndex.get(tgtComm);

      if (srcIdx !== undefined && tgtIdx !== undefined) {
        matrix[srcIdx][tgtIdx]++;
        const cellKey = `${srcIdx}->${tgtIdx}`;
        if (!typesMap[cellKey]) {
          typesMap[cellKey] = {};
        }
        const edgeType = (e.edge_type as string) || 'call';
        typesMap[cellKey][edgeType] = (typesMap[cellKey][edgeType] || 0) + 1;
      }
    }
  }

  const dominantTypes: string[][] = Array.from({ length: clusterNames.length }, () => Array(clusterNames.length).fill(''));
  for (const [cellKey, counts] of Object.entries(typesMap)) {
    const [srcIdx, tgtIdx] = cellKey.split('->').map(Number);
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (dominant) {
      dominantTypes[srcIdx][tgtIdx] = dominant[0];
    }
  }

  return {
    clusterNames,
    matrix,
    dominantTypes,
  };
}
