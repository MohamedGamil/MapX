import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Scanner } from '../src/core/scanner.js';
import type { DiscoveredFile } from '../src/core/scanner.js';
import type { ExtractedReference } from '../src/types.js';
import type { Store } from '../src/core/store.js';
import type { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';

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

// Mock ArchitectureAnalyzer to return smells
vi.mock('../src/core/architecture-analyzer.js', () => {
  return {
    ArchitectureAnalyzer: class {
      analyze = () => [
        {
          type: 'cyclic-dependency',
          severity: 'high',
          description: 'A cyclic dependency exists',
          involvedFiles: ['a.ts', 'b.ts'],
          involvedClusters: ['core'],
          suggestion: 'break the cycle'
        }
      ];
    }
  };
});

vi.mock('node:worker_threads', () => {
  class MockWorker {
    url: any;
    options: any;
    listeners = new Map<string, Array<Function>>();

    constructor(url: any, options: any) {
      this.url = url;
      this.options = options;
      process.nextTick(() => {
        if ((globalThis as any).mockWorkerFailInit) {
          this.emit('message', { type: 'error', error: 'Init failed' });
        } else if ((globalThis as any).mockWorkerThrowOnMessage) {
          this.emit('error', new Error('Immediate error'));
        } else {
          this.emit('message', { type: 'ready' });
        }
      });
    }

    on(event: string, cb: Function) {
      const list = this.listeners.get(event) || [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    off(event: string, cb: Function) {
      const list = this.listeners.get(event) || [];
      const idx = list.indexOf(cb);
      if (idx !== -1) {
        list.splice(idx, 1);
        this.listeners.set(event, list);
      }
      return this;
    }

    emit(event: string, ...args: any[]) {
      const list = this.listeners.get(event) || [];
      for (const cb of list) cb(...args);
    }

    postMessage(msg: any) {
      if ((globalThis as any).mockWorkerFailExecution) {
        process.nextTick(() => {
          this.emit('error', new Error('Execution error'));
        });
      } else if ((globalThis as any).mockWorkerExitNonZero) {
        process.nextTick(() => {
          this.emit('exit', 1);
        });
      } else {
        process.nextTick(() => {
          this.emit('message', {
            id: msg.id,
            symbols: [{ name: 'WorkerSym', kind: 'function', startLine: 2, endLine: 4 }],
            references: [],
            errors: []
          });
        });
      }
    }

    terminate() {
      return Promise.resolve(0);
    }

    ref() { return this; }
    unref() { return this; }
  }

  return { Worker: MockWorker };
});

let mockPubspecContent = 'name: my_dart_package';
let shouldPubspecThrow = false;

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (path: string) => {
      if (path.includes('.git') || path.endsWith('scan.lock')) return false;
      return true;
    },
    readFileSync: (path: string, encoding: any) => {
      if (path.endsWith('pubspec.yaml')) {
        if (shouldPubspecThrow) {
          throw new Error('Unreadable pubspec');
        }
        return mockPubspecContent;
      }
      return 'data';
    }
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
    readdir: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    } as any)
  };
});

describe('Scanner Coverage Boost', () => {
  const createMockStore = (overrides?: any) => ({
    getMeta: vi.fn().mockReturnValue(null),
    getSymbolCount: vi.fn().mockReturnValue(0),
    getEdgeCount: vi.fn().mockReturnValue(0),
    setMeta: vi.fn(),
    getAllFiles: vi.fn().mockReturnValue([]),
    getRepoNames: vi.fn().mockReturnValue([]),
    deleteEdgesByType: vi.fn(),
    getAllEdges: vi.fn().mockReturnValue([]),
    getAllSymbols: vi.fn().mockReturnValue([]),
    getSymbolsForFile: vi.fn().mockReturnValue([]),
    upsertFile: vi.fn(),
    deleteFile: vi.fn(),
    // removeFiles (M0-02-R2) deletes only tracked files and records their referrers, and the
    // names they referenced (M0-02-R4).
    getFile: vi.fn().mockReturnValue({}),
    getReferrers: vi.fn().mockReturnValue([]),
    getReverseEdges: vi.fn().mockReturnValue([]),
    deleteSymbolsForFile: vi.fn(),
    deleteEdgesForFile: vi.fn(),
    getImporters: vi.fn().mockReturnValue([]),
    setFileHashes: vi.fn(),
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
    getFilesByPattern: vi.fn().mockReturnValue([]),
    raw: {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), run: vi.fn(), get: vi.fn() })
    },
    ...overrides
  } as unknown as Store);

  const mockConfig = {
    getWorkspaceRoot: () => '/workspace',
    getResolvedUserLanguages: () => ({}),
    repos: [{ name: 'repo1', path: '.' }],
    settings: { excludePatterns: [], includePatterns: [] }
  } as unknown as Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPubspecContent = 'name: my_dart_package';
    shouldPubspecThrow = false;
  });

  it('runs _scanIncrementalByHash with early exit (no changes)', async () => {
    const mockStore = createMockStore({
      getAllFiles: () => [
        { path: 'a.ts', content_hash: 'oldhash', repo: 'repo1' }
      ]
    });

    vi.mocked(fsPromises.readdir).mockResolvedValue([
      { name: 'a.ts', isFile: () => true, isDirectory: () => false } as any
    ]);

    vi.mocked(fsPromises.stat).mockResolvedValue({ size: 100 } as any);
    vi.mocked(fsPromises.readFile).mockResolvedValue('modified content' as any); // but we mock discoverFiles to say no changes?
    
    // To make sure a.ts is not new and not changed, we can mock discoverFiles.
    // In Scanner, discoverFiles returns DiscoveredFile[] where:
    // f.isNew = false, f.contentChanged = false
    
    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Override discoverFiles to return no changes
    scanner['discoverFiles'] = async () => <DiscoveredFile[]><unknown>[
      {
        relativePath: 'a.ts',
        language: 'typescript',
        sizeBytes: 100,
        lines: 5,
        contentHash: 'oldhash',
        isNew: false,
        contentChanged: false
      }
    ];

    const result = await scanner.scanIncremental(['repo1']);
    expect(result.filesScanned).toBe(0);
    expect(mockStore.deleteFile).not.toHaveBeenCalled();
    expect(mockStore.upsertFile).not.toHaveBeenCalled();
  });

  it('runs _scanIncrementalByHash with file deletion', async () => {
    const mockStore = createMockStore({
      getAllFiles: () => [
        { path: 'a.ts', content_hash: 'oldhash', repo: 'repo1' },
        { path: 'deleted.ts', content_hash: 'oldhash', repo: 'repo1' } // in DB but not on disk
      ]
    });

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Only a.ts is discovered on disk, deleted.ts is missing
    scanner['discoverFiles'] = async () => <DiscoveredFile[]><unknown>[
      {
        relativePath: 'a.ts',
        language: 'typescript',
        sizeBytes: 100,
        lines: 5,
        contentHash: 'oldhash',
        isNew: false,
        contentChanged: false
      }
    ];

    const result = await scanner.scanIncremental(['repo1']);
    // filesScanned is 0 because no files were re-indexed, but deleted.ts should be removed
    expect(mockStore.deleteFile).toHaveBeenCalledWith('deleted.ts');
  });

  it('covers discoverDartPackages with valid and throwing pubspec files', async () => {
    const mockStore = createMockStore({
      getFilesByPattern: (pat: string) => {
        if (pat === 'pubspec.yaml') {
          return [
            { path: 'pubspec.yaml' },
            { path: 'packages/pkg1/pubspec.yaml' },
            { path: 'packages/pkg2/pubspec.yaml' }
          ];
        }
        return [];
      }
    });

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // First, test normal execution
    mockPubspecContent = 'name: test_pkg';
    scanner['discoverDartPackages']('/workspace');
    expect(scanner['dartPackageMap'].get('test_pkg')).toBe('packages/pkg2/lib/');

    // Test throwing readFileSync execution (hits try/catch)
    shouldPubspecThrow = true;
    scanner['discoverDartPackages']('/workspace');
    // Map should be empty since readFileSync threw
    expect(scanner['dartPackageMap'].size).toBe(0);
  });

  it('covers runPostScanAnalysis and inserts smells', async () => {
    const mockStore = createMockStore({
      getAllFiles: () => [
        { path: 'a.ts', repo: 'repo1' }
      ]
    });

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    await scanner['runPostScanAnalysis']({ name: 'repo1', path: '.' }, '/workspace/repo1');
    expect(mockStore.insertArchSmell).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cyclic-dependency',
      involvedFiles: ['a.ts', 'b.ts']
    }));
  });

  it('covers resolveSymbolToFile with symbolIndex matching cases', () => {
    const mockStore = createMockStore();
    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Populate symbolIndex
    const index = new Map<string, Array<{ name: string; file: string; scope: string | null }>>();
    index.set('myfunc', [
      { name: 'MyFunc', file: 'a.ts', scope: 'MyScope' },
      { name: 'MyFunc', file: 'b.ts', scope: null }
    ]);
    scanner['symbolIndex'] = index;

    const fileMap = new Map<string, string>([
      ['a.ts', 'repo1'],
      ['b.ts', 'repo1']
    ]);

    // Test exact same file lookup
    const resSameFile = scanner['resolveSymbolToFile']('MyFunc', fileMap, 'a.ts');
    expect(resSameFile).toBe('a.ts');

    // Test fallback exact match
    const resExact = scanner['resolveSymbolToFile']('MyFunc', fileMap, 'other.ts');
    expect(resExact).toBe('a.ts');

    // TypeScript names are case-sensitive: `myfunc` is not `MyFunc` (M3-10)
    expect(scanner['resolveSymbolToFile']('myfunc', fileMap, 'other.ts')).toBeNull();

    // Without a source file the language is unknown, so resolution fails closed (M2-01)
    expect(scanner['resolveSymbolToFile']('myfunc', fileMap)).toBeNull();
  });

  it('covers scanFull and scanIncremental options, locks, resume errors', async () => {
    const mockStore = createMockStore({
      getMeta: (key: string) => {
        if (key.includes('scan_resume_state')) {
          return 'invalid json';
        }
        return null;
      }
    });
    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // 1. loadResumeState invalid JSON fallback
    const res = scanner['loadResumeState']('repo1');
    expect(res).toBeNull();

    // 2. Already running lock throws error
    // We mock lock acquire failure by letting process.pid match but let's just make getLockPath exist
    // and process.kill not throw error. Wait, we can mock acquireScanLock to return false.
    scanner['acquireScanLock'] = async () => false;
    await expect(scanner.scanFull()).rejects.toThrow('Another scan is already running');
    await expect(scanner.scanIncremental()).rejects.toThrow('Another scan is already running');

    // 3. Scan all repo names
    scanner['acquireScanLock'] = async () => true;
    scanner['discoverFiles'] = async () => <DiscoveredFile[]><unknown>[];
    const mockConfigAll = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }, { name: 'repo2', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;
    const scannerAll = new Scanner(mockStore, mockConfigAll, graph);
    scannerAll['acquireScanLock'] = async () => true;
    scannerAll['discoverFiles'] = async () => <DiscoveredFile[]><unknown>[];

    const resultFull = await scannerAll.scanFull(['all']);
    expect(resultFull.filesScanned).toBe(0);

    const resultInc = await scannerAll.scanIncremental(['all']);
    expect(resultInc.filesScanned).toBe(0);
  });

  it('covers parser parallel workers success and all fallback/error branches', async () => {
    const mockStore = createMockStore();
    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Setup files to parse
    const files = Array.from({ length: 15 }, (_, i) => ({
      absolutePath: `/workspace/file${i}.ts`,
      relativePath: `file${i}.ts`,
      language: 'typescript',
      sizeBytes: 100,
      lines: 10
    }));

    // 1. Parallel workers success case
    (scanner as any).parallel = true;
    (globalThis as any).mockWorkerFailInit = false;
    (globalThis as any).mockWorkerThrowOnMessage = false;
    (globalThis as any).mockWorkerFailExecution = false;
    (globalThis as any).mockWorkerExitNonZero = false;

    const successResults = await scanner['parseFilesParallel'](files, '/workspace');
    expect(successResults).toHaveLength(15);
    expect(successResults[0].symbols).toHaveLength(1);
    expect(successResults[0].symbols[0].name).toBe('WorkerSym');

    await scanner['endParseRun'](); // each case is a run of its own, with a pool of its own (M4-11)
    // 2. Parallel workers init failure (message: error) -> fallback to main thread
    (globalThis as any).mockWorkerFailInit = true;
    const initFailResults = await scanner['parseFilesParallel'](files, '/workspace');
    expect(initFailResults).toHaveLength(15);
    expect(initFailResults[0].symbols[0].name).toBe('A'); // main thread mock returns name 'A'

    await scanner['endParseRun'](); // each case is a run of its own, with a pool of its own (M4-11)
    // 3. Parallel workers init error event -> fallback to main thread
    (globalThis as any).mockWorkerFailInit = false;
    (globalThis as any).mockWorkerThrowOnMessage = true;
    const throwResults = await scanner['parseFilesParallel'](files, '/workspace');
    expect(throwResults).toHaveLength(15);
    expect(throwResults[0].symbols[0].name).toBe('A');

    await scanner['endParseRun'](); // each case is a run of its own, with a pool of its own (M4-11)
    // 4. Parallel workers execution error -> fallback to main thread
    (globalThis as any).mockWorkerThrowOnMessage = false;
    (globalThis as any).mockWorkerFailExecution = true;
    const execFailResults = await scanner['parseFilesParallel'](files, '/workspace');
    expect(execFailResults).toHaveLength(15);
    expect(execFailResults[0].symbols[0].name).toBe('A');

    await scanner['endParseRun'](); // each case is a run of its own, with a pool of its own (M4-11)
    // 5. Parallel workers exit code failure -> fallback to main thread
    (globalThis as any).mockWorkerFailExecution = false;
    (globalThis as any).mockWorkerExitNonZero = true;
    const exitFailResults = await scanner['parseFilesParallel'](files, '/workspace');
    expect(exitFailResults).toHaveLength(15);
    expect(exitFailResults[0].symbols[0].name).toBe('A');

    // Clean up globals
    delete (globalThis as any).mockWorkerFailInit;
    delete (globalThis as any).mockWorkerThrowOnMessage;
    delete (globalThis as any).mockWorkerFailExecution;
    delete (globalThis as any).mockWorkerExitNonZero;
  });

  it('covers remaining Scanner methods and resolution branches', async () => {
    // 1. buildSymbolIndex coverage (lines 1503-1518)
    const mockStore = createMockStore({
      getAllSymbols: () => [
        { name: 'funcA', file_path: 'a.ts', scope: 'Scope1', repo: 'repo1' },
        { name: 'funcA', file_path: 'b.ts', scope: null, repo: 'repo1' }, // same case, no scope
        { name: 'Funca', file_path: 'c.ts', scope: 'Scope2', repo: 'repo1' }  // different case
      ],
      searchSymbols: (name: string) => [
        { name: 'funcA', file_path: 'a.ts', scope: 'Scope1', repo: 'repo1' },
        { name: 'funcA', file_path: 'b.ts', scope: null, repo: 'repo1' },
        { name: 'Funca', file_path: 'c.ts', scope: 'Scope2', repo: 'repo1' }
      ]
    });
    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);
    const index = scanner['buildSymbolIndex']('repo1');
    expect(index.get('funca')).toHaveLength(3); // case-insensitive gets all 3
    expect(index.get('Funca')).toBeDefined(); // exact case

    // 1.1 Test resolveSymbolToFile with dot-qualified namespaces using symbolIndex
    const testFileMap = new Map<string, string>([
      ['a.ts', 'repo1'],
      ['b.ts', 'repo1'],
      ['c.ts', 'repo1']
    ]);
    scanner['symbolIndex'] = index;
    expect(scanner['resolveSymbolToFile']('funcA', testFileMap, 'src/main.ts')).toBe('a.ts');
    expect(scanner['resolveSymbolToFile']('Scope1\\funcA', testFileMap, 'src/main.ts')).toBe('a.ts');
    expect(scanner['resolveSymbolToFile']('N2.Content.funcA', testFileMap, 'src/main.ts')).toBe('a.ts');
    expect(scanner['resolveSymbolToFile']('funcA.ts', testFileMap, 'src/main.ts')).toBeNull();

    // 1.2 Test resolveSymbolToFile fallback (when symbolIndex is null)
    scanner['symbolIndex'] = null;
    expect(scanner['resolveSymbolToFile']('funcA', testFileMap, 'src/main.ts')).toBe('a.ts');
    expect(scanner['resolveSymbolToFile']('Scope1\\funcA', testFileMap, 'src/main.ts')).toBe('a.ts');
    expect(scanner['resolveSymbolToFile']('N2.Content.funcA', testFileMap, 'src/main.ts')).toBe('a.ts');
    expect(scanner['resolveSymbolToFile']('funcA.ts', testFileMap, 'src/main.ts')).toBeNull();

    // Test buildSymbolIndex with merging capabilities & stale symbol exclusions
    const indexMerged = scanner['buildSymbolIndex'](
      'repo1',
      ['a.ts'], // stale path to exclude
      [
        {
          symbols: [{ name: 'newFuncA', kind: 'function', startLine: 1, endLine: 2, scope: 'NewScope', signature: 'newFuncA()', metadata: {} }],
          references: [],
          errors: []
        }
      ]
    );
    // stale symbol from a.ts (funcA) should be excluded
    const funcaEntries = indexMerged.get('funca') || [];
    expect(funcaEntries.find(e => e.file === 'a.ts')).toBeUndefined();
    // non-stale symbols (b.ts, c.ts) should remain
    expect(funcaEntries.find(e => e.file === 'b.ts')).toBeDefined();
    // new parsed symbol (newFuncA) should be merged
    expect(indexMerged.get('newfunca')).toBeDefined();
    expect(indexMerged.get('newfunca')![0].file).toBe('a.ts');

    // 2. resolveReferencesWithMap coverage (including spans and scopes resolution)
    const fileMap = new Map<string, string>([
      ['a.ts', 'repo1']
    ]);
    const refs = [
      { targetName: 'console', referenceType: 'import', startLine: 5, endLine: 5 }, // JS/TS global skipped
      { targetName: 'otherFunc', referenceType: 'call', startLine: 5, endLine: 5 }, // resolving otherFunc
      { targetName: 'requiredFunc', referenceType: 'require', startLine: 5, endLine: 5 }, // require path
      { targetName: 'importedFunc', referenceType: 'import', startLine: 5, endLine: 5 } // import path
    ];

    // Mock resolve methods on scanner to cover require/import resolution
    scanner['resolveRequirePath'] = () => 'b.ts';
    scanner['resolveImportPath'] = () => 'c.ts';
    scanner['resolveSymbolToFile'] = () => 'd.ts';

    // The resolution path the scanner uses: the file's own symbols and the workspace file map (M4-03
    // removed resolveReferences, which rebuilt the map from the store).
    const mockStoreForRefs = createMockStore();
    const scannerForRefs = new Scanner(mockStoreForRefs, mockConfig, graph);
    scannerForRefs['resolveRequirePath'] = () => 'b.ts';
    scannerForRefs['resolveImportPath'] = () => 'c.ts';
    scannerForRefs['resolveSymbolToFile'] = () => 'd.ts';

    const resolved = scannerForRefs['resolveReferencesWithMap'](refs as unknown as ExtractedReference[], 'a.ts', 'repo1', new Map([['a.ts', 'repo1']]),
      [{ name: 'myOuterSym', kind: 'function', startLine: 1, endLine: 10, scope: 'MyClass', metadata: {} }]);
    expect(resolved).toHaveLength(3); // console skipped, others resolved
    expect(resolved[0].sourceSymbol).toBe('MyClass::myOuterSym');

    // 3. Deletion cascade during scanFull and git incremental check
    const mockStoreForFull = createMockStore({
      getAllSymbols: () => [{ file_path: 'a.ts' }],
      getAllFiles: () => [{ path: 'a.ts', repo: 'repo1' }, { path: 'deleted.ts', repo: 'repo1' }]
    });
    const scannerForFull = new Scanner(mockStoreForFull, mockConfig, graph);
    scannerForFull['acquireScanLock'] = async () => true;
    scannerForFull['discoverFiles'] = async () => <DiscoveredFile[]><unknown>[
      {
        relativePath: 'a.ts',
        language: 'typescript',
        sizeBytes: 100,
        lines: 5,
        contentHash: 'hash',
        isNew: false,
        contentChanged: false
      }
    ];

    const fullRes = await scannerForFull.scanFull();
    expect(fullRes.filesScanned).toBe(1);
    // Should trigger deleteFile for deleted.ts
    expect(mockStoreForFull.deleteFile).toHaveBeenCalledWith('deleted.ts');

    // 4. recursive walk coverage (line 665)
    vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
      { name: 'subdir', isFile: () => false, isDirectory: () => true } as any
    ]).mockResolvedValueOnce([
      { name: 'file.ts', isFile: () => true, isDirectory: () => false } as any
    ]);
    const scannerForWalk = new Scanner(mockStoreForFull, mockConfig, graph);
    const disc = await scannerForWalk['discoverFiles']('/workspace/repo1', 'repo1', true);
    expect(disc).toHaveLength(1);
    expect(disc[0].relativePath).toBe('repo1/subdir/file.ts');
  });
});

