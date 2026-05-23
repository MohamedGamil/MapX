import { Store } from './store.js';

export interface FileMetrics {
  path: string;
  language: string;
  afferent: number;
  efferent: number;
  instability: number;
}

export function calculateMetrics(
  store: Store,
  options: { repo?: string; language?: string; verifiedOnly?: boolean } = {}
): FileMetrics[] {
  const files = store.getAllFiles(options.repo);
  const edges = store.getAllEdges(options.repo);

  const afferentMap = new Map<string, Set<string>>();
  const efferentMap = new Map<string, Set<string>>();

  for (const f of files) {
    afferentMap.set(f.path as string, new Set());
    efferentMap.set(f.path as string, new Set());
  }

  for (const e of edges) {
    if (options.verifiedOnly && e.verifiability === 'inferred') {
      continue;
    }
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
    const lang = f.language as string;

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
