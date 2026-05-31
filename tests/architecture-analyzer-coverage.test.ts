import { describe, it, expect, vi } from 'vitest';
import { ArchitectureAnalyzer } from '../src/core/architecture-analyzer.js';
import type { Store } from '../src/core/store.js';
import type { CodebaseProfile } from '../src/types.js';

describe('ArchitectureAnalyzer Coverage Boost', () => {
  const mockProfile: CodebaseProfile = {
    archetype: 'web-api',
    archetypeConfidence: 0.9,
    detectedFrameworks: ['express'],
    detectedPatterns: ['layered'],
    dominantLanguages: ['typescript'],
    hasBackend: true,
    hasFrontend: false,
    isMonorepo: false,
    componentBoundaries: []
  };

  it('detects hub components (high fan-in and high fan-out)', () => {
    // We want a hub file: fan-in > 15, fan-out > 10.
    const files = [
      { path: 'src/hub.ts', language: 'typescript' }
    ];
    // Add 16 other files for fan-in and 11 other files for fan-out
    const edges: any[] = [];
    for (let i = 1; i <= 16; i++) {
      edges.push({ source_file: `src/in_${i}.ts`, target_file: 'src/hub.ts' });
      files.push({ path: `src/in_${i}.ts`, language: 'typescript' });
    }
    for (let i = 1; i <= 11; i++) {
      edges.push({ source_file: 'src/hub.ts', target_file: `src/out_${i}.ts` });
      files.push({ path: `src/out_${i}.ts`, language: 'typescript' });
    }

    const mockStore = {
      getAllFiles: () => files,
      getAllEdges: () => edges,
      raw: {
        prepare: () => ({
          all: () => [] // no clusters/memberships
        })
      }
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    const hubs = smells.filter(s => s.type === 'hub-component');
    expect(hubs).toHaveLength(1);
    expect(hubs[0].involvedFiles).toContain('src/hub.ts');
  });

  it('detects cluster smells: god cluster, orphan cluster, and unstable dependency', () => {
    // Need at least 11 total files for God Cluster check
    const files: any[] = [];
    for (let i = 1; i <= 12; i++) {
      files.push({ path: `src/file_${i}.ts`, language: 'typescript' });
    }

    // Edges connecting file_1 (in cluster_A) to file_4 (in cluster_B)
    const edges = [
      { source_file: 'src/file_1.ts', target_file: 'src/file_4.ts' }
    ];

    // Mock SQL prepare to return primary memberships
    const memberships = [
      { file_path: 'src/file_1.ts', cluster_name: 'cluster_A' },
      { file_path: 'src/file_2.ts', cluster_name: 'cluster_A' },
      { file_path: 'src/file_3.ts', cluster_name: 'cluster_A' },
      { file_path: 'src/file_4.ts', cluster_name: 'cluster_B' },
      { file_path: 'src/file_5.ts', cluster_name: 'cluster_B' },
      { file_path: 'src/file_6.ts', cluster_name: 'cluster_B' },
      { file_path: 'src/file_7.ts', cluster_name: 'cluster_B' },
      { file_path: 'src/file_8.ts', cluster_name: 'cluster_B' }, // cluster_B has 5 files (> 30% of 12) -> God Cluster!
      { file_path: 'src/file_9.ts', cluster_name: 'orphan_C' },   // orphan_C has 1 file -> Orphan Cluster!
    ];

    const mockStore = {
      getAllFiles: () => files,
      getAllEdges: () => edges,
      getSymbolsForFile: () => [],
      raw: {
        prepare: (sql: string) => {
          if (sql.includes('cluster_membership')) {
            return { all: () => memberships };
          }
          if (sql.includes('FROM clusters')) {
            return {
              all: () => [
                { name: 'cluster_A', source: 'dir' },
                { name: 'cluster_B', source: 'dir' },
                { name: 'orphan_C', source: 'dir' }
              ]
            };
          }
          return { all: () => [] };
        }
      }
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    // Overriding metrics calculation to inject specific stable/unstable profiles
    // Stable: low instability (< 0.3). Unstable: high instability (> 0.7). Both fileCount > 2.
    // cluster_A (stable, depends on cluster_B) -> instability 0.1
    // cluster_B (unstable) -> instability 0.9
    const originalMetrics = analyzer['detectClusterSmells'];
    analyzer['detectClusterSmells'] = function(metrics, edgesList, filesList) {
      const customMetrics = [
        { clusterName: 'cluster_A', fileCount: 3, instability: 0.1, afferentCoupling: 9, efferentCoupling: 1, internalEdges: 10, externalEdges: 1, cohesionRatio: 0.9, abstractness: 0, distanceFromMainSeq: 0.1 },
        { clusterName: 'cluster_B', fileCount: 5, instability: 0.9, afferentCoupling: 1, efferentCoupling: 9, internalEdges: 10, externalEdges: 1, cohesionRatio: 0.9, abstractness: 0, distanceFromMainSeq: 0.1 },
        { clusterName: 'orphan_C', fileCount: 1, instability: 0.5, afferentCoupling: 0, efferentCoupling: 0, internalEdges: 0, externalEdges: 0, cohesionRatio: 1.0, abstractness: 0, distanceFromMainSeq: 0.5 },
      ];
      return originalMetrics.call(this, customMetrics, edgesList, filesList);
    };

    const smells = analyzer.analyze('test-repo', mockProfile);

    // Verify God Cluster
    const god = smells.filter(s => s.type === 'god-cluster');
    expect(god).toHaveLength(1);
    expect(god[0].involvedClusters).toContain('cluster_B');

    // Verify Orphan Cluster
    const orphan = smells.filter(s => s.type === 'orphan-cluster');
    expect(orphan).toHaveLength(1);
    expect(orphan[0].involvedClusters).toContain('orphan_C');

    // Verify Unstable Dependency
    const unstable = smells.filter(s => s.type === 'unstable-dependency');
    expect(unstable).toHaveLength(1);
    expect(unstable[0].involvedClusters).toContain('cluster_A');
    expect(unstable[0].involvedClusters).toContain('cluster_B');
  });

  it('detects complex cycles (DFS and BFS reconstruction)', () => {
    // 4+ node cycle: a -> b -> c -> d -> a
    const files = [
      { path: 'a.ts', language: 'typescript' },
      { path: 'b.ts', language: 'typescript' },
      { path: 'c.ts', language: 'typescript' },
      { path: 'd.ts', language: 'typescript' }
    ];
    const edges = [
      { source_file: 'a.ts', target_file: 'b.ts' },
      { source_file: 'b.ts', target_file: 'c.ts' },
      { source_file: 'c.ts', target_file: 'd.ts' },
      { source_file: 'd.ts', target_file: 'a.ts' }
    ];

    const mockStore = {
      getAllFiles: () => files,
      getAllEdges: () => edges,
      raw: {
        prepare: () => ({ all: () => [] })
      }
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    const cycles = smells.filter(s => s.type === 'cyclic-dependency');
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].involvedFiles).toContain('a.ts');
    expect(cycles[0].involvedFiles).toContain('d.ts');
  });
});
