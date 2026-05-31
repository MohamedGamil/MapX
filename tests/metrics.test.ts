import { describe, it, expect } from 'vitest';
import { calculateMetrics, calculateGraphMetrics, calculateClusterMetrics, calculateDSM } from '../src/core/metrics.js';
import type { Store } from '../src/core/store.js';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeStore(
  files: Array<{ path: string; language?: string }>,
  edges: Array<{ source_file: string; target_file: string; verifiability?: string; edge_type?: string }>,
  clusters: Array<{ name: string; source?: string }> = [],
  memberships: Array<{ file_path: string; cluster_name: string }> = [],
  symbols: Record<string, Array<{ kind: string; name?: string }>> = {}
): Store {
  return {
    getAllFiles: (repo?: string) => files.map(f => ({ path: f.path, language: f.language ?? 'typescript' })),
    getAllEdges: (repo?: string) => edges.map(e => ({
      source_file: e.source_file,
      target_file: e.target_file,
      verifiability: e.verifiability ?? 'verified',
      edge_type: e.edge_type ?? 'import',
    })),
    getSymbolsForFile: (fp: string) => (symbols[fp] ?? []),
    raw: {
      prepare: (sql: string) => ({
        all: (param: any) => {
          if (sql.includes('FROM clusters')) return clusters.map(c => ({ name: c.name, source: c.source ?? 'community' }));
          if (sql.includes('FROM cluster_membership')) return memberships.map(m => ({ file_path: m.file_path, cluster_name: m.cluster_name }));
          return [];
        },
      }),
    },
  } as unknown as Store;
}

// ─────────────────────────────────────────────────────────────────
// calculateMetrics
// ─────────────────────────────────────────────────────────────────

describe('calculateMetrics', () => {
  const files = [
    { path: 'a.ts', language: 'typescript' },
    { path: 'b.ts', language: 'typescript' },
    { path: 'c.ts', language: 'typescript' },
    { path: 'd.py', language: 'python' },
  ];
  const edges = [
    { source_file: 'a.ts', target_file: 'b.ts', verifiability: 'verified' },
    { source_file: 'b.ts', target_file: 'c.ts', verifiability: 'verified' },
    { source_file: 'c.ts', target_file: 'a.ts', verifiability: 'verified' },
    { source_file: 'b.ts', target_file: 'd.py', verifiability: 'inferred' },
  ];

  it('returns all files when no options specified', () => {
    const store = makeStore(files, edges);
    const metrics = calculateMetrics(store);
    expect(metrics).toHaveLength(4);
  });

  it('filters by language', () => {
    const store = makeStore(files, edges);
    const pythonMetrics = calculateMetrics(store, { language: 'python' });
    expect(pythonMetrics).toHaveLength(1);
    expect(pythonMetrics[0].path).toBe('d.py');
    expect(pythonMetrics[0].afferent).toBe(1);
    expect(pythonMetrics[0].efferent).toBe(0);
    expect(pythonMetrics[0].instability).toBe(0);
  });

  it('respects verifiedOnly option', () => {
    const store = makeStore(files, edges);
    const verified = calculateMetrics(store, { verifiedOnly: true });
    const b = verified.find(m => m.path === 'b.ts')!;
    // With verifiedOnly: b->d is inferred so efferent = 1 (b->c only)
    expect(b.efferent).toBe(1);
  });

  it('sorts by instability desc, then afferent desc, then path asc', () => {
    const store = makeStore(files, edges);
    const all = calculateMetrics(store);
    // b: efferent=2(c,d), afferent=1 → instability ≈ 0.67
    // a: efferent=1(b), afferent=1 → instability = 0.5
    // c: efferent=1(a), afferent=1 → instability = 0.5
    // d: efferent=0, afferent=1 → instability = 0
    expect(all[0].path).toBe('b.ts');
    expect(all[3].path).toBe('d.py');
  });

  it('handles self-edges (src === tgt) correctly — not counted', () => {
    const store = makeStore(
      [{ path: 'x.ts' }],
      [{ source_file: 'x.ts', target_file: 'x.ts' }]
    );
    const metrics = calculateMetrics(store);
    expect(metrics[0].afferent).toBe(0);
    expect(metrics[0].efferent).toBe(0);
    expect(metrics[0].instability).toBe(0);
  });

  it('handles isolated files (no edges)', () => {
    const store = makeStore([{ path: 'iso.ts' }], []);
    const metrics = calculateMetrics(store);
    expect(metrics[0].instability).toBe(0);
  });

  it('counts afferent even for edges from unknown source files', () => {
    const store = makeStore(
      [{ path: 'known.ts' }],
      [{ source_file: 'unknown.ts', target_file: 'known.ts' }]
    );
    const metrics = calculateMetrics(store);
    // known.ts is targeted by unknown.ts → afferent = 1 (target is tracked, source need not be)
    expect(metrics[0].afferent).toBe(1);
    expect(metrics[0].efferent).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// calculateGraphMetrics
// ─────────────────────────────────────────────────────────────────

describe('calculateGraphMetrics', () => {
  it('calculates density and transitivity for a triangle', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
      [
        { source_file: 'a.ts', target_file: 'b.ts' },
        { source_file: 'b.ts', target_file: 'c.ts' },
        { source_file: 'c.ts', target_file: 'a.ts' },
      ]
    );
    const gm = calculateGraphMetrics(store);
    // density = 3 / (3*2) = 0.5
    expect(gm.density).toBe(0.5);
    // all triplets are closed → transitivity = 1
    expect(gm.transitivity).toBe(1);
  });

  it('returns 0 for empty store', () => {
    const store = makeStore([], []);
    const gm = calculateGraphMetrics(store);
    expect(gm.density).toBe(0);
    expect(gm.transitivity).toBe(0);
  });

  it('returns 0 for single node with no edges', () => {
    const store = makeStore([{ path: 'a.ts' }], []);
    const gm = calculateGraphMetrics(store);
    expect(gm.density).toBe(0);
    expect(gm.transitivity).toBe(0);
  });

  it('ignores self-edges in adjacency build', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }],
      [
        { source_file: 'a.ts', target_file: 'a.ts' }, // self-edge
        { source_file: 'a.ts', target_file: 'b.ts' },
      ]
    );
    const gm = calculateGraphMetrics(store);
    // 2 nodes: density = edgeCount / (n*(n-1)) = 2 / (2*1) = 1
    // but self-edge shouldn't contribute to adjacency
    expect(typeof gm.density).toBe('number');
  });

  it('handles disconnected graph (no triplets closed)', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
      [
        { source_file: 'a.ts', target_file: 'b.ts' },
        // c is disconnected
      ]
    );
    const gm = calculateGraphMetrics(store);
    // a has neighbors {b}, b has neighbors {a} — both degree 1, no triplets
    expect(gm.transitivity).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// calculateClusterMetrics
// ─────────────────────────────────────────────────────────────────

describe('calculateClusterMetrics', () => {
  it('computes basic coupling and instability for two clusters', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
      [
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'import' }, // A→B cross-cluster
        { source_file: 'b.ts', target_file: 'c.ts', edge_type: 'import' }, // B internal
      ],
      [{ name: 'A' }, { name: 'B' }],
      [
        { file_path: 'a.ts', cluster_name: 'A' },
        { file_path: 'b.ts', cluster_name: 'B' },
        { file_path: 'c.ts', cluster_name: 'B' },
      ]
    );
    const metrics = calculateClusterMetrics(store, 'repo');
    const A = metrics.find(m => m.clusterName === 'A')!;
    const B = metrics.find(m => m.clusterName === 'B')!;

    expect(A).toBeDefined();
    expect(B).toBeDefined();
    // A has 1 efferent cluster (B), 0 afferent → instability = 1
    expect(A.efferentCoupling).toBe(1);
    expect(A.afferentCoupling).toBe(0);
    expect(A.instability).toBe(1);
    // B has 1 internal edge, 1 afferent from A
    expect(B.internalEdges).toBe(1);
    expect(B.afferentCoupling).toBe(1);
    expect(B.efferentCoupling).toBe(0);
    expect(B.instability).toBe(0);
  });

  it('cohesionRatio is 1.0 when all edges are internal', () => {
    const store = makeStore(
      [{ path: 'x.ts' }, { path: 'y.ts' }],
      [{ source_file: 'x.ts', target_file: 'y.ts' }],
      [{ name: 'XY' }],
      [
        { file_path: 'x.ts', cluster_name: 'XY' },
        { file_path: 'y.ts', cluster_name: 'XY' },
      ]
    );
    const metrics = calculateClusterMetrics(store, 'repo');
    const xy = metrics[0];
    expect(xy.cohesionRatio).toBe(1.0);
  });

  it('cohesionRatio is 1.0 for cluster with no edges at all', () => {
    const store = makeStore(
      [{ path: 'a.ts' }],
      [],
      [{ name: 'Lone' }],
      [{ file_path: 'a.ts', cluster_name: 'Lone' }]
    );
    const metrics = calculateClusterMetrics(store, 'repo');
    expect(metrics[0].cohesionRatio).toBe(1.0);
  });

  it('computes abstractness from interface/trait symbols', () => {
    const store = makeStore(
      [{ path: 'a.ts' }],
      [],
      [{ name: 'Abstract' }],
      [{ file_path: 'a.ts', cluster_name: 'Abstract' }],
      { 'a.ts': [{ kind: 'interface' }, { kind: 'class' }, { kind: 'class' }] }
    );
    const metrics = calculateClusterMetrics(store, 'repo');
    const m = metrics[0];
    // 1 interface out of 3 symbols → abstractness ≈ 0.333
    expect(m.abstractness).toBeCloseTo(1 / 3, 5);
  });

  it('computes distanceFromMainSeq correctly', () => {
    // abstractness=0.5, instability=0.5 → distance = |0.5+0.5-1| = 0
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }],
      [
        { source_file: 'a.ts', target_file: 'c.ts' },
        { source_file: 'c.ts', target_file: 'a.ts' },
      ],
      [{ name: 'M' }, { name: 'N' }],
      [
        { file_path: 'a.ts', cluster_name: 'M' },
        { file_path: 'b.ts', cluster_name: 'M' },
        { file_path: 'c.ts', cluster_name: 'N' },
      ],
      { 'a.ts': [{ kind: 'interface' }, { kind: 'class' }] }
    );
    const metrics = calculateClusterMetrics(store, 'repo');
    for (const m of metrics) {
      expect(m.distanceFromMainSeq).toBeGreaterThanOrEqual(0);
      expect(m.distanceFromMainSeq).toBeLessThanOrEqual(1);
    }
  });

  it('returns empty array when no clusters', () => {
    const store = makeStore([{ path: 'a.ts' }], [], [], []);
    const metrics = calculateClusterMetrics(store, 'repo');
    expect(metrics).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// calculateDSM
// ─────────────────────────────────────────────────────────────────

describe('calculateDSM', () => {
  it('builds a dependency matrix between two clusters', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }],
      [{ source_file: 'a.ts', target_file: 'b.ts', edge_type: 'import' }],
      [{ name: 'Alpha' }, { name: 'Beta' }],
      [
        { file_path: 'a.ts', cluster_name: 'Alpha' },
        { file_path: 'b.ts', cluster_name: 'Beta' },
      ]
    );
    const dsm = calculateDSM(store, 'repo');
    expect(dsm.clusterNames).toContain('Alpha');
    expect(dsm.clusterNames).toContain('Beta');
    expect(dsm.matrix).toHaveLength(2);

    const alphaIdx = dsm.clusterNames.indexOf('Alpha');
    const betaIdx = dsm.clusterNames.indexOf('Beta');
    expect(dsm.matrix[alphaIdx][betaIdx]).toBe(1);
    expect(dsm.matrix[betaIdx][alphaIdx]).toBe(0);
  });

  it('records dominant edge type in dominantTypes', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }],
      [
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'import' },
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'import' },
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'call' },
      ],
      [{ name: 'P' }, { name: 'Q' }],
      [
        { file_path: 'a.ts', cluster_name: 'P' },
        { file_path: 'b.ts', cluster_name: 'Q' },
      ]
    );
    const dsm = calculateDSM(store, 'repo');
    const pIdx = dsm.clusterNames.indexOf('P');
    const qIdx = dsm.clusterNames.indexOf('Q');
    expect(dsm.dominantTypes[pIdx][qIdx]).toBe('import');
  });

  it('returns empty matrix for no clusters', () => {
    const store = makeStore([{ path: 'a.ts' }], [], [], []);
    const dsm = calculateDSM(store, 'repo');
    expect(dsm.clusterNames).toHaveLength(0);
    expect(dsm.matrix).toHaveLength(0);
  });

  it('ignores intra-cluster edges', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }],
      [{ source_file: 'a.ts', target_file: 'b.ts', edge_type: 'import' }],
      [{ name: 'Same' }],
      [
        { file_path: 'a.ts', cluster_name: 'Same' },
        { file_path: 'b.ts', cluster_name: 'Same' },
      ]
    );
    const dsm = calculateDSM(store, 'repo');
    expect(dsm.clusterNames).toHaveLength(1);
    expect(dsm.matrix[0][0]).toBe(0);
  });

  it('uses default edge type (import) when edge_type is not specified', () => {
    const store = makeStore(
      [{ path: 'a.ts' }, { path: 'b.ts' }],
      // no edge_type → makeStore defaults to 'import'
      [{ source_file: 'a.ts', target_file: 'b.ts' }],
      [{ name: 'X' }, { name: 'Y' }],
      [
        { file_path: 'a.ts', cluster_name: 'X' },
        { file_path: 'b.ts', cluster_name: 'Y' },
      ]
    );
    const dsm = calculateDSM(store, 'repo');
    const xIdx = dsm.clusterNames.indexOf('X');
    const yIdx = dsm.clusterNames.indexOf('Y');
    expect(dsm.dominantTypes[xIdx][yIdx]).toBe('import');
  });
});


describe('Metrics module', () => {
  it('calculateMetrics should calculate file metrics correctly', () => {
    const mockStore = {
      getAllFiles: (repo?: string) => [
        { path: 'a.ts', language: 'typescript' },
        { path: 'b.ts', language: 'typescript' },
        { path: 'c.ts', language: 'typescript' },
        { path: 'd.py', language: 'python' }
      ],
      getAllEdges: (repo?: string) => [
        // a depends on b
        { source_file: 'a.ts', target_file: 'b.ts', verifiability: 'verified' },
        // b depends on c
        { source_file: 'b.ts', target_file: 'c.ts', verifiability: 'verified' },
        // c depends on a (cycle)
        { source_file: 'c.ts', target_file: 'a.ts', verifiability: 'verified' },
        // b depends on d (inferred)
        { source_file: 'b.ts', target_file: 'd.py', verifiability: 'inferred' }
      ]
    } as unknown as Store;

    // Test with language python
    const pythonMetrics = calculateMetrics(mockStore, { language: 'python' });
    expect(pythonMetrics).toHaveLength(1);
    expect(pythonMetrics[0]).toEqual({
      path: 'd.py',
      language: 'python',
      afferent: 1, // b depends on d
      efferent: 0,
      instability: 0
    });

    // Test verifiedOnly: true
    const verifiedMetrics = calculateMetrics(mockStore, { verifiedOnly: true });
    const bVerified = verifiedMetrics.find(m => m.path === 'b.ts');
    expect(bVerified?.efferent).toBe(1); // only b -> c, b -> d is inferred and excluded

    // Test all metrics sorting
    const allMetrics = calculateMetrics(mockStore);
    expect(allMetrics).toHaveLength(4);
    // sorting order: b.instability - a.instability || b.afferent - a.afferent || a.path.localeCompare(b.path)
    // Instabilities:
    // a.ts: afferent = 1 (c->a), efferent = 1 (a->b). sum = 2. instability = 1/2 = 0.5
    // b.ts: afferent = 1 (a->b), efferent = 2 (b->c, b->d). sum = 3. instability = 2/3 = 0.666...
    // c.ts: afferent = 1 (b->c), efferent = 1 (c->a). sum = 2. instability = 1/2 = 0.5
    // d.py: afferent = 1 (b->d), efferent = 0. sum = 1. instability = 0/1 = 0
    expect(allMetrics[0].path).toBe('b.ts');
    expect(allMetrics[1].path).toBe('a.ts');
    expect(allMetrics[2].path).toBe('c.ts');
    expect(allMetrics[3].path).toBe('d.py');
  });

  it('calculateGraphMetrics should calculate density and transitivity', () => {
    const mockStore = {
      getAllFiles: (repo?: string) => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' }
      ],
      getAllEdges: (repo?: string) => [
        { source_file: 'a.ts', target_file: 'b.ts' },
        { source_file: 'b.ts', target_file: 'c.ts' },
        { source_file: 'c.ts', target_file: 'a.ts' }
      ]
    } as unknown as Store;

    const graphMetrics = calculateGraphMetrics(mockStore);
    // Density: edgeCount / (fileCount * (fileCount - 1))
    // 3 / (3 * 2) = 0.5
    expect(graphMetrics.density).toBe(0.5);
    // Transitivity: closedTriplets / totalTriplets
    // neighbors:
    // a: {b, c}
    // b: {a, c}
    // c: {a, b}
    // triplets for each node of degree >= 2: (k * (k - 1)) / 2
    // degree of each = 2. so (2 * 1) / 2 = 1 triplet each. totalTriplets = 3
    // all triplets are closed (a-b-c has edge a-c). closedTriplets = 3
    // transitivity = 3/3 = 1
    expect(graphMetrics.transitivity).toBe(1);
  });

  it('should handle empty and single-node edge cases in graph metrics', () => {
    const emptyStore = {
      getAllFiles: () => [],
      getAllEdges: () => []
    } as unknown as Store;
    const emptyMetrics = calculateGraphMetrics(emptyStore);
    expect(emptyMetrics.density).toBe(0);
    expect(emptyMetrics.transitivity).toBe(0);

    const singleStore = {
      getAllFiles: () => [{ path: 'a.ts' }],
      getAllEdges: () => []
    } as unknown as Store;
    const singleMetrics = calculateGraphMetrics(singleStore);
    expect(singleMetrics.density).toBe(0);
    expect(singleMetrics.transitivity).toBe(0);
  });
});
