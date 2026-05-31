import { describe, it, expect } from 'vitest';
import { ClusterEngine } from '../src/core/cluster-engine.js';
import type { Store } from '../src/core/store.js';

describe('ClusterEngine module', () => {
  it('detects namespace, directory, and community clusters correctly', () => {
    const insertedClusters: any[] = [];
    const insertedMemberships: any[] = [];

    const mockStore = {
      getAllFiles: (repo?: string) => [
        // Namespace clusters
        { path: 'src/core/a.ts', namespace: 'MapX.Core', metadata: '{}' },
        { path: 'src/core/b.ts', namespace: 'MapX.Core', metadata: '{}' },
        // Directory clusters (will group under src.utils)
        { path: 'src/utils/c.ts', namespace: null, metadata: '{}' },
        { path: 'src/utils/d.ts', namespace: null, metadata: '{}' },
        // Community clusters (will connect via edges in different dirs to avoid directory overlap)
        { path: 'src/comm1/e.ts', namespace: null, metadata: '{}' },
        { path: 'src/comm2/f.ts', namespace: null, metadata: '{}' },
        { path: 'src/comm3/g.ts', namespace: null, metadata: '{}' }
      ],
      getAllEdges: (repo?: string) => [
        // Triangle relation forming a distinct community
        { source_file: 'src/comm1/e.ts', target_file: 'src/comm2/f.ts' },
        { source_file: 'src/comm2/f.ts', target_file: 'src/comm3/g.ts' },
        { source_file: 'src/comm3/g.ts', target_file: 'src/comm1/e.ts' }
      ],
      inTransaction: (fn: () => void) => fn(),
      clearClusters: (repo?: string) => {},
      insertCluster: (c: any) => {
        insertedClusters.push(c);
      },
      insertClusterMembership: (m: any) => {
        insertedMemberships.push(m);
      }
    } as unknown as Store;

    const engine = new ClusterEngine(mockStore);
    const result = engine.detect('test-repo');

    expect(result.clustersFound).toBeGreaterThan(0);
    expect(result.namespaceClusters).toBeGreaterThan(0);
    expect(result.directoryClusters).toBeGreaterThan(0);
    expect(result.communityClusters).toBeGreaterThan(0);

    // Verify clusters were saved to store
    expect(insertedClusters.some(c => c.name === 'MapX.Core')).toBe(true);
    expect(insertedClusters.some(c => c.name === 'src.utils')).toBe(true);
    expect(insertedClusters.some(c => c.source === 'community')).toBe(true);

    // Verify memberships
    expect(insertedMemberships.some(m => m.filePath === 'src/core/a.ts' && m.clusterName === 'MapX.Core')).toBe(true);
    expect(insertedMemberships.some(m => m.filePath === 'src/utils/c.ts' && m.clusterName === 'src.utils')).toBe(true);
  });
});

describe('ClusterEngine.assignFileLayer', () => {
  const { assignFileLayer } = ClusterEngine;

  it('classifies test files', () => {
    expect(assignFileLayer('tests/cli.test.ts')).toBe('test');
    expect(assignFileLayer('src/__tests__/foo.spec.ts')).toBe('test');
    expect(assignFileLayer('src/bar.test.js')).toBe('test');
  });

  it('classifies config files', () => {
    expect(assignFileLayer('tsconfig.json')).toBe('config');
    expect(assignFileLayer('vitest.config.ts')).toBe('config');
    expect(assignFileLayer('config/settings.ts')).toBe('config');
  });

  it('classifies type definition files', () => {
    expect(assignFileLayer('src/types.ts')).toBe('types');
    expect(assignFileLayer('types/index.d.ts')).toBe('types');
    expect(assignFileLayer('src/app.types.ts')).toBe('types');
  });

  it('classifies UI files', () => {
    expect(assignFileLayer('src/ui/main.ts')).toBe('ui');
    expect(assignFileLayer('frontend/App.vue')).toBe('ui');
    expect(assignFileLayer('src/components/Button.tsx')).toBe('ui');
  });

  it('classifies agent files', () => {
    expect(assignFileLayer('src/agents/templates.ts')).toBe('agents');
    expect(assignFileLayer('src/agents.stub.md')).toBe('agents');
  });

  it('classifies exporter files', () => {
    expect(assignFileLayer('src/exporters/dot-exporter.ts')).toBe('exporters');
    expect(assignFileLayer('src/export/llm-export.ts')).toBe('exporters');
  });

  it('classifies parser files', () => {
    expect(assignFileLayer('src/parsers/php.ts')).toBe('parsers');
    expect(assignFileLayer('src/languages/typescript.ts')).toBe('parsers');
  });

  it('classifies framework files', () => {
    expect(assignFileLayer('src/frameworks/express-detector.ts')).toBe('frameworks');
    expect(assignFileLayer('src/plugins/laravel.ts')).toBe('frameworks');
  });

  it('classifies API / route files', () => {
    expect(assignFileLayer('src/api/users.ts')).toBe('api');
    expect(assignFileLayer('src/routes/auth.ts')).toBe('api');
  });

  it('classifies data / store files', () => {
    expect(assignFileLayer('src/core/store.ts')).toBe('data');
    expect(assignFileLayer('src/db/migrations/001.ts')).toBe('data');
  });

  it('classifies utility files', () => {
    expect(assignFileLayer('src/utils/helpers.ts')).toBe('utils');
    expect(assignFileLayer('lib/shared.ts')).toBe('utils');
  });

  it('classifies core / service / engine files', () => {
    expect(assignFileLayer('src/core/scanner.ts')).toBe('core');
    expect(assignFileLayer('src/core/cluster-engine.ts')).toBe('core');
    expect(assignFileLayer('src/workspace-manager.ts')).toBe('core');
  });

  it('classifies CLI / entry files', () => {
    expect(assignFileLayer('src/cli.ts')).toBe('entry');
    expect(assignFileLayer('src/main.ts')).toBe('entry');
    expect(assignFileLayer('bin/mapx.ts')).toBe('entry');
  });

  it('classifies script files', () => {
    expect(assignFileLayer('scripts/build-all.ts')).toBe('scripts');
    expect(assignFileLayer('tools/sync-version.ts')).toBe('scripts');
  });

  it('classifies doc files', () => {
    expect(assignFileLayer('docs/getting-started.md')).toBe('docs');
    expect(assignFileLayer('README.md')).toBe('docs');
  });

  it('falls back to other for unrecognised paths', () => {
    expect(assignFileLayer('scratch/demo.ts')).toBe('other');
    expect(assignFileLayer('misc/foo.ts')).toBe('other');
  });
});

describe('ClusterEngine layer detection integration', () => {
  it('detects and persists layer clusters', () => {
    const insertedClusters: any[] = [];
    const insertedMemberships: any[] = [];

    const mockStore = {
      getAllFiles: () => [
        { path: 'src/cli.ts', namespace: null, metadata: '{}' },
        { path: 'src/core/scanner.ts', namespace: null, metadata: '{}' },
        { path: 'src/core/store.ts', namespace: null, metadata: '{}' },
        { path: 'src/exporters/dot-exporter.ts', namespace: null, metadata: '{}' },
        { path: 'tests/cli.test.ts', namespace: null, metadata: '{}' },
      ],
      getAllEdges: () => [],
      inTransaction: (fn: () => void) => fn(),
      clearClusters: () => {},
      insertCluster: (c: any) => { insertedClusters.push(c); },
      insertClusterMembership: (m: any) => { insertedMemberships.push(m); },
    } as unknown as Store;

    const engine = new ClusterEngine(mockStore);
    const result = engine.detect('repo');

    expect(result.layerClusters).toBeGreaterThan(0);

    const layerClusters = insertedClusters.filter(c => c.source === 'layer');
    expect(layerClusters.length).toBeGreaterThan(0);
    expect(layerClusters.every(c => c.layer !== undefined)).toBe(true);

    // entry layer cluster should exist and contain cli.ts
    const entryCluster = layerClusters.find(c => c.name === 'layer:entry');
    expect(entryCluster).toBeDefined();
    expect(insertedMemberships.some(m => m.filePath === 'src/cli.ts' && m.clusterName === 'layer:entry')).toBe(true);

    // test layer cluster should contain the test file
    expect(insertedMemberships.some(m => m.filePath === 'tests/cli.test.ts' && m.clusterName === 'layer:test')).toBe(true);

    // exporters layer cluster
    expect(insertedMemberships.some(m => m.filePath === 'src/exporters/dot-exporter.ts' && m.clusterName === 'layer:exporters')).toBe(true);
  });
});
