import { describe, it, expect } from 'vitest';
import { FlowTracer } from '../src/core/flow-tracer.js';
import type { Store } from '../src/core/store.js';

describe('Trace cycle deduplication', () => {
  it('should deduplicate cycles with the same fromFile->toFile and cycleLength', () => {
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' },
      ],
      getAllSymbols: () => [
        { name: 'fnA', scope: null, file_path: 'a.ts' },
        { name: 'fnB', scope: null, file_path: 'b.ts' },
        { name: 'fnC', scope: null, file_path: 'c.ts' },
      ],
      getSymbolsForFile: (file: string) => {
        if (file === 'a.ts') return [{ name: 'fnA', scope: null, file_path: 'a.ts' }];
        if (file === 'b.ts') return [{ name: 'fnB', scope: null, file_path: 'b.ts' }];
        if (file === 'c.ts') return [{ name: 'fnC', scope: null, file_path: 'c.ts' }];
        return [];
      },
      getEdgesForFile: (file: string) => {
        if (file === 'a.ts') {
          return [
            { source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'fnA', target_symbol: 'fnB', edge_type: 'call' }
          ];
        }
        if (file === 'b.ts') {
          return [
            { source_file: 'b.ts', target_file: 'c.ts', source_symbol: 'fnB', target_symbol: 'fnC', edge_type: 'call' }
          ];
        }
        if (file === 'c.ts') {
          return [
            { source_file: 'c.ts', target_file: 'a.ts', source_symbol: 'fnC', target_symbol: 'fnA', edge_type: 'call' }
          ];
        }
        return [];
      },
      getReverseEdges: (file: string) => {
        if (file === 'a.ts') {
          return [{ source_file: 'c.ts', target_file: 'a.ts', source_symbol: 'fnC', target_symbol: 'fnA', edge_type: 'call' }];
        }
        if (file === 'b.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'fnA', target_symbol: 'fnB', edge_type: 'call' }];
        }
        if (file === 'c.ts') {
          return [{ source_file: 'b.ts', target_file: 'c.ts', source_symbol: 'fnB', target_symbol: 'fnC', edge_type: 'call' }];
        }
        return [];
      }
    } as unknown as Store;

    const tracer = new FlowTracer(mockStore);
    const result = tracer.trace({
      startSymbol: 'fnA',
      direction: 'both',
      maxDepth: 5,
      includeStructural: false
    });

    expect(result.cycles.length).toBeGreaterThan(0);

    const keys = result.cycles.map(c => `${c.fromFile}→${c.toFile}:${c.cycleLength}`);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});
