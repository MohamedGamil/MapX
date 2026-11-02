import { vi, describe, it, expect } from 'vitest';
import { Scanner } from '../src/core/scanner.js';
import type { Store } from '../src/core/store.js';
import type { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import * as fsPromises from 'node:fs/promises';

// Mock git-tracker to say it is NOT a git repo, forcing the hash-based incremental scanner path
vi.mock('../src/core/git-tracker.js', () => ({
  isGitRepo: () => false,
  getGitBlobHashes: () => new Map(),
  getChangedFiles: () => [],
  getCurrentCommitSha: () => '',
}));

vi.mock('../src/parsers/parser-registry.js', () => ({
  getParserForFile: () => ({
    parse: vi.fn().mockResolvedValue({
      symbols: [{ name: 'A', kind: 'class', startLine: 1, endLine: 10, scope: null }],
      references: [],
      errors: []
    })
  })
}));

vi.mock('../src/languages/registry.js', () => ({
  getLanguageForFile: () => ({ name: 'typescript' }),
  areLanguagesCompatible: () => true,
  getBuiltinLanguages: () => ({})
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (path: string) => {
      if (path.endsWith('scan.lock')) return false;
      return true;
    },
    readFileSync: () => 'data'
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: vi.fn().mockImplementation(async () => 'export class A {}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    readdir: vi.fn().mockResolvedValue([
      { name: 'a.ts', isFile: () => true, isDirectory: () => false }
    ]),
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    } as any)
  };
});

describe('Non-git incremental scan (hash-based)', () => {
  const createMockStore = (overrides?: any) => ({
    getMeta: vi.fn().mockReturnValue(null),
    setMeta: vi.fn(),
    getAllFiles: vi.fn().mockReturnValue([]),
    getRepoNames: vi.fn().mockReturnValue([]),
    deleteEdgesByType: vi.fn(),
    getAllEdges: vi.fn().mockReturnValue([]),
    getAllSymbols: vi.fn().mockReturnValue([]),
    getSymbolsForFile: vi.fn().mockReturnValue([]),
    upsertFile: vi.fn(),
    deleteFile: vi.fn(),
    deleteSymbolsForFile: vi.fn(),
    deleteEdgesForFile: vi.fn(),
    getImporters: vi.fn().mockReturnValue([]),
    getFile: vi.fn().mockReturnValue(undefined),
    filesWithMetadataText: vi.fn().mockReturnValue([]),
    setFileHashes: vi.fn(),
    replaceExternalRefs: vi.fn(),
    deleteOrphanExternalCandidates: vi.fn(),
    getExternalCandidates: vi.fn().mockReturnValue([]),
    insertSymbol: vi.fn(),
    insertEdge: vi.fn(),
    updateFileMetadata: vi.fn(),
    deleteFrameworkEdgesForRepo: vi.fn(),
    resetRepoForScan: vi.fn(),
    clearClusters: vi.fn(),
    insertCluster: vi.fn(),
    insertClusterMembership: vi.fn(),
    deleteClassificationSignalsForFile: vi.fn(),
    updateFileRole: vi.fn(),
    insertClassificationSignal: vi.fn(),
    insertClusterMetrics: vi.fn(),
    insertArchSmell: vi.fn(),
    inTransaction: vi.fn().mockImplementation((fn: () => void) => fn()),
    raw: {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), run: vi.fn(), get: vi.fn() })
    },
    ...overrides
  } as unknown as Store);

  it('runs incremental scan by comparing hashes', async () => {
    // Seed store with one file having a certain hash
    const mockStore = createMockStore({
      getAllFiles: () => [
        { path: 'a.ts', content_hash: 'oldhash', repo: 'repo1' }
      ]
    });

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    // Mock readdir to return two files: a.ts (modified, new hash) and b.ts (new)
    vi.mocked(fsPromises.readdir).mockResolvedValue([
      { name: 'a.ts', isFile: () => true, isDirectory: () => false } as any,
      { name: 'b.ts', isFile: () => true, isDirectory: () => false } as any
    ]);

    // Mock stat for size/lines
    vi.mocked(fsPromises.stat).mockResolvedValue({ size: 150 } as any);

    // Mock readFile to return content which will yield a different hash for a.ts than 'oldhash'
    vi.mocked(fsPromises.readFile).mockImplementation(async (path) => {
      if (path.toString().endsWith('a.ts')) return 'modified content';
      return 'new file content';
    });

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Run incremental scan
    const result = await scanner.scanIncremental(['repo1']);

    // Check filesScanned is 2 because a.ts changed hash, and b.ts is new
    expect(result.filesScanned).toBe(2);
    expect(mockStore.deleteSymbolsForFile).toHaveBeenCalledWith('a.ts');
    expect(mockStore.upsertFile).toHaveBeenCalled();
  });
});
