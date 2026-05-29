import { describe, it, expect } from 'vitest';
import { ContextBuilder } from '../src/core/context-builder.js';
import { MapxGraph } from '../src/core/graph.js';
import type { Store } from '../src/core/store.js';

describe('ContextBuilder module', () => {
  it('extracts keywords correctly', () => {
    const kw = ContextBuilder.extractKeywords('Implement a new UserService with class and authServiceController');
    expect(kw).toContain('user');
    expect(kw).toContain('service');
    expect(kw).toContain('auth');
    expect(kw).not.toContain('implement');
    expect(kw).not.toContain('with');
  });

  it('buildContext constructs context from seeds and task keywords', async () => {
    const mockStore = {
      getFile: (path: string) => {
        if (path === 'a.ts') return { path: 'a.ts', lines: 100, size_bytes: 2000, language: 'typescript' };
        if (path === 'b.ts') return { path: 'b.ts', lines: 150, size_bytes: 3000, language: 'typescript' };
        return null;
      },
      getSymbolByName: (name: string, repo?: string) => {
        if (name === 'A') return { name: 'A', kind: 'class', file_path: 'a.ts' };
        return null;
      },
      searchSymbolsFiltered: (options: any) => {
        if (options.term === 'user') {
          return [{ name: 'UserService', kind: 'class', file_path: 'b.ts' }];
        }
        return [];
      },
      getAllFiles: (repo?: string) => [
        { path: 'a.ts', language: 'typescript', lines: 100, size_bytes: 2000 },
        { path: 'b.ts', language: 'typescript', lines: 150, size_bytes: 3000 }
      ],
      getSymbolsForFile: (path: string) => {
        if (path === 'a.ts') return [{ name: 'A', kind: 'class', scope: null, start_line: 1, end_line: 50 }];
        if (path === 'b.ts') return [{ name: 'UserService', kind: 'class', scope: null, start_line: 1, end_line: 60 }];
        return [];
      },
      getEdgesForFile: (path: string) => {
        if (path === 'a.ts') {
          return [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'A', target_symbol: 'UserService', edge_type: 'call' }];
        }
        return [];
      },
      raw: {
        prepare: (sql: string) => ({
          all: (...args: any[]) => [{ cluster_name: 'core' }]
        })
      }
    } as unknown as Store;

    const graph = new MapxGraph('test-repo');
    graph.addFileNode('a.ts', 'typescript', 2000, 100);
    graph.addFileNode('b.ts', 'typescript', 3000, 150);
    graph.addDependencyEdge({
      sourceFile: 'a.ts',
      targetFile: 'b.ts',
      sourceSymbol: 'A',
      targetSymbol: 'UserService',
      edgeType: 'call',
      weight: 1,
      repo: 'test-repo'
    });
    graph.computePageRank();

    const builder = new ContextBuilder(mockStore, graph);
    const result = await builder.buildContext({
      task: 'User profile feature',
      seeds: ['A', 'nonexistent.ts'],
      tokens: 8192,
      depth: 2
    });

    expect(result.includedFiles).toHaveLength(2);
    expect(result.includedFiles.map(f => f.path)).toContain('a.ts');
    expect(result.includedFiles.map(f => f.path)).toContain('b.ts');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({
      sourceFile: 'a.ts',
      targetFile: 'b.ts',
      sourceSymbol: 'A',
      targetSymbol: 'UserService',
      edgeType: 'call'
    });
  });

  it('buildContext limits files based on token budget', async () => {
    const mockStore = {
      getFile: (path: string) => ({ path, lines: 100, size_bytes: 2000, language: 'typescript' }),
      getAllFiles: () => [{ path: 'a.ts' }, { path: 'b.ts' }],
      getSymbolsForFile: (path: string) => new Array(50).fill(null).map((_, i) => ({ name: `Sym${i}`, kind: 'method', scope: null, start_line: i, end_line: i+1 })),
      getEdgesForFile: () => [],
      searchSymbolsFiltered: () => [],
      raw: {
        prepare: () => ({ all: () => [] })
      }
    } as unknown as Store;

    const graph = new MapxGraph('test');
    graph.addFileNode('a.ts', 'typescript', 2000, 100);
    graph.addFileNode('b.ts', 'typescript', 2000, 100);
    graph.computePageRank();

    const builder = new ContextBuilder(mockStore, graph);
    const result = await builder.buildContext({
      task: 'hello',
      tokens: 1500
    });

    expect(result.includedFiles).toHaveLength(1);
    expect(result.excludedFiles).toHaveLength(1);
  });
});
