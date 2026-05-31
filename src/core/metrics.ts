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
