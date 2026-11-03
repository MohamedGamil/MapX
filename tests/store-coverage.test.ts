import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { Store } from '../src/core/store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';

vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return {
    ...original,
    createRequire: () => {
      return (id: string) => {
        if (id === 'bun:sqlite') {
          return {
            Database: class {
              constructor(dbPath: string) {}
              exec() {}
              prepare() {
                return { run: () => {}, get: () => {}, all: () => [] };
              }
              transaction(fn: any) {
                return fn;
              }
              close() {}
            }
          };
        }
        return require(id);
      };
    }
  };
});

describe('Store Coverage Boost', () => {
  let store: Store;
  // Databases live in a temp folder, never under tests/: fixtures-tracked.test.ts fails on any
  // ignored file there, and SQLite leaves -wal/-shm files beside the database (M4-09-R4).
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapx-store-coverage-'));
  const dbPath = path.join(tempDir, 'store-coverage-temp.db');

  const bunDbPath = path.join(tempDir, 'store-bun-temp.db');

  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it('keeps its databases and their -wal/-shm files out of tests/', () => {
    for (const db of [dbPath, bunDbPath]) expect(path.relative(__dirname, db).startsWith('..')).toBe(true);
    expect(fs.readdirSync(__dirname).filter((f) => /^store-.*-temp\.db/.test(f))).toEqual([]);
  });

  beforeEach(() => {
    store = new Store(dbPath);
    store.upsertFile({
      path: 'src/main.ts',
      repo: 'test-repo',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: new Date().toISOString(),
      sizeBytes: 100,
      lines: 10
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch (e) {}
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch (e) {}
  });

  it('covers scope normalization and dot notation splitting in getCalleesOfSymbol and getCallersOfSymbol', () => {
    // 1. Insert symbols
    // One with A::B scope, to test normalized fallback scope matching when query uses A.B
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'test-repo',
      name: 'myMethod',
      kind: 'method',
      scope: 'MyClass::SubClass',
      signature: 'myMethod()',
      startLine: 1,
      endLine: 5,
      metadata: '{}'
    });
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'test-repo',
      name: 'otherMethod',
      kind: 'method',
      scope: null,
      signature: 'otherMethod()',
      startLine: 6,
      endLine: 10,
      metadata: '{}'
    });

    // 2. Insert edges
    store.insertEdge({
      sourceFile: 'src/main.ts',
      targetFile: 'src/main.ts',
      sourceSymbol: 'MyClass::SubClass::myMethod',
      targetSymbol: 'otherMethod',
      edgeType: 'call',
      repo: 'test-repo',
      weight: 1
    });

    // Test getCalleesOfSymbol with dot notation scope normalization
    // "MyClass.SubClass.myMethod" has scope MyClass.SubClass which normalize-matches MyClass::SubClass
    const callees = store.getCalleesOfSymbol('MyClass.SubClass.myMethod', 'test-repo');
    expect(callees).toHaveLength(1);
    expect(callees[0].target_symbol).toBe('otherMethod');

    // Test getCallersOfSymbol with dot notation scope normalization
    const callers = store.getCallersOfSymbol('MyClass.SubClass.myMethod', 'test-repo');
    expect(callers).toHaveLength(0);

    // Test with common extension (like 'main.ts' which should NOT split scope because 'ts' is common extension)
    const calleesCommonExt = store.getCalleesOfSymbol('main.ts', 'test-repo');
    expect(calleesCommonExt).toHaveLength(0);

    const callersCommonExt = store.getCallersOfSymbol('main.ts', 'test-repo');
    expect(callersCommonExt).toHaveLength(0);

    // Test getCallersOfSymbol with no results
    const callersEmpty = store.getCallersOfSymbol('NonExistentSymbol', 'test-repo');
    expect(callersEmpty).toHaveLength(0);

    // Test getCalleesOfSymbol with no results
    const calleesEmpty = store.getCalleesOfSymbol('NonExistentSymbol', 'test-repo');
    expect(calleesEmpty).toHaveLength(0);
  });

  it('covers getTopFilesByPageRank and getTopSymbolsByPageRank', () => {
    // getSymbolByName fallback returning undefined
    const noSym = store.getSymbolByName('MyClass.NonMatching.myMethod', 'test-repo');
    expect(noSym).toBeUndefined();

    // getFilesFiltered glob options
    const filteredGlob1 = store.getFilesFiltered({ pathPrefix: 'src/*.ts', repo: 'test-repo' });
    expect(filteredGlob1).toHaveLength(1);
    const filteredGlob2 = store.getFilesFiltered({ pathPrefix: 'src/m?in.ts', repo: 'test-repo' });
    expect(filteredGlob2).toHaveLength(1);

    const mockGraph = {
      getRankedFiles: () => [{ path: 'a.ts', pagerank: 0.8 }],
      getRankedSymbols: () => [{ name: 'MyClass', pagerank: 0.9 }]
    } as any;

    const topFiles = store.getTopFilesByPageRank(mockGraph, 1);
    expect(topFiles).toHaveLength(1);
    expect(topFiles[0].path).toBe('a.ts');

    const topSymbols = store.getTopSymbolsByPageRank(mockGraph, 1);
    expect(topSymbols).toHaveLength(1);
    expect(topSymbols[0].name).toBe('MyClass');
  });

  it('covers updateFileRole and classification signals APIs', () => {
    store.updateFileRole('src/main.ts', 'api', 0.95);
    const file = store.getFile('src/main.ts') as any;
    expect(file?.role).toBe('api');
    expect(file?.role_confidence).toBe(0.95);

    // Test signals
    store.insertClassificationSignal({
      filePath: 'src/main.ts',
      repo: 'test-repo',
      source: 'framework',
      role: 'api',
      confidence: 0.9,
      reason: 'matches Express router'
    });

    const signals = store.getClassificationSignals('src/main.ts');
    expect(signals).toHaveLength(1);
    expect(signals[0].role).toBe('api');

    store.deleteClassificationSignalsForFile('src/main.ts');
    expect(store.getClassificationSignals('src/main.ts')).toHaveLength(0);
  });

  it('covers cluster metrics and arch smells APIs', () => {
    // Metrics
    store.insertClusterMetrics({
      clusterName: 'core',
      repo: 'test-repo',
      fileCount: 5,
      afferentCoupling: 2,
      efferentCoupling: 1,
      instability: 0.33,
      internalEdges: 10,
      externalEdges: 3,
      cohesionRatio: 0.7,
      abstractness: 0.2,
      distanceFromMainSeq: 0.1
    });

    const metrics = store.getClusterMetrics('test-repo');
    expect(metrics).toHaveLength(1);
    expect(metrics[0].cluster_name).toBe('core');

    // Arch smells
    store.insertArchSmell({
      repo: 'test-repo',
      type: 'cyclic-dependency',
      severity: 'high',
      description: 'A cycle exists',
      involvedFiles: ['a.ts', 'b.ts'],
      involvedClusters: ['core'],
      suggestion: 'break the cycle'
    });

    const smells = store.getArchSmells('test-repo');
    expect(smells).toHaveLength(1);
    expect(smells[0].type).toBe('cyclic-dependency');
    expect(smells[0].involvedFiles).toEqual(['a.ts', 'b.ts']);
    expect(smells[0].involvedClusters).toEqual(['core']);
  });

  it('covers inTransaction and close wrapper APIs', () => {
    let called = false;
    const result = store.inTransaction(() => {
      called = true;
      return 123;
    });
    expect(called).toBe(true);
    expect(result).toBe(123);
  });

  it('covers remaining Store methods', () => {
    // 1. BunStore creation simulation
    const oldBun = (globalThis as any).Bun;
    (globalThis as any).Bun = {};
    try {
      const tempDb = bunDbPath;
      const tempStore = new Store(tempDb);
      tempStore.close();
      if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);
    } finally {
      (globalThis as any).Bun = oldBun;
    }

    // 2. searchSymbols with scopeLike and repo (using dot notation to hit parts.split('.') path)
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'test-repo',
      name: 'methodA',
      kind: 'method',
      scope: 'ClassA',
      signature: 'methodA()',
      startLine: 10,
      endLine: 12,
      metadata: '{}'
    });
    const resultsRepo = store.searchSymbols('ClassA.methodA', 'test-repo');
    expect(resultsRepo).toHaveLength(1);
    const resultsRepoColon = store.searchSymbols('ClassA::methodA', 'test-repo');
    expect(resultsRepoColon).toHaveLength(1);
    const resultsNoRepo = store.searchSymbols('ClassA.methodA');
    expect(resultsNoRepo).toHaveLength(1);

    // 3. searchSymbolsFiltered with scopeLike
    const resultsExt = store.searchSymbolsFiltered({
      term: 'ClassA.methodA',
      limit: 10
    });
    expect(resultsExt).toHaveLength(1);

    // 4. countSymbolsFiltered with different options
    // wildcard
    expect(store.countSymbolsFiltered({ term: '*' })).toBeGreaterThanOrEqual(1);
    // exact
    expect(store.countSymbolsFiltered({ term: 'methodA', exact: true })).toBe(1);
    // glob
    expect(store.countSymbolsFiltered({ term: 'meth*' })).toBe(1);
    // fuzzy / default LIKE
    expect(store.countSymbolsFiltered({ term: 'method', repo: 'test-repo', filePrefix: 'src', kind: 'method' })).toBe(1);
    // scopeLike
    expect(store.countSymbolsFiltered({ term: 'ClassA.methodA' })).toBe(1);

    // 5. getSymbolByName fallback without repo
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'test-repo2',
      name: 'myMethod',
      kind: 'method',
      scope: 'MyClass::SubClass',
      signature: 'myMethod()',
      startLine: 1,
      endLine: 5,
      metadata: '{}'
    });
    const sym = store.getSymbolByName('MyClass.SubClass.myMethod');
    expect(sym).toBeDefined();
    expect(sym?.name).toBe('myMethod');
  });
});

