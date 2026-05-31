import { describe, it, expect, vi } from 'vitest';
import { RoleClassifier } from '../src/core/role-classifier.js';
import type { Store } from '../src/core/store.js';
import type { CodebaseProfile } from '../src/types.js';

describe('RoleClassifier', () => {
  const mockStore = {
    getSymbolsForFile: () => [],
    getEdgesForFile: () => [],
    getReverseEdges: () => [],
    raw: {
      prepare: () => ({ get: () => ({ count: 0 }) })
    }
  } as unknown as Store;

  const mockProfile: CodebaseProfile = {
    archetype: 'full-stack',
    archetypeConfidence: 0.8,
    detectedFrameworks: ['express', 'react'],
    detectedPatterns: ['mvc'],
    dominantLanguages: ['typescript'],
    hasBackend: true,
    hasFrontend: true,
    isMonorepo: false,
    componentBoundaries: []
  };

  it('classifies UI components correctly based on path', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/components/Header.tsx', 'test-repo', mockProfile);

    expect(result.role).toBe('components');
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('classifies API route files correctly based on path and naming', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/routes/userRoute.ts', 'test-repo', mockProfile);

    expect(result.role).toBe('api');
  });

  it('respects user config overrides', () => {
    const mockConfig = {
      settings: {
        architecture: {
          overrides: {
            'src/custom-folder/**': 'service'
          }
        }
      }
    };
    const classifier = new RoleClassifier(mockStore, mockConfig);
    const result = classifier.classify('src/custom-folder/my-file.ts', 'test-repo', mockProfile);

    expect(result.role).toBe('service');
    expect(result.confidence).toBe(1.0);
    expect(result.signals[0].reason).toContain('Explicitly overridden');
  });

  it('classifies test files correctly', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/components/Header.test.tsx', 'test-repo', mockProfile);

    expect(result.role).toBe('test');
  });

  it('classifies core tool logic for tool archetypes', () => {
    const cliProfile: CodebaseProfile = {
      ...mockProfile,
      archetype: 'cli-tool',
      hasBackend: false,
      hasFrontend: false
    };
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('src/core/engine.ts', 'test-repo', cliProfile);

    expect(result.role).toBe('core');
  });

  it('classifies markdown files as docs', () => {
    const classifier = new RoleClassifier(mockStore);
    const result = classifier.classify('docs/README.md', 'test-repo', mockProfile);

    expect(result.role).toBe('docs');
    expect(result.confidence).toBe(1.0);
    expect(result.signals[0].reason).toContain('Markdown files are always classified');
  });
});
