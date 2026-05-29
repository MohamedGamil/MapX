import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scanner, buildMatcher } from '../src/core/scanner.js';
import type { Store } from '../src/core/store.js';
import type { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import * as fsPromises from 'node:fs/promises';

const mockActiveDetectors: any[] = [];

// Mock registry & registries
vi.mock('../src/parsers/parser-registry.js', () => ({
  getParserForFile: () => ({
    parse: vi.fn().mockResolvedValue({
      symbols: [{ name: 'A', kind: 'class', startLine: 1, endLine: 10, scope: null }],
      references: [{ source_file: 'a.ts', target_file: 'b.ts', source_symbol: 'A', target_symbol: 'B', edge_type: 'call' }],
      errors: []
    })
  })
}));

vi.mock('../src/languages/registry.js', () => ({
  getLanguageForFile: () => ({ name: 'typescript' }),
  areLanguagesCompatible: () => true,
  getBuiltinLanguages: () => ({})
}));

vi.mock('../src/core/git-tracker.js', () => ({
  getGitBlobHashes: () => new Map([['a.ts', 'blobhash1']]),
  getChangedFiles: () => [{ path: 'a.ts', status: 'modified' }],
  getCurrentCommitSha: () => 'commitsha123',
  isGitRepo: () => true
}));

vi.mock('../src/frameworks/framework-registry.js', () => ({
  FrameworkRegistry: {
    getInstance: () => ({
      detectActiveFrameworks: vi.fn().mockImplementation(() => Promise.resolve(mockActiveDetectors))
    })
  }
}));

vi.mock('../src/frameworks/route-registry.js', () => ({
  RouteRegistry: class {
    load = vi.fn().mockResolvedValue(undefined);
    clearRepo = vi.fn().mockResolvedValue(undefined);
    addRoute = vi.fn();
    addHook = vi.fn();
    save = vi.fn().mockResolvedValue(undefined);
  }
}));

let mockExistsSync: ((path: string) => boolean) | null = null;
let mockReadFileSync: ((path: string) => string) | null = null;
let mockOpenThrowEexist = false;

// Mock node:fs/promises and fs
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (path: string) => {
      if (mockExistsSync) return mockExistsSync(path);
      if (path.endsWith('scan.lock')) return false;
      return true;
    },
    readFileSync: (path: string) => {
      if (mockReadFileSync) return mockReadFileSync(path);
      return 'data';
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: vi.fn().mockImplementation(async (path) => {
      if (path.toString().endsWith('unreadable.ts')) {
        throw new Error('Unreadable file');
      }
      return 'export class A {}';
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    readdir: vi.fn().mockResolvedValue([
      { name: 'a.ts', isFile: () => true, isDirectory: () => false },
      { name: 'unreadable.ts', isFile: () => true, isDirectory: () => false }
    ]),
    open: vi.fn().mockImplementation(async (path, flags) => {
      if (mockOpenThrowEexist && path.toString().endsWith('scan.lock') && flags === 'wx') {
        mockOpenThrowEexist = false; // Throw once
        const err = new Error('EEXIST');
        (err as any).code = 'EEXIST';
        throw err;
      }
      return {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined)
      } as any;
    })
  };
});

describe('Scanner module', () => {
  const createMockStore = (overrides?: any) => ({
    getMeta: vi.fn().mockReturnValue(null),
    setMeta: vi.fn(),
    getAllFiles: vi.fn().mockReturnValue([]),
    getAllEdges: vi.fn().mockReturnValue([]),
    getAllSymbols: vi.fn().mockReturnValue([]),
    getSymbolsForFile: vi.fn().mockReturnValue([]),
    upsertFile: vi.fn(),
    deleteFile: vi.fn(),
    deleteSymbolsForFile: vi.fn(),
    deleteEdgesForFile: vi.fn(),
    insertSymbol: vi.fn(),
    insertEdge: vi.fn(),
    updateFileMetadata: vi.fn(),
    deleteFrameworkEdgesForRepo: vi.fn(),
    clearClusters: vi.fn(),
    insertCluster: vi.fn(),
    insertClusterMembership: vi.fn(),
    inTransaction: vi.fn().mockImplementation((fn: () => void) => fn()),
    raw: {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) })
    },
    ...overrides
  } as unknown as Store);

  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveDetectors.length = 0;
    mockExistsSync = null;
    mockReadFileSync = null;
    mockOpenThrowEexist = false;
  });

  it('buildMatcher excludes and includes patterns correctly', () => {
    const matcher = buildMatcher(['node_modules/**', 'dist/**'], ['src/**']);
    expect(matcher('src/main.ts')).toBe(true);
    expect(matcher('node_modules/foo/index.js')).toBe(false);
    expect(matcher('dist/index.js')).toBe(false);
    expect(matcher('tests/main.test.ts')).toBe(false);
  });

  it('runs full scan and incremental scan correctly', async () => {
    const mockStore = createMockStore();

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: {
        excludePatterns: [],
        includePatterns: []
      }
    } as unknown as Config;

    const graph = new MapxGraph('repo1');

    const scanner = new Scanner(mockStore, mockConfig, graph);
    const result = await scanner.scanFull(['repo1']);

    expect(result.filesScanned).toBe(1);
    expect(result.durationMs).toBeDefined();

    const incResult = await scanner.scanIncremental(['repo1']);
    expect(incResult.durationMs).toBeDefined();
  });

  it('scans framework routes and hooks if framework detector matches', async () => {
    const mockDetector = {
      name: 'mock-framework',
      filePattern: /routes\.ts/,
      extractRoutes: async () => [
        {
          method: 'GET',
          path: '/api/test',
          handlerFile: 'src/handler.ts',
          handlerSymbol: 'getTest',
          metadata: { confidence: 'declared' }
        }
      ],
      extractHooks: async () => [
        {
          hookType: 'middleware',
          hookName: 'useTest',
          handlerFile: 'src/hook.ts',
          handlerSymbol: 'testHook',
          metadata: { confidence: 'declared' }
        }
      ]
    };

    mockActiveDetectors.push(mockDetector);

    vi.mocked(fsPromises.readdir).mockResolvedValue([
      { name: 'routes.ts', isFile: () => true, isDirectory: () => false } as any
    ]);

    const mockStore = createMockStore({
      getAllFiles: () => [{ path: 'routes.ts', repo: 'repo1' }]
    });

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: {
        excludePatterns: [],
        includePatterns: []
      }
    } as unknown as Config;

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    const result = await scanner.scanFull(['repo1']);
    expect(result.filesScanned).toBe(1);
    expect(mockStore.insertEdge).toHaveBeenCalled();
  });

  it('handles aborting during scan', async () => {
    const mockStore = createMockStore({
      getAllFiles: () => {
        scanner.abort();
        return [];
      }
    });

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);
    const result = await scanner.scanFull(['repo1']);
    expect(result.interrupted).toBe(true);
  });

  it('handles stale lock files and pid verification during lock acquisition', async () => {
    const mockStore = createMockStore();

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Mock existsSync for lock to return true
    mockExistsSync = (p) => {
      if (p.endsWith('scan.lock')) return true;
      return false;
    };
    // Mock readFileSync for lock to return pid 999999
    mockReadFileSync = (p) => {
      if (p.endsWith('scan.lock')) return '999999';
      return '';
    };

    // Spy on process.kill. If called with 999999, make it throw an error (process doesn't exist)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Process not found');
    });

    mockOpenThrowEexist = true;

    const result = await scanner.scanFull(['repo1']);
    expect(result.filesScanned).toBe(1);
    expect(killSpy).toHaveBeenCalledWith(999999, 0);

    killSpy.mockRestore();
  });

  it('runs scan with resume state correctly', async () => {
    const mockStore = createMockStore({
      getMeta: (key: string) => {
        if (key.startsWith('scan_resume_state')) {
          return JSON.stringify({
            totalFiles: 2,
            completedFiles: ['a.ts'],
            totalSymbols: 10,
            totalEdges: 5
          });
        }
        return null;
      }
    });

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    vi.mocked(fsPromises.readdir).mockResolvedValue([
      { name: 'a.ts', isFile: () => true, isDirectory: () => false } as any,
      { name: 'b.ts', isFile: () => true, isDirectory: () => false } as any
    ]);

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);
    const result = await scanner.scanFull(['repo1']);
    expect(result.durationMs).toBeDefined();
  });

  it('skips unregistered nested git repository', async () => {
    const mockStore = createMockStore();

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    vi.mocked(fsPromises.readdir).mockResolvedValue([
      { name: 'nested-git', isFile: () => false, isDirectory: () => true } as any
    ]);

    mockExistsSync = (p) => {
      if (p.endsWith('nested-git/.git')) return true;
      return false;
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);
    await scanner.scanFull(['repo1']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('resolves import, require, and symbol paths correctly', async () => {
    const mockStore = createMockStore({
      getAllFiles: () => [
        { path: 'src/utils.php', repo: 'repo1' },
        { path: 'src/helper.ts', repo: 'repo1' },
        { path: 'src/components/button.vue', repo: 'repo1' }
      ],
      searchSymbols: (name: string) => {
        if (name === 'UserController') {
          return [{ name: 'UserController', file_path: 'src/controllers/UserController.php' }];
        }
        return [];
      }
    });

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    // Test private resolution helpers directly
    const fileMap = new Map([
      ['src/utils.php', 'repo1'],
      ['src/helper.ts', 'repo1'],
      ['src/components/button.vue', 'repo1']
    ]);

    const reqRes = (scanner as any).resolveRequirePath('./utils', 'src/main.php', fileMap);
    expect(reqRes).toBe('src/utils.php');

    const impRes = (scanner as any).resolveImportPath('@/components/button', 'src/main.vue', fileMap);
    expect(impRes).toBe('src/components/button.vue');

    const symRes = (scanner as any).resolveSymbolToFile('App\\Controller\\UserController', fileMap, 'src/main.php');
    expect(symRes).toBe('src/controllers/UserController.php');
  });

  it('handles route/hook confidence suppression and error handling', async () => {
    const mockDetector = {
      name: 'mock-framework',
      filePattern: /routes\.ts/,
      extractRoutes: async (relPath: string, content: string, localCtx: any) => {
        if (relPath.includes('bad')) {
          throw new Error('Extraction error');
        }
        await localCtx.resolveSymbolToFile('UserController');
        return [
          {
            method: 'GET',
            path: '/api/declared',
            handlerFile: 'src/handler.ts',
            handlerSymbol: 'getTest',
            metadata: { confidence: 'declared' }
          },
          {
            method: 'GET',
            path: '/api/inferred',
            handlerFile: 'src/handler.ts',
            handlerSymbol: 'getTest',
            metadata: { confidence: 'inferred' }
          },
          {
            method: 'GET',
            path: '/api/low',
            handlerFile: 'src/handler.ts',
            handlerSymbol: 'getTest',
            metadata: { confidence: 'low' }
          },
          {
            method: 'GET',
            path: '/api/num-high',
            handlerFile: 'src/handler.ts',
            handlerSymbol: 'getTest',
            metadata: { confidence: 0.9 }
          },
          {
            method: 'GET',
            path: '/api/num-low',
            handlerFile: 'src/handler.ts',
            handlerSymbol: 'getTest',
            metadata: { confidence: 0.3 }
          }
        ];
      },
      extractHooks: async () => [
        {
          hookType: 'middleware',
          hookName: 'declaredHook',
          handlerFile: 'src/hook.ts',
          handlerSymbol: 'testHook',
          metadata: { confidence: 'declared' }
        },
        {
          hookType: 'middleware',
          hookName: 'inferredHook',
          handlerFile: 'src/hook.ts',
          handlerSymbol: 'testHook',
          metadata: { confidence: 'inferred' }
        },
        {
          hookType: 'middleware',
          hookName: 'lowConfHook',
          handlerFile: 'src/hook.ts',
          handlerSymbol: 'testHook',
          metadata: { confidence: 'low' }
        },
        {
          hookType: 'middleware',
          hookName: 'numHighHook',
          handlerFile: 'src/hook.ts',
          handlerSymbol: 'testHook',
          metadata: { confidence: 0.9 }
        },
        {
          hookType: 'middleware',
          hookName: 'numLowHook',
          handlerFile: 'src/hook.ts',
          handlerSymbol: 'testHook',
          metadata: { confidence: 0.3 }
        }
      ]
    };

    mockActiveDetectors.push(mockDetector);

    vi.mocked(fsPromises.readdir).mockResolvedValue([
      { name: 'routes.ts', isFile: () => true, isDirectory: () => false } as any,
      { name: 'bad-routes.ts', isFile: () => true, isDirectory: () => false } as any
    ]);

    const mockStore = createMockStore({
      getAllFiles: () => [
        { path: 'routes.ts', repo: 'repo1' },
        { path: 'bad-routes.ts', repo: 'repo1' }
      ]
    });

    const mockConfig = {
      getWorkspaceRoot: () => '/workspace',
      getResolvedUserLanguages: () => ({}),
      repos: [{ name: 'repo1', path: '.' }],
      settings: { excludePatterns: [], includePatterns: [] }
    } as unknown as Config;

    const graph = new MapxGraph('repo1');
    const scanner = new Scanner(mockStore, mockConfig, graph);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await scanner.scanFull(['repo1']);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('covers shouldExcludeDir conditions', () => {
    const mockStore = {} as any;
    const mockConfig = {
      settings: { excludePatterns: [] }
    } as any;
    const graph = {} as any;
    const scanner = new Scanner(mockStore, mockConfig, graph);

    const res1 = (scanner as any).shouldExcludeDir('node_modules/foo', ['node_modules/**']);
    expect(res1).toBe(true);

    const res2 = (scanner as any).shouldExcludeDir('dist', ['dist']);
    expect(res2).toBe(true);
  });
});
