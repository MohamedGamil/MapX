import { describe, it, expect } from 'vitest';
import { MapxGraph } from '../src/core/graph.js';

describe('PageRank exclusion patterns', () => {
  function buildGraph(): MapxGraph {
    const graph = new MapxGraph('test-repo');
    graph.addFileNode('src/core/scanner.ts', 'typescript', 1000, 50);
    graph.addFileNode('src/core/store.ts', 'typescript', 800, 40);
    graph.addFileNode('src/utils/helpers.ts', 'typescript', 300, 20);
    graph.addFileNode('vendor/lib.ts', 'typescript', 200, 10);

    graph.addDependencyEdge({
      sourceFile: 'src/core/scanner.ts',
      targetFile: 'src/core/store.ts',
      sourceSymbol: null,
      targetSymbol: null,
      edgeType: 'import',
      weight: 1,
      repo: 'test-repo',
    });
    graph.addDependencyEdge({
      sourceFile: 'src/core/scanner.ts',
      targetFile: 'src/utils/helpers.ts',
      sourceSymbol: null,
      targetSymbol: null,
      edgeType: 'call',
      weight: 1,
      repo: 'test-repo',
    });

    return graph;
  }

  it('should filter out file nodes matching exclude patterns via glob', () => {
    const graph = buildGraph();
    // Use **/helpers.ts which is known to work with matchBase: true
    const scores = graph.computePageRank(['**/helpers.ts']);

    const fileKeys = [...scores.keys()].filter(k => k.startsWith('file://'));
    expect(fileKeys.some(k => k.includes('helpers'))).toBe(false);
    // Other files still present
    expect(fileKeys.some(k => k.includes('scanner'))).toBe(true);
    expect(fileKeys.some(k => k.includes('store'))).toBe(true);
  });

  it('should filter multiple patterns simultaneously', () => {
    const graph = buildGraph();
    const scores = graph.computePageRank(['**/helpers.ts', '**/lib.ts']);

    const fileKeys = [...scores.keys()].filter(k => k.startsWith('file://'));
    expect(fileKeys.some(k => k.includes('helpers'))).toBe(false);
    expect(fileKeys.some(k => k.includes('lib.ts'))).toBe(false);
    // Remaining files preserved
    expect(fileKeys.some(k => k.includes('scanner'))).toBe(true);
    expect(fileKeys.some(k => k.includes('store'))).toBe(true);
  });

  it('should preserve non-matching file nodes', () => {
    const graph = buildGraph();
    const scores = graph.computePageRank(['**/helpers.ts']);

    const keys = [...scores.keys()];
    expect(keys.some(k => k.includes('scanner'))).toBe(true);
    expect(keys.some(k => k.includes('store'))).toBe(true);
    expect(keys.some(k => k.includes('vendor'))).toBe(true);
  });

  it('should not filter anything when excludePatterns is empty', () => {
    const graph = buildGraph();
    const withEmpty = graph.computePageRank([]);
    const withoutArg = graph.computePageRank();

    // Both should have same number of entries
    expect(withEmpty.size).toBe(withoutArg.size);
  });

  it('should not filter anything when excludePatterns is undefined', () => {
    const graph = buildGraph();
    const scores = graph.computePageRank(undefined);

    const fileKeys = [...scores.keys()].filter(k => k.startsWith('file://'));
    expect(fileKeys.some(k => k.includes('scanner'))).toBe(true);
    expect(fileKeys.some(k => k.includes('vendor'))).toBe(true);
  });

  it('should preserve symbol nodes even when their parent file is excluded', () => {
    const graph = buildGraph();
    // Add a symbol to a file that will be excluded
    graph.addSymbolNode('helperFn', 'src/utils/helpers.ts', 'helperFn', 'function', 1, 10, null);

    const scores = graph.computePageRank(['**/helpers.ts']);

    const fileKeys = [...scores.keys()].filter(k => k.startsWith('file://'));
    const symbolKeys = [...scores.keys()].filter(k => k.startsWith('symbol://'));
    // The file node for helpers.ts should be gone
    expect(fileKeys.some(k => k.includes('helpers'))).toBe(false);
    // The symbol node should survive (type !== 'file')
    expect(symbolKeys.some(k => k.includes('helpers'))).toBe(true);
  });

  it('should return empty map for empty graph even with patterns', () => {
    const emptyGraph = new MapxGraph('empty');
    const scores = emptyGraph.computePageRank(['**/*']);
    expect(scores.size).toBe(0);
  });
});
