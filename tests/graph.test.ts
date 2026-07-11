import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MapxGraph } from '../src/core/graph.js';

describe('MapxGraph', () => {
  let graph: MapxGraph;

  beforeAll(() => {
    graph = new MapxGraph('test-repo');
  });

  describe('File nodes', () => {
    it('should add a file node', () => {
      graph.addFileNode('src/index.ts', 'typescript', 1024, 50);
      expect(graph.getFileCount()).toBe(1);
    });

    it('should merge attributes when adding same file twice', () => {
      graph.addFileNode('src/index.ts', 'typescript', 2048, 100);
      expect(graph.getFileCount()).toBe(1); // Still one node
    });

    it('should track multiple file nodes', () => {
      graph.addFileNode('src/utils.ts', 'typescript', 512, 30);
      graph.addFileNode('src/config.ts', 'typescript', 256, 15);
      expect(graph.getFileCount()).toBe(3);
    });
  });

  describe('Symbol nodes', () => {
    it('should add a symbol node linked to its file', () => {
      graph.addSymbolNode('MyClass', 'src/index.ts', 'MyClass', 'class', 1, 50, null);
      expect(graph.getSymbolCount()).toBe(1);
    });

    it('should link symbols to parent scope', () => {
      graph.addSymbolNode('myMethod', 'src/index.ts', 'myMethod', 'method', 10, 20, 'MyClass');
      expect(graph.getSymbolCount()).toBe(2);
    });

    it('should merge attributes for duplicate symbol nodes', () => {
      graph.addSymbolNode('MyClass', 'src/index.ts', 'MyClass', 'class', 1, 55, null);
      expect(graph.getSymbolCount()).toBe(2); // Still 2
    });

    it('should not create parent link if parent does not exist', () => {
      // orphanFn has scope "NonExistentClass" which is not in the graph
      graph.addSymbolNode('orphanFn', 'src/utils.ts', 'orphanFn', 'function', 1, 10, 'NonExistentClass');
      expect(graph.getSymbolCount()).toBe(3);
    });
  });

  describe('Dependency edges', () => {
    it('should add a dependency edge between files', () => {
      graph.addDependencyEdge({
        sourceFile: 'src/index.ts',
        targetFile: 'src/utils.ts',
        sourceSymbol: 'MyClass',
        targetSymbol: 'helper',
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });
      expect(graph.getEdgeCount()).toBe(1);
    });

    it('should not duplicate edges', () => {
      graph.addDependencyEdge({
        sourceFile: 'src/index.ts',
        targetFile: 'src/utils.ts',
        sourceSymbol: 'MyClass',
        targetSymbol: 'helper',
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });
      expect(graph.getEdgeCount()).toBe(1);
    });

    it('should add edges of different types between same files', () => {
      graph.addDependencyEdge({
        sourceFile: 'src/index.ts',
        targetFile: 'src/config.ts',
        sourceSymbol: null,
        targetSymbol: null,
        edgeType: 'call',
        weight: 2,
        repo: 'test-repo',
      });
      expect(graph.getEdgeCount()).toBe(2);
    });

    it('should ignore edges where source node does not exist', () => {
      graph.addDependencyEdge({
        sourceFile: 'nonexistent.ts',
        targetFile: 'src/utils.ts',
        sourceSymbol: null,
        targetSymbol: null,
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });
      expect(graph.getEdgeCount()).toBe(2);
    });

    it('should handle verifiability and metadata', () => {
      graph.addDependencyEdge({
        sourceFile: 'src/utils.ts',
        targetFile: 'src/config.ts',
        sourceSymbol: 'helper',
        targetSymbol: 'Config',
        edgeType: 'call',
        weight: 1,
        verifiability: 'inferred',
        metadata: { startLine: 5 },
        repo: 'test-repo',
      });
      expect(graph.getEdgeCount()).toBe(3);
    });
  });

  describe('getDependencies', () => {
    it('should return forward dependencies for a file', () => {
      const deps = graph.getDependencies('src/index.ts');
      expect(deps.length).toBeGreaterThan(0);
      expect(deps.some(d => d.target === 'src/utils.ts')).toBe(true);
    });

    it('should return empty array for unknown file', () => {
      const deps = graph.getDependencies('nonexistent.ts');
      expect(deps).toEqual([]);
    });

    it('should not include "contains" edges', () => {
      const deps = graph.getDependencies('src/index.ts');
      expect(deps.every(d => d.type !== 'contains')).toBe(true);
    });
  });

  describe('getReverseDependencies', () => {
    it('should return reverse dependencies for a file', () => {
      const rdeps = graph.getReverseDependencies('src/utils.ts');
      expect(rdeps.length).toBeGreaterThan(0);
      expect(rdeps.some(d => d.source === 'src/index.ts')).toBe(true);
    });

    it('should return empty array for unknown file', () => {
      const rdeps = graph.getReverseDependencies('nonexistent.ts');
      expect(rdeps).toEqual([]);
    });
  });

  describe('PageRank', () => {
    it('should compute PageRank without errors', () => {
      const scores = graph.computePageRank();
      expect(scores.size).toBeGreaterThan(0);
    });

    it('should rank files by PageRank', () => {
      const ranked = graph.getRankedFiles();
      expect(ranked.length).toBeGreaterThan(0);
      // Should be sorted descending by pagerank
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].pagerank).toBeGreaterThanOrEqual(ranked[i].pagerank);
      }
    });

    it('should rank symbols by derived score', () => {
      const ranked = graph.getRankedSymbols();
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]).toHaveProperty('name');
      expect(ranked[0]).toHaveProperty('kind');
      expect(ranked[0]).toHaveProperty('filePath');
      expect(ranked[0]).toHaveProperty('pagerank');
    });
  });

  describe('Counts', () => {
    it('getFileCount should return correct count', () => {
      expect(graph.getFileCount()).toBe(3);
    });

    it('getSymbolCount should return correct count', () => {
      expect(graph.getSymbolCount()).toBe(3);
    });

    it('getEdgeCount should exclude "contains" edges', () => {
      const edgeCount = graph.getEdgeCount();
      expect(edgeCount).toBe(3);
    });
  });

  describe('dropFrameworkEdgesForRepo', () => {
    it('should drop framework edges', () => {
      graph.addDependencyEdge({
        sourceFile: 'src/index.ts',
        targetFile: 'src/utils.ts',
        sourceSymbol: null,
        targetSymbol: null,
        edgeType: 'route',
        weight: 1,
        repo: 'test-repo',
      });
      const beforeCount = graph.getEdgeCount();
      graph.dropFrameworkEdgesForRepo('test-repo');
      expect(graph.getEdgeCount()).toBe(beforeCount - 1);
    });

    it('should not drop non-framework edges', () => {
      const count = graph.getEdgeCount();
      graph.dropFrameworkEdgesForRepo('test-repo');
      expect(graph.getEdgeCount()).toBe(count); // nothing to drop
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON and back', () => {
      const json = graph.toJSON();
      expect(json).toBeDefined();

      const restored = MapxGraph.fromJSON(json, 'test-repo');
      expect(restored.getFileCount()).toBe(graph.getFileCount());
      expect(restored.getSymbolCount()).toBe(graph.getSymbolCount());
    });
  });

  describe('Edge cases', () => {
    it('should handle empty graph PageRank', () => {
      const empty = new MapxGraph('empty');
      const scores = empty.computePageRank();
      expect(scores.size).toBe(0);
    });

    it('should return empty deps for file with no outgoing edges', () => {
      const g = new MapxGraph('isolated');
      g.addFileNode('lonely.ts', 'typescript', 100, 10);
      expect(g.getDependencies('lonely.ts')).toEqual([]);
      expect(g.getReverseDependencies('lonely.ts')).toEqual([]);
    });
  });
});
