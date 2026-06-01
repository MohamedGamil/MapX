import { describe, it, expect } from 'vitest';
import { detectLeidenCommunities } from '../src/core/leiden.js';

describe('Leiden Community Detection', () => {
  it('detects separate communities in a simple clustered graph', () => {
    // 2 clusters: {a, b, c} and {x, y, z}
    // minimal cross edges
    const nodes = ['a', 'b', 'c', 'x', 'y', 'z'];
    const edges = [
      // Cluster 1
      { source: 'a', target: 'b', weight: 1.0 },
      { source: 'b', target: 'c', weight: 1.0 },
      { source: 'c', target: 'a', weight: 1.0 },
      
      // Cluster 2
      { source: 'x', target: 'y', weight: 1.0 },
      { source: 'y', target: 'z', weight: 1.0 },
      { source: 'z', target: 'x', weight: 1.0 },
      
      // Weak bridge edge
      { source: 'c', target: 'x', weight: 0.1 }
    ];

    const result = detectLeidenCommunities(nodes, edges, { minCommunitySize: 2, resolution: 2.0 });
    
    // We expect 2 communities detected
    const commKeys = Object.keys(result);
    expect(commKeys.length).toBe(2);

    // Verify membership
    const comm1 = result[commKeys[0]];
    const comm2 = result[commKeys[1]];

    // Verify they don't overlap and partition the nodes
    const allMembers = [...comm1, ...comm2];
    expect(allMembers).toHaveLength(6);
    expect(new Set(allMembers).size).toBe(6);
  });

  it('filters out communities smaller than minCommunitySize', () => {
    const nodes = ['a', 'b', 'c', 'x', 'y'];
    const edges = [
      // Cluster 1 (size 3)
      { source: 'a', target: 'b', weight: 1.0 },
      { source: 'b', target: 'c', weight: 1.0 },
      { source: 'c', target: 'a', weight: 1.0 },
      // Isolated edge (size 2)
      { source: 'x', target: 'y', weight: 1.0 }
    ];

    // If minCommunitySize is 3, the second community of size 2 is filtered out
    const result = detectLeidenCommunities(nodes, edges, { minCommunitySize: 3 });
    const commKeys = Object.keys(result);
    expect(commKeys.length).toBe(1);
    expect(result[commKeys[0]]).toContain('a');
    expect(result[commKeys[0]]).toContain('b');
    expect(result[commKeys[0]]).toContain('c');
  });

  it('handles empty and fully disconnected graph gracefully', () => {
    const resultEmpty = detectLeidenCommunities([], []);
    expect(resultEmpty).toEqual({});

    const resultDisconnected = detectLeidenCommunities(['a', 'b', 'c'], []);
    expect(resultDisconnected).toEqual({});
  });
});
