import { describe, it, expect } from 'vitest';
import { calculateMetrics, calculateGraphMetrics } from '../src/core/metrics.js';
import type { Store } from '../src/core/store.js';

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
