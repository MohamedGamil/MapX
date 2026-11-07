import { describe, it, expect } from 'vitest';
import { ClusterEngine } from '../src/core/cluster-engine.js';
import type { Store } from '../src/core/store.js';

describe('ClusterEngine module', () => {
  it('detects namespace, directory, and community clusters correctly', () => {
    const insertedClusters: any[] = [];
    const insertedMemberships: any[] = [];

    const mockStore = {
      getAllFiles: (repo?: string) => [
        // Namespace clusters
        { path: 'src/core/a.ts', namespace: 'MapX.Core', metadata: '{}' },
        { path: 'src/core/b.ts', namespace: 'MapX.Core', metadata: '{}' },
        // Directory clusters (will group under src.utils)
        { path: 'src/utils/c.ts', namespace: null, metadata: '{}' },
        { path: 'src/utils/d.ts', namespace: null, metadata: '{}' },
        // Community clusters (will connect via edges in different dirs to avoid directory overlap)
        { path: 'src/comm1/e.ts', namespace: null, metadata: '{}' },
        { path: 'src/comm2/f.ts', namespace: null, metadata: '{}' },
        { path: 'src/comm3/g.ts', namespace: null, metadata: '{}' }
      ],
      getAllEdges: (repo?: string) => [
        // Triangle relation forming a distinct community
        { source_file: 'src/comm1/e.ts', target_file: 'src/comm2/f.ts' },
        { source_file: 'src/comm2/f.ts', target_file: 'src/comm3/g.ts' },
        { source_file: 'src/comm3/g.ts', target_file: 'src/comm1/e.ts' }
      ],
      inTransaction: (fn: () => void) => fn(),
      clearClusters: (repo?: string) => {},
      insertCluster: (c: any) => {
        insertedClusters.push(c);
      },
      insertClusterMembership: (m: any) => {
        insertedMemberships.push(m);
      }
    } as unknown as Store;

    const engine = new ClusterEngine(mockStore);
    const result = engine.detect('test-repo');

    expect(result.clustersFound).toBeGreaterThan(0);
    expect(result.namespaceClusters).toBeGreaterThan(0);
    expect(result.directoryClusters).toBeGreaterThan(0);
    expect(result.communityClusters).toBeGreaterThan(0);

    // Verify clusters were saved to store
    expect(insertedClusters.some(c => c.name === 'MapX.Core')).toBe(true);
    expect(insertedClusters.some(c => c.name === 'src.utils')).toBe(true);
    expect(insertedClusters.some(c => c.source === 'community')).toBe(true);

    // Verify memberships
    expect(insertedMemberships.some(m => m.filePath === 'src/core/a.ts' && m.clusterName === 'MapX.Core')).toBe(true);
    expect(insertedMemberships.some(m => m.filePath === 'src/utils/c.ts' && m.clusterName === 'src.utils')).toBe(true);
  });
});
