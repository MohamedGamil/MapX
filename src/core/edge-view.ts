// JSON shape of a stored edge for `mapx edges --format json` and mapx_edges (M0-03-R2).
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

/** A file argument as the index stores it: workspace-relative with `/` separators. */
export function indexedPath(dir: string, file: string): string {
  const rel = isAbsolute(file) ? relative(resolve(dir), file) : file;
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}
