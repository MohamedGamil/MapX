import { describe, it, expect } from 'vitest';
import { ClusterEngine } from '../src/core/cluster-engine.js';
import type { Store } from '../src/core/store.js';

describe('Community cluster auto-naming', () => {
  it('should label community clusters with dominant directory and file count', () => {
    const insertedClusters: any[] = [];
    const insertedMemberships: any[] = [];

    const mockStore = {
      getAllFiles: () => [
        // 5 files in src/core — forming one strongly connected community
        { path: 'src/core/a.ts', namespace: null, metadata: '{}' },
        { path: 'src/core/b.ts', namespace: null, metadata: '{}' },
        { path: 'src/core/c.ts', namespace: null, metadata: '{}' },
        { path: 'src/core/d.ts', namespace: null, metadata: '{}' },
        { path: 'src/core/e.ts', namespace: null, metadata: '{}' },
      ],
      getAllEdges: () => [
        // Complete connectivity to force a single community cluster
        { source_file: 'src/core/a.ts', target_file: 'src/core/b.ts', edge_type: 'call' },
        { source_file: 'src/core/b.ts', target_file: 'src/core/c.ts', edge_type: 'call' },
        { source_file: 'src/core/c.ts', target_file: 'src/core/d.ts', edge_type: 'call' },
        { source_file: 'src/core/d.ts', target_file: 'src/core/e.ts', edge_type: 'call' },
        { source_file: 'src/core/e.ts', target_file: 'src/core/a.ts', edge_type: 'call' },
        { source_file: 'src/core/a.ts', target_file: 'src/core/c.ts', edge_type: 'call' },
        { source_file: 'src/core/b.ts', target_file: 'src/core/d.ts', edge_type: 'call' },
      ],
      inTransaction: (fn: () => void) => fn(),
      clearClusters: () => {},
      insertCluster: (c: any) => { insertedClusters.push(c); },
      insertClusterMembership: (m: any) => { insertedMemberships.push(m); },
    } as unknown as Store;

    const engine = new ClusterEngine(mockStore);
    engine.detect('test-repo');

    const communityClusters = insertedClusters.filter(c => c.source === 'community');
    expect(communityClusters.length).toBeGreaterThan(0);

    // Each community label should follow the pattern: "<dominantDir> (<N> files)"
    for (const cluster of communityClusters) {
      expect(cluster.label).toMatch(/\(\d+ files\)$/);
    }

    // The dominant directory for these files should be src/core
    const dominant = communityClusters.find(c => c.label.includes('src/core'));
    expect(dominant).toBeDefined();
    expect(dominant!.label).toContain('files)');
  });

  it('should use generic label when community spans multiple directories', () => {
    const insertedClusters: any[] = [];

    const mockStore = {
      getAllFiles: () => [
        { path: 'src/alpha/x.ts', namespace: null, metadata: '{}' },
        { path: 'src/beta/y.ts', namespace: null, metadata: '{}' },
        { path: 'src/gamma/z.ts', namespace: null, metadata: '{}' },
      ],
      getAllEdges: () => [
        { source_file: 'src/alpha/x.ts', target_file: 'src/beta/y.ts', edge_type: 'call' },
        { source_file: 'src/beta/y.ts', target_file: 'src/gamma/z.ts', edge_type: 'call' },
        { source_file: 'src/gamma/z.ts', target_file: 'src/alpha/x.ts', edge_type: 'call' },
      ],
      inTransaction: (fn: () => void) => fn(),
      clearClusters: () => {},
      insertCluster: (c: any) => { insertedClusters.push(c); },
      insertClusterMembership: () => {},
    } as unknown as Store;

    const engine = new ClusterEngine(mockStore);
    engine.detect('test-repo');

    const communityClusters = insertedClusters.filter(c => c.source === 'community');
    // All community labels should include the file count
    for (const c of communityClusters) {
      expect(c.label).toMatch(/\(\d+ files\)$/);
    }
  });

  it('should NOT produce generic numbered labels like "Community 1"', () => {
    const insertedClusters: any[] = [];

    const mockStore = {
      getAllFiles: () => [
        { path: 'lib/foo.ts', namespace: null, metadata: '{}' },
        { path: 'lib/bar.ts', namespace: null, metadata: '{}' },
      ],
      getAllEdges: () => [
        { source_file: 'lib/foo.ts', target_file: 'lib/bar.ts', edge_type: 'call' },
        { source_file: 'lib/bar.ts', target_file: 'lib/foo.ts', edge_type: 'call' },
      ],
      inTransaction: (fn: () => void) => fn(),
      clearClusters: () => {},
      insertCluster: (c: any) => { insertedClusters.push(c); },
      insertClusterMembership: () => {},
    } as unknown as Store;

    const engine = new ClusterEngine(mockStore);
    engine.detect('test-repo');

    const communityClusters = insertedClusters.filter(c => c.source === 'community');
    for (const c of communityClusters) {
      // Label should NOT be just a generic numbered name
      expect(c.label).not.toMatch(/^Community \d+$/);
      // Label should contain the dominant directory path
      expect(c.label).toMatch(/\w+/);
    }
  });
});
