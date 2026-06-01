import { describe, it, expect } from 'vitest';
import { FlowTracer } from '../src/core/flow-tracer.js';
import type { Store } from '../src/core/store.js';

describe('FlowTracer module', () => {
  it('resolves starting point correctly', () => {
    const mockStore = {
      getAllFiles: (repo?: string) => [
        { path: 'src/main.ts' },
        { path: 'src/utils.ts' }
      ],
      getAllSymbols: (repo?: string) => [
        { name: 'App', scope: null, file_path: 'src/main.ts' },
        { name: 'format', scope: 'Formatter', file_path: 'src/utils.ts' },
        { name: 'getEffectiveLimits', scope: 'BillingService', file_path: 'src/billing.ts' },
        { name: 'deepMethod', scope: 'NamespaceA::NamespaceB::ClassC', file_path: 'src/deep.ts' }
      ]
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);

    // Resolve file by direct match
    expect(tracer.resolveStart('src/main.ts')).toEqual({ file: 'src/main.ts', symbol: null });
    // Resolve file by suffix
    expect(tracer.resolveStart('main.ts')).toEqual({ file: 'src/main.ts', symbol: null });
    // Resolve top-level symbol
    expect(tracer.resolveStart('App')).toEqual({ file: 'src/main.ts', symbol: 'App' });
    // Resolve scoped symbol
    expect(tracer.resolveStart('Formatter::format')).toEqual({ file: 'src/utils.ts', symbol: 'Formatter::format' });
    expect(tracer.resolveStart('Formatter.format')).toEqual({ file: 'src/utils.ts', symbol: 'Formatter::format' });
    // Resolve billing limits using double colon and dot
    expect(tracer.resolveStart('BillingService::getEffectiveLimits')).toEqual({ file: 'src/billing.ts', symbol: 'BillingService::getEffectiveLimits' });
    expect(tracer.resolveStart('BillingService.getEffectiveLimits')).toEqual({ file: 'src/billing.ts', symbol: 'BillingService::getEffectiveLimits' });
    // Resolve multi-level scoped symbol
    expect(tracer.resolveStart('NamespaceA::NamespaceB::ClassC::deepMethod')).toEqual({ file: 'src/deep.ts', symbol: 'NamespaceA::NamespaceB::ClassC::deepMethod' });
    expect(tracer.resolveStart('NamespaceA.NamespaceB.ClassC.deepMethod')).toEqual({ file: 'src/deep.ts', symbol: 'NamespaceA::NamespaceB::ClassC::deepMethod' });
    // Unresolved
    expect(tracer.resolveStart('nonexistent')).toBeNull();
  });

  it('finds sources and sinks correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' }
      ],
      getAllEdges: () => [
        // a -> b (call) - data bearing
        { source_file: 'a.ts', target_file: 'b.ts', edge_type: 'call' },
        // b -> c (instantiation) - data bearing
        { source_file: 'b.ts', target_file: 'c.ts', edge_type: 'instantiation' },
        // a -> c (import) - structural (not data bearing)
        { source_file: 'a.ts', target_file: 'c.ts', edge_type: 'import' }
      ]
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    
    const sources = tracer.findSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].file).toBe('a.ts');

    const sinks = tracer.findSinks();
    expect(sinks).toHaveLength(1);
    expect(sinks[0].file).toBe('c.ts');
  });

  it('traces data flow paths (DFS) correctly', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' }
      ],
      getAllSymbols: () => [
        { name: 'fnA', scope: null, file_path: 'a.ts' },
        { name: 'fnB', scope: null, file_path: 'b.ts' },
        { name: 'fnC', scope: null, file_path: 'c.ts' }
      ],
      getSymbolsForFile: (file: string) => {
        if (file === 'a.ts') return [{ name: 'fnA', scope: null, file_path: 'a.ts' }];
        if (file === 'b.ts') return [{ name: 'fnB', scope: null, file_path: 'b.ts' }];
        if (file === 'c.ts') return [{ name: 'fnC', scope: null, file_path: 'c.ts' }];
        return [];
      },
      getEdgesForFile: (file: string) => {
        if (file === 'a.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'fnA', target_symbol: 'fnB', edge_type: 'call' }];
        }
        if (file === 'b.ts') {
          return [{ source_file: 'b.ts', target_file: 'c.ts', source_symbol: 'fnB', target_symbol: 'fnC', edge_type: 'call' }];
        }
        return [];
      },
      getReverseEdges: (file: string) => {
        if (file === 'c.ts') {
          return [{ source_file: 'b.ts', target_file: 'c.ts', source_symbol: 'fnB', target_symbol: 'fnC', edge_type: 'call' }];
        }
        if (file === 'b.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'fnA', target_symbol: 'fnB', edge_type: 'call' }];
        }
        return [];
      }
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);

    // Trace down
    const resultDown = tracer.trace({
      startSymbol: 'fnA',
      direction: 'down',
      maxDepth: 3,
      includeStructural: false
    });

    expect(resultDown.paths).toHaveLength(1);
    expect(resultDown.paths[0].nodes.map(n => n.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(resultDown.nodeCount).toBe(3);

    // Trace up
    const resultUp = tracer.trace({
      startSymbol: 'fnC',
      direction: 'up',
      maxDepth: 3,
      includeStructural: false
    });
    expect(resultUp.paths).toHaveLength(1);
    expect(resultUp.paths[0].nodes.map(n => n.file)).toEqual(['c.ts', 'b.ts', 'a.ts']);

    // Trace both
    const resultBoth = tracer.trace({
      startSymbol: 'fnB',
      direction: 'both',
      maxDepth: 3,
      includeStructural: false
    });
    expect(resultBoth.paths).toHaveLength(2); // one down, one up
  });

  it('handles cyclic dependencies in tracing', () => {
    const mockStore = {
      getAllFiles: () => [{ path: 'a.ts' }, { path: 'b.ts' }],
      getAllSymbols: () => [
        { name: 'fnA', scope: null, file_path: 'a.ts' },
        { name: 'fnB', scope: null, file_path: 'b.ts' }
      ],
      getSymbolsForFile: (file: string) => {
        if (file === 'a.ts') return [{ name: 'fnA', scope: null, file_path: 'a.ts' }];
        if (file === 'b.ts') return [{ name: 'fnB', scope: null, file_path: 'b.ts' }];
        return [];
      },
      getEdgesForFile: (file: string) => {
        if (file === 'a.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'fnA', target_symbol: 'fnB', edge_type: 'call' }];
        }
        if (file === 'b.ts') {
          return [{ source_file: 'b.ts', target_file: 'a.ts', source_symbol: 'fnB', target_symbol: 'fnA', edge_type: 'call' }];
        }
        return [];
      },
      getReverseEdges: (file: string) => {
        if (file === 'a.ts') {
          return [{ source_file: 'b.ts', target_file: 'a.ts', source_symbol: 'fnB', target_symbol: 'fnA', edge_type: 'call' }];
        }
        if (file === 'b.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'fnA', target_symbol: 'fnB', edge_type: 'call' }];
        }
        return [];
      }
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const result = tracer.trace({
      startSymbol: 'fnA',
      direction: 'down',
      maxDepth: 5,
      includeStructural: false
    });

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toEqual({
      fromFile: 'b.ts',
      fromSymbol: 'fnB',
      toFile: 'a.ts',
      toSymbol: 'fnA',
      edgeType: 'call',
      cycleLength: 2
    });
  });

  it('finds critical path (shortest path) correctly', () => {
    const mockStore = {
      getAllFiles: () => [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }, { path: 'd.ts' }],
      getAllSymbols: () => [
        { name: 'A', scope: null, file_path: 'a.ts' },
        { name: 'B', scope: null, file_path: 'b.ts' },
        { name: 'C', scope: null, file_path: 'c.ts' },
        { name: 'D', scope: null, file_path: 'd.ts' }
      ],
      getSymbolsForFile: (file: string) => {
        return [{ name: file.split('.')[0].toUpperCase(), scope: null, file_path: file }];
      },
      getEdgesForFile: (file: string) => {
        if (file === 'a.ts') {
          return [
            { source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'A', target_symbol: 'B', edge_type: 'call' },
            { source_file: 'a.ts', target_file: 'c.ts', source_symbol: 'A', target_symbol: 'C', edge_type: 'call' }
          ];
        }
        if (file === 'b.ts') {
          return [{ source_file: 'b.ts', target_file: 'd.ts', source_symbol: 'B', target_symbol: 'D', edge_type: 'call' }];
        }
        if (file === 'c.ts') {
          return [{ source_file: 'c.ts', target_file: 'd.ts', source_symbol: 'C', target_symbol: 'D', edge_type: 'call' }];
        }
        return [];
      }
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const criticalPath = tracer.findCriticalPath('A', 'D');
    expect(criticalPath).not.toBeNull();
    expect(criticalPath!.nodes).toHaveLength(3);
    expect(criticalPath!.nodes[0].file).toBe('a.ts');
    expect(criticalPath!.nodes[2].file).toBe('d.ts');

    const noPath = tracer.findCriticalPath('B', 'C');
    expect(noPath).toBeNull();
  });

  it('throws error when start point cannot be resolved', () => {
    const mockStore = {
      getAllFiles: () => [],
      getAllSymbols: () => []
    } as unknown as Store;
    const tracer = new FlowTracer(mockStore);
    expect(() => tracer.trace({ direction: 'down', maxDepth: 2, startSymbol: 'missing', includeStructural: false })).toThrow();
  });
});
