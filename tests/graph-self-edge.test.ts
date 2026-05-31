import { describe, it, expect } from 'vitest';
import { MapxGraph } from '../src/core/graph.js';

describe('Graph self-edge guard', () => {
  describe('addDependencyEdge ignores self-edges', () => {
    it('should silently discard an edge where sourceFile === targetFile', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/a.ts', 'typescript', 100, 10);

      graph.addDependencyEdge({
        sourceFile: 'src/a.ts',
        targetFile: 'src/a.ts',
        sourceSymbol: 'Foo',
        targetSymbol: 'Bar',
        edgeType: 'call',
        weight: 1,
        repo: 'test-repo',
      });

      expect(graph.getEdgeCount()).toBe(0);
    });

    it('should still allow edges between distinct files', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/a.ts', 'typescript', 100, 10);
      graph.addFileNode('src/b.ts', 'typescript', 100, 10);

      graph.addDependencyEdge({
        sourceFile: 'src/a.ts',
        targetFile: 'src/b.ts',
        sourceSymbol: 'Foo',
        targetSymbol: 'Bar',
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });

      expect(graph.getEdgeCount()).toBe(1);
    });

    it('should not increment edge count for multiple self-edges', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/a.ts', 'typescript', 100, 10);

      // Add multiple self-edges with different types
      graph.addDependencyEdge({
        sourceFile: 'src/a.ts',
        targetFile: 'src/a.ts',
        sourceSymbol: null,
        targetSymbol: null,
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });
      graph.addDependencyEdge({
        sourceFile: 'src/a.ts',
        targetFile: 'src/a.ts',
        sourceSymbol: 'X',
        targetSymbol: 'Y',
        edgeType: 'call',
        weight: 2,
        repo: 'test-repo',
      });

      expect(graph.getEdgeCount()).toBe(0);
    });
  });

  describe('getDependencies filters self-edges', () => {
    it('should not return a self-edge in forward dependencies', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/a.ts', 'typescript', 100, 10);
      graph.addFileNode('src/b.ts', 'typescript', 100, 10);

      graph.addDependencyEdge({
        sourceFile: 'src/a.ts',
        targetFile: 'src/b.ts',
        sourceSymbol: null,
        targetSymbol: null,
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });

      const deps = graph.getDependencies('src/a.ts');
      expect(deps).toHaveLength(1);
      expect(deps[0].target).toBe('src/b.ts');
      // None of the results should reference back to the source
      expect(deps.every(d => d.target !== 'src/a.ts')).toBe(true);
    });

    it('should return empty when file has only self-referencing edges', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/lonely.ts', 'typescript', 100, 10);
      // No edges can even be added due to the guard, but verify getDependencies still works
      expect(graph.getDependencies('src/lonely.ts')).toEqual([]);
    });
  });

  describe('getReverseDependencies filters self-edges', () => {
    it('should not return a self-edge in reverse dependencies', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/a.ts', 'typescript', 100, 10);
      graph.addFileNode('src/b.ts', 'typescript', 100, 10);

      graph.addDependencyEdge({
        sourceFile: 'src/a.ts',
        targetFile: 'src/b.ts',
        sourceSymbol: null,
        targetSymbol: null,
        edgeType: 'import',
        weight: 1,
        repo: 'test-repo',
      });

      const rdeps = graph.getReverseDependencies('src/b.ts');
      expect(rdeps).toHaveLength(1);
      expect(rdeps[0].source).toBe('src/a.ts');
      // None of the results should reference back to self
      expect(rdeps.every(d => d.source !== 'src/b.ts')).toBe(true);
    });

    it('should return empty for an isolated file with no incoming edges', () => {
      const graph = new MapxGraph('test-repo');
      graph.addFileNode('src/isolated.ts', 'typescript', 100, 10);
      expect(graph.getReverseDependencies('src/isolated.ts')).toEqual([]);
    });
  });
});
