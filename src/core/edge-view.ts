// JSON shapes of stored edges for `mapx edges --format json` and mapx_edges: the flat list without a
// file (M0-03-R2) and F04's incoming / outgoing neighbourhood of one file (D012, M0-03-R3).
import { isAbsolute, relative, resolve } from 'node:path';

export interface EdgeView {
  sourceFile: string;
  sourceSymbol: string | null;
  targetFile: string;
  targetSymbol: string | null;
  type: string;
  verifiability: string;
  weight: number;
  targetRepo: string | null;
  metadata: Record<string, unknown>;
}

export function edgeView(e: Record<string, unknown>): EdgeView {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = e.metadata ? JSON.parse(e.metadata as string) : {};
  } catch {
    // keep {}
  }
  return {
    sourceFile: e.source_file as string,
    sourceSymbol: (e.source_symbol as string | null) ?? null,
    targetFile: e.target_file as string,
    targetSymbol: (e.target_symbol as string | null) ?? null,
    type: e.edge_type as string,
    verifiability: (e.verifiability as string | null) ?? 'verified',
    weight: Number(e.weight ?? 1),
    targetRepo: (e.target_repo as string | null) ?? null,
    metadata,
  };
}

export type EdgeDirection = 'incoming' | 'outgoing' | 'both';

/** Shared by both directions of `FileEdges` (D012). */
interface FileEdgeBase {
  type: string;
  sourceSymbol: string | null;
  targetSymbol: string | null;
  verifiability: string;
  weight: number;
  line: number | null;
}
export interface IncomingEdge extends FileEdgeBase { sourceFile: string }
export interface OutgoingEdge extends FileEdgeBase { targetFile: string; targetRepo: string | null }

/** `mapx edges <file> --format json` / mapx_edges with a file: F04's shape with camelCase keys (D012). */
export interface FileEdges {
  file: string;
  direction: EdgeDirection;
  incoming: IncomingEdge[];
  outgoing: OutgoingEdge[];
}

/** A direction must be one of F04's three and only goes with a file (M0-03-R3: it used to be ignored without one). */
export function directionError(direction: unknown, hasFile: boolean): string | null {
  if (direction === undefined || direction === null) return null;
  if (!['outgoing', 'incoming', 'both'].includes(String(direction))) {
    return `Unknown direction "${String(direction)}" (use outgoing, incoming or both).`;
  }
  if (!hasFile) return 'direction applies to one file\'s edges: pass a file (mapx edges <file> --direction …, or mapx_edges with file).';
  return null;
}

/** Splits `queryEdges({ file, direction })` rows into F04's incoming / outgoing lists. A self-edge is in both. */
export function fileEdges(file: string, direction: EdgeDirection, rows: Record<string, unknown>[]): FileEdges {
  const result: FileEdges = { file, direction, incoming: [], outgoing: [] };
  for (const row of rows) {
    const v = edgeView(row);
    const line = v.metadata.startLine ?? v.metadata.line;
    const base = {
      type: v.type,
      sourceSymbol: v.sourceSymbol,
      targetSymbol: v.targetSymbol,
      verifiability: v.verifiability,
      weight: v.weight,
      line: typeof line === 'number' ? line : null,
    };
    if (direction !== 'outgoing' && v.targetFile === file) result.incoming.push({ sourceFile: v.sourceFile, ...base });
    if (direction !== 'incoming' && v.sourceFile === file) result.outgoing.push({ targetFile: v.targetFile, targetRepo: v.targetRepo, ...base });
  }
  return result;
}

/** F04's text rendering: `Incoming (n)` / `Outgoing (n)` sections, or one line when there is nothing to show. */
export function formatFileEdgesText(edges: FileEdges): string {
  if (edges.incoming.length === 0 && edges.outgoing.length === 0) {
    const which = edges.direction === 'both' ? '' : ` ${edges.direction}`;
    return `No${which} edges for ${edges.file}.`;
  }
  const row = (arrow: string, file: string, e: FileEdgeBase, repo?: string | null) =>
    `    ${arrow} ${repo ? `${repo}:` : ''}${file}  [${e.type}]${e.targetSymbol ? `  ${e.targetSymbol}` : ''}` +
    (e.verifiability === 'inferred' ? '  (inferred)' : '');
  const lines = [`Edges for: ${edges.file}`];
  if (edges.direction !== 'outgoing') {
    lines.push('', `  Incoming (${edges.incoming.length}):`, ...edges.incoming.map(e => row('←', e.sourceFile, e)));
  }
  if (edges.direction !== 'incoming') {
    lines.push('', `  Outgoing (${edges.outgoing.length}):`, ...edges.outgoing.map(e => row('→', e.targetFile, e, e.targetRepo)));
  }
  return lines.join('\n');
}

/** A file argument as the index stores it: workspace-relative with `/` separators. */
export function indexedPath(dir: string, file: string): string {
  const rel = isAbsolute(file) ? relative(resolve(dir), file) : file;
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}
