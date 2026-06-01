import { describe, it, expect } from 'vitest';
import { FlowTracer } from '../src/core/flow-tracer.js';
import type { Store } from '../src/core/store.js';

describe('FlowTracer Coverage Boost', () => {
  it('traces with file-only start (no symbol)', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' }
      ],
      getAllSymbols: () => [],
      getSymbolsForFile: () => [],
      getEdgesForFile: (file: string) => {
        if (file === 'a.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: null, target_symbol: null, edge_type: 'import' }];
        }
        return [];
      },
      getReverseEdges: () => []
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);

    // Call trace with startFile only (no startSymbol) and includeStructural: true
    const result = tracer.trace({
      startFile: 'a.ts',
      direction: 'down',
      maxDepth: 3,
      includeStructural: true
    });

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0].nodes[0].file).toBe('a.ts');
    expect(result.paths[0].nodes[1].file).toBe('b.ts');
  });

  it('resolves start point using glob patterns', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/core/scanner.ts' },
        { path: 'src/utils/helpers.ts' }
      ],
      getAllSymbols: () => []
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);

    // Resolves file using wildcard/glob
    const res1 = tracer.resolveStart('**/scanner.ts');
    expect(res1).toEqual({ file: 'src/core/scanner.ts', symbol: null });

    const res2 = tracer.resolveStart('src/utils/*');
    expect(res2).toEqual({ file: 'src/utils/helpers.ts', symbol: null });
  });

  it('handles findCriticalPath when start or target is unresolvable', () => {
    const mockStore = {
      getAllFiles: () => [{ path: 'a.ts' }],
      getAllSymbols: () => []
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);

    // From or to non-existent
    const res1 = tracer.findCriticalPath('A', 'B');
    expect(res1).toBeNull();
  });

  it('filters getEdgesForNode by repository name', () => {
    const mockStore = {
      getEdgesForFile: (file: string) => [
        { source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'A', target_symbol: 'B', edge_type: 'call', repo: 'repo1' },
        { source_file: 'a.ts', target_file: 'c.ts', source_symbol: 'A', target_symbol: 'C', edge_type: 'call', repo: 'repo2' }
      ]
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);

    // Should only get edges from repo1
    const edgesRepo1 = (tracer as any).getEdgesForNode({ file: 'a.ts', symbol: 'A' }, 'down', false, 'repo1');
    expect(edgesRepo1).toHaveLength(1);
    expect(edgesRepo1[0].target_file).toBe('b.ts');

    // Should get all edges if no repo filter is provided
    const edgesAll = (tracer as any).getEdgesForNode({ file: 'a.ts', symbol: 'A' }, 'down', false);
    expect(edgesAll).toHaveLength(2);
  });
});
