import { describe, it, expect, vi } from 'vitest';
import { ContextBuilder } from '../src/core/context-builder.js';
import { MapxGraph } from '../src/core/graph.js';
import type { Store } from '../src/core/store.js';

describe('ContextBuilder Coverage Boost', () => {
  it('covers fallback to PageRank when seedFiles is empty', async () => {
    const mockStore = {
      getFile: () => null,
      getSymbolByName: () => null,
      searchSymbolsFiltered: () => [],
      getAllFiles: () => [],
      getSymbolsForFile: () => [],
      getEdgesForFile: () => [],
      raw: {
        prepare: () => ({
          all: () => []
        })
      }
    } as unknown as Store;

    const graph = new MapxGraph('test-repo');
    graph.addFileNode('top1.ts', 'typescript', 100, 10);
    graph.addFileNode('top2.ts', 'typescript', 100, 10);
    graph.computePageRank();

    const builder = new ContextBuilder(mockStore, graph);
    const result = await builder.buildContext({
      task: 'a the of',
      tokens: 2000
    });

    expect(result.includedFiles).toEqual([]);
  });

  it('handles database errors gracefully and applies role/keyword boosts', async () => {
    const mockStore = {
      getFile: (path: string) => {
        if (path === 'api-controller.ts') {
          return { path, lines: 50, size_bytes: 1000, language: 'typescript', role: 'api' };
        }
        return { path, lines: 100, size_bytes: 2000, language: 'typescript', role: 'other' };
      },
      getSymbolByName: () => null,
      searchSymbolsFiltered: () => [],
      getAllFiles: () => [
        { path: 'api-controller.ts', language: 'typescript', lines: 50, size_bytes: 1000, role: 'api' }
      ],
      getSymbolsForFile: (path: string) => {
        if (path === 'api-controller.ts') {
          return [{ name: 'UserController', kind: 'class', scope: null, start_line: 1, end_line: 10 }];
        }
        return [];
      },
      getEdgesForFile: () => [],
      raw: {
        prepare: () => {
          throw new Error('Database error simulation');
        }
      }
    } as unknown as Store;

    const graph = new MapxGraph('test-repo');
    graph.addFileNode('api-controller.ts', 'typescript', 1000, 50);
    graph.computePageRank();

    const builder = new ContextBuilder(mockStore, graph);
    const result = await builder.buildContext({
      task: 'api UserController',
      seeds: ['api-controller.ts'],
      tokens: 8192
    });

    expect(result.includedFiles).toHaveLength(1);
    expect(result.includedFiles[0].path).toBe('api-controller.ts');
  });

  it('tests symbol matches, path matches, and keyword boosts', async () => {
    const mockStore = {
      getFile: (path: string) => ({ path, lines: 10, size_bytes: 100, language: 'typescript', role: 'styles' }),
      getSymbolByName: () => null,
      searchSymbolsFiltered: () => [],
      getAllFiles: () => [{ path: 'styles.css', language: 'css', lines: 10, size_bytes: 100, role: 'styles' }],
      getSymbolsForFile: () => [{ name: 'customTheme', kind: 'variable', scope: null, start_line: 1, end_line: 2 }],
      getEdgesForFile: () => [],
      raw: {
        prepare: () => ({
          all: () => []
        })
      }
    } as unknown as Store;

    const graph = new MapxGraph('test-repo');
    graph.addFileNode('styles.css', 'css', 100, 10);
    graph.computePageRank();

    const builder = new ContextBuilder(mockStore, graph);
    const result = await builder.buildContext({
      task: 'customTheme style userservice',
      tokens: 8000
    });

    expect(result.includedFiles).toHaveLength(1);
    expect(result.includedFiles[0].path).toBe('styles.css');
  });

  it('covers depth 1, depth 2, queue pushing, and cluster membership group boost', async () => {
    const mockStore = {
      getFile: (path: string) => {
        return { path, lines: 20, size_bytes: 200, language: 'typescript', role: 'core' };
      },
      getSymbolByName: (name: string) => {
        if (name === 'Seed') return { name: 'Seed', kind: 'class', file_path: 'a.ts' };
        return null;
      },
      searchSymbolsFiltered: () => [],
      getAllFiles: () => [
        { path: 'a.ts' },
        { path: 'b.ts' },
        { path: 'c.ts' },
        { path: 'd.ts' }
      ],
      getSymbolsForFile: () => [],
      getEdgesForFile: () => [],
      raw: {
        prepare: (sql: string) => {
          return {
            all: (...args: any[]) => {
              if (sql.includes('file_path IN')) {
                // First query is seed file clusters: expects cluster_name
                if (args.length === 1 && args[0] === 'a.ts') {
                  return [{ cluster_name: 'groupA' }];
                }
                // Second query is candidate file clusters: expects file_path and cluster_name
                return [
                  { file_path: 'a.ts', cluster_name: 'groupA' },
                  { file_path: 'b.ts', cluster_name: 'groupA' }, // b.ts matches seed cluster
                  { file_path: 'c.ts', cluster_name: 'groupB' }
                ];
              }
              return [];
            }
          };
        }
      }
    } as unknown as Store;

    const graph = new MapxGraph('test-repo');
    graph.addFileNode('a.ts', 'typescript', 200, 20);
    graph.addFileNode('b.ts', 'typescript', 200, 20);
    graph.addFileNode('c.ts', 'typescript', 200, 20);
    graph.addFileNode('d.ts', 'typescript', 200, 20);

    // a.ts -> b.ts -> c.ts -> d.ts
    graph.addDependencyEdge({
      sourceFile: 'a.ts',
      targetFile: 'b.ts',
      sourceSymbol: null,
      targetSymbol: null,
      edgeType: 'import',
      weight: 1,
      repo: 'test-repo'
    });
    graph.addDependencyEdge({
      sourceFile: 'b.ts',
      targetFile: 'c.ts',
      sourceSymbol: null,
      targetSymbol: null,
      edgeType: 'import',
      weight: 1,
      repo: 'test-repo'
    });
    graph.addDependencyEdge({
      sourceFile: 'c.ts',
      targetFile: 'd.ts',
      sourceSymbol: null,
      targetSymbol: null,
      edgeType: 'import',
      weight: 1,
      repo: 'test-repo'
    });

    graph.computePageRank();

    const builder = new ContextBuilder(mockStore, graph);
    const result = await builder.buildContext({
      task: 'do nothing',
      seeds: ['Seed'], // seed is 'a.ts'
      depth: 3,        // expand to depth 3 so we get d.ts (which is depth 3, score += 1)
      tokens: 10000
    });

    expect(result.includedFiles).toHaveLength(4);
    // Let's verify files are included
    const paths = result.includedFiles.map(f => f.path);
    expect(paths).toContain('a.ts');
    expect(paths).toContain('b.ts');
    expect(paths).toContain('c.ts');
    expect(paths).toContain('d.ts');
  });
});
