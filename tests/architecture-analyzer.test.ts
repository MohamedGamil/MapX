import { describe, it, expect } from 'vitest';
import { ArchitectureAnalyzer } from '../src/core/architecture-analyzer.js';
import type { Store } from '../src/core/store.js';
import type { CodebaseProfile } from '../src/types.js';

describe('ArchitectureAnalyzer', () => {
  const mockProfile: CodebaseProfile = {
    archetype: 'web-api',
    archetypeConfidence: 0.9,
    detectedFrameworks: ['express'],
    detectedPatterns: ['layered'],
    dominantLanguages: ['typescript'],
    hasBackend: true,
    hasFrontend: false,
    isMonorepo: false,
    componentBoundaries: []
  };

  it('detects cyclic dependencies correctly', () => {
    // a -> b -> c -> a
    const mockStore = {
      getAllFiles: () => [
        { path: 'a.ts', language: 'typescript' },
        { path: 'b.ts', language: 'typescript' },
        { path: 'c.ts', language: 'typescript' }
      ],
      getAllEdges: () => [
        { source_file: 'a.ts', target_file: 'b.ts' },
        { source_file: 'b.ts', target_file: 'c.ts' },
        { source_file: 'c.ts', target_file: 'a.ts' }
      ],
      raw: {
        prepare: () => ({ all: () => [] })
      }
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    const cycles = smells.filter(s => s.type === 'cyclic-dependency');
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].severity).toBe('critical');
    expect(cycles[0].involvedFiles).toContain('a.ts');
    expect(cycles[0].involvedFiles).toContain('b.ts');
    expect(cycles[0].involvedFiles).toContain('c.ts');
  });

  it('detects layer violations', () => {
    // Data layer imports api layer (violating layered/clean architecture dependency rules)
    const mockStore = {
      getAllFiles: () => [
        { path: 'src/controllers/UserController.ts', language: 'typescript', role: 'api' },
        { path: 'src/db/userRepo.ts', language: 'typescript', role: 'data' }
      ],
      getAllEdges: () => [
        // src imports target: data imports api (violation)
        { source_file: 'src/db/userRepo.ts', target_file: 'src/controllers/UserController.ts' }
      ],
      raw: {
        prepare: () => ({ all: () => [] })
      }
    } as unknown as Store;

    const analyzer = new ArchitectureAnalyzer(mockStore);
    const smells = analyzer.analyze('test-repo', mockProfile);

    const violations = smells.filter(s => s.type === 'layer-violation');
    expect(violations.length).toBeGreaterThan(0);
  });
});
