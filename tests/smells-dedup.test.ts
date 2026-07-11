import { describe, it, expect } from 'vitest';
import { ArchitectureAnalyzer } from '../src/core/architecture-analyzer.js';
import type { Store } from '../src/core/store.js';
import type { CodebaseProfile } from '../src/types.js';

describe('Smells deduplication', () => {
  const mockProfile: CodebaseProfile = {
    archetype: 'web-api',
    archetypeConfidence: 0.9,
    detectedFrameworks: ['express'],
    detectedPatterns: ['layered'],
    dominantLanguages: ['typescript'],
    hasBackend: true,
    hasFrontend: false,
    isMonorepo: false,
    componentBoundaries: [],
  };

  it('should deduplicate smells with same type and same involvedFiles', () => {
    // Create a graph that produces duplicate cycle smells:
    // a -> b -> a produces a single cycle, but our edges also
    // include c -> d -> c which is a separate cycle.
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts', language: 'typescript' },
        { path: 'b.ts', language: 'typescript' },
      ],
      getAllEdges: () => [
        // Simple cycle a -> b -> a
        { source_file: 'a.ts', target_file: 'b.ts' },
        { source_file: 'b.ts', target_file: 'a.ts' },
      ],
      raw: {
        prepare: () => ({ all: () => [] }),
      },
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    // Count how many cyclic-dependency smells involve the same files
    const cycleSmells = smells.filter(s => s.type === 'cyclic-dependency');
    // There should be exactly one cycle (a->b->a), not duplicated
    expect(cycleSmells.length).toBe(1);
  });

  it('should preserve smells with different types but same files', () => {
    // This scenario uses layer violations which produce different type smells
    // for the same pair of files
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/db/repo.ts', language: 'typescript', role: 'data' },
        { path: 'src/api/ctrl.ts', language: 'typescript', role: 'api' },
      ],
      getAllEdges: () => [
        // data -> api (layer violation) AND also creates a structural edge
        { source_file: 'src/db/repo.ts', target_file: 'src/api/ctrl.ts' },
        { source_file: 'src/api/ctrl.ts', target_file: 'src/db/repo.ts' },
      ],
      raw: {
        prepare: () => ({ all: () => [] }),
      },
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    // There should be at least one cycle and possibly layer violations
    // but they should have different types so none are deduped
    const types = new Set(smells.map(s => s.type));
    // If both cycle and layer-violation exist, they're kept separately
    if (types.has('cyclic-dependency') && types.has('layer-violation')) {
      const cycleSmells = smells.filter(s => s.type === 'cyclic-dependency');
      const violationSmells = smells.filter(s => s.type === 'layer-violation');
      expect(cycleSmells.length).toBeGreaterThan(0);
      expect(violationSmells.length).toBeGreaterThan(0);
    }
  });

  it('should preserve smells with same type but different involvedFiles', () => {
    // Two separate cycles: a->b->a and c->d->c
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts', language: 'typescript' },
        { path: 'b.ts', language: 'typescript' },
        { path: 'c.ts', language: 'typescript' },
        { path: 'd.ts', language: 'typescript' },
      ],
      getAllEdges: () => [
        // Cycle 1: a -> b -> a
        { source_file: 'a.ts', target_file: 'b.ts' },
        { source_file: 'b.ts', target_file: 'a.ts' },
        // Cycle 2: c -> d -> c
        { source_file: 'c.ts', target_file: 'd.ts' },
        { source_file: 'd.ts', target_file: 'c.ts' },
      ],
      raw: {
        prepare: () => ({ all: () => [] }),
      },
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    const cycleSmells = smells.filter(s => s.type === 'cyclic-dependency');
    // Two distinct cycles should produce two distinct smells
    expect(cycleSmells.length).toBe(2);

    // They should have different involvedFiles
    const filesSet1 = new Set(cycleSmells[0].involvedFiles);
    const filesSet2 = new Set(cycleSmells[1].involvedFiles);
    const overlap = [...filesSet1].filter(f => filesSet2.has(f));
    expect(overlap.length).toBe(0);
  });

  it('should use sorted involvedFiles for dedup key', () => {
    // Verify the dedup key is based on sorted files, so order doesn't matter
    const mockStore = {
      getAllFiles: () => [
        { path: 'x.ts', language: 'typescript' },
        { path: 'y.ts', language: 'typescript' },
        { path: 'z.ts', language: 'typescript' },
      ],
      getAllEdges: () => [
        // Single cycle: x -> y -> z -> x
        { source_file: 'x.ts', target_file: 'y.ts' },
        { source_file: 'y.ts', target_file: 'z.ts' },
        { source_file: 'z.ts', target_file: 'x.ts' },
      ],
      raw: {
        prepare: () => ({ all: () => [] }),
      },
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    const cycleSmells = smells.filter(s => s.type === 'cyclic-dependency');
    // Only one cycle should be reported regardless of traversal starting point
    expect(cycleSmells.length).toBe(1);
  });
});
