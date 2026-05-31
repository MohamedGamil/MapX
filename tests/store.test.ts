import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Store } from '../src/core/store.js';
import * as fs from 'node:fs';

describe('Store core class', () => {
  let store: Store;

  beforeAll(() => {
    store = new Store(':memory:');
  });

  it('initializes the database and runs migrations', () => {
    expect(store.getMeta('schema_version')).toBe('7');
  });

  it('performs meta operations correctly', () => {
    store.setMeta('my_key', 'my_val');
    expect(store.getMeta('my_key')).toBe('my_val');
    expect(store.getMeta('nonexistent')).toBeNull();
  });

  it('performs file CRUD operations', () => {
    store.upsertFile({
      path: 'src/main.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: 'blobhash',
      contentHash: 'hash',
      lastScanned: new Date().toISOString(),
      sizeBytes: 1024,
      lines: 50
    });

    const file = store.getFile('src/main.ts');
    expect(file).toBeDefined();
    expect(file?.language).toBe('typescript');

    const allFiles = store.getAllFiles('mapx');
    expect(allFiles).toHaveLength(1);
    expect(allFiles[0].path).toBe('src/main.ts');

    const filtered = store.getFilesFiltered({ pathPrefix: 'src/', lang: 'typescript' });
    expect(filtered).toHaveLength(1);

    store.updateFileMetadata('src/main.ts', { author: 'Mohamed' });
    const file2 = store.getFile('src/main.ts') as any;
    expect(JSON.parse(file2.metadata)).toEqual({ author: 'Mohamed' });
  });

  it('performs symbol operations', () => {
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'mapx',
      name: 'MainClass',
      kind: 'class',
      scope: null,
      signature: 'class MainClass',
      startLine: 1,
      endLine: 20,
      metadata: '{}'
    });

    const syms = store.getSymbolsForFile('src/main.ts');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('MainClass');

    const sym = store.getSymbolByName('MainClass', 'mapx');
    expect(sym).toBeDefined();
    expect(sym?.file_path).toBe('src/main.ts');

    const allNames = store.getAllSymbolNames();
    expect(allNames).toContain('MainClass');

    const kinds = store.listSymbolKinds();
    expect(kinds.find(k => k.kind === 'class')?.count).toBe(1);

    const candidates = store.getSymbolCandidatesForFuzzy('mapx');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('MainClass');

    store.deleteSymbolsForFile('src/main.ts');
    expect(store.getSymbolsForFile('src/main.ts')).toHaveLength(0);
  });

  it('performs edge operations', () => {
    // Re-insert file since we deleted symbols
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'mapx',
      name: 'MainClass',
      kind: 'class',
      scope: null,
      signature: 'class MainClass',
      startLine: 1,
      endLine: 20,
      metadata: '{}'
    });

    store.insertEdge({
      sourceFile: 'src/main.ts',
      targetFile: 'src/utils.ts',
      sourceSymbol: 'MainClass',
      targetSymbol: 'helper',
      edgeType: 'call',
      repo: 'mapx',
      weight: 1.0,
      verifiability: 'verified'
    });

    const edges = store.getEdgesForFile('src/main.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].target_file).toBe('src/utils.ts');

    const rev = store.getReverseEdges('src/utils.ts');
    expect(rev).toHaveLength(1);
    expect(rev[0].source_file).toBe('src/main.ts');

    const queried = store.queryEdges({ type: 'call' });
    expect(queried).toHaveLength(1);

    const queried2 = store.queryEdges({ type: 'call', from: 'main', to: 'utils', repo: 'mapx' });
    expect(queried2).toHaveLength(1);

    store.deleteEdgesForFile('src/main.ts');
    expect(store.getEdgesForFile('src/main.ts')).toHaveLength(0);
  });

  it('performs cluster operations', () => {
    store.insertCluster({
      repo: 'mapx',
      name: 'core',
      label: 'Core',
      source: 'directory',
      parentName: null,
      depth: 0,
      fileCount: 2
    });

    store.insertClusterMembership({
      filePath: 'src/main.ts',
      clusterName: 'core',
      repo: 'mapx',
      isPrimary: 1
    });

    const clusters = store.getClusters('mapx');
    expect(clusters).toHaveLength(1);
    expect(clusters[0].name).toBe('core');

    store.clearClusters('mapx');
    expect(store.getClusters('mapx')).toHaveLength(0);
  });

  it('performs advanced callers and callees symbol queries', () => {
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'mapx',
      name: 'methodA',
      kind: 'method',
      scope: 'MainClass',
      signature: '',
      startLine: 5,
      endLine: 6,
      metadata: '{}'
    });

    store.insertEdge({
      sourceFile: 'src/main.ts',
      targetFile: 'src/main.ts',
      sourceSymbol: 'MainClass::methodA',
      targetSymbol: 'MainClass',
      edgeType: 'call',
      repo: 'mapx',
      weight: 1.0,
      verifiability: 'verified'
    });

    const callers = store.getCallersOfSymbol('MainClass', 'mapx');
    expect(callers).toHaveLength(1);

    const scopedCallers = store.getCallersOfSymbol('MainClass::methodA');
    expect(scopedCallers).toHaveLength(0); // target is MainClass, not methodA

    const callersWithRepo = store.getCallersOfSymbol('MainClass::methodA', 'mapx');
    expect(callersWithRepo).toHaveLength(0);

    const nonexistentCallers = store.getCallersOfSymbol('NonExistent');
    expect(nonexistentCallers).toHaveLength(0);

    const nonexistentCallees = store.getCalleesOfSymbol('NonExistent');
    expect(nonexistentCallees).toHaveLength(0);

    const callees = store.getCalleesOfSymbol('MainClass::methodA', 'mapx');
    expect(callees).toHaveLength(1);

    const calleesWrongRepo = store.getCalleesOfSymbol('MainClass::methodA', 'other-repo');
    expect(calleesWrongRepo).toHaveLength(0);

    const scopedCallees = store.getCalleesOfSymbol('MainClass');
    expect(scopedCallees).toHaveLength(0); // source is methodA, not MainClass
  });

  it('retrieves top files and symbols by PageRank', () => {
    const graph = {
      getRankedFiles: () => [{ path: 'a.ts', pagerank: 0.8 }],
      getRankedSymbols: () => [{ name: 'A', pagerank: 0.9 }]
    } as any;

    expect(store.getTopFilesByPageRank(graph, 1)).toEqual([{ path: 'a.ts', pagerank: 0.8 }]);
    expect(store.getTopSymbolsByPageRank(graph, 1)).toEqual([{ name: 'A', pagerank: 0.9 }]);
  });

  it('supports close', () => {
    const tempStore = new Store(':memory:');
    expect(() => tempStore.close()).not.toThrow();
  });

  it('supports inTransaction transactions', () => {
    store.inTransaction(() => {
      store.setMeta('tx_key', 'tx_val');
    });
    expect(store.getMeta('tx_key')).toBe('tx_val');
  });

  it('deletes file and cascades', () => {
    // Insert file, symbol, and edge
    store.upsertFile({
      path: 'src/temp.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });
    store.insertSymbol({
      filePath: 'src/temp.ts',
      repo: 'mapx',
      name: 'TempClass',
      kind: 'class',
      scope: null,
      signature: '',
      startLine: 1,
      endLine: 2,
      metadata: '{}'
    });
    store.insertEdge({
      sourceFile: 'src/temp.ts',
      targetFile: 'src/utils.ts',
      sourceSymbol: 'TempClass',
      targetSymbol: 'helper',
      edgeType: 'call',
      repo: 'mapx',
      weight: 1.0,
      verifiability: 'verified'
    });

    // Delete file
    store.deleteFile('src/temp.ts');

    expect(store.getFile('src/temp.ts')).toBeUndefined();
    expect(store.getSymbolsForFile('src/temp.ts')).toHaveLength(0);
    expect(store.getEdgesForFile('src/temp.ts')).toHaveLength(0);
  });

  it('handles custom directory creation for SQLite database', () => {
    const testPath = 'tests/temp-dir-new/test-store.db';
    // Ensure parent dir doesn't exist
    if (fs.existsSync('tests/temp-dir-new')) {
      fs.rmSync('tests/temp-dir-new', { recursive: true, force: true });
    }
    const tempStore = new Store(testPath);
    expect(fs.existsSync(testPath)).toBe(true);
    tempStore.close();
    fs.rmSync('tests/temp-dir-new', { recursive: true, force: true });
  });

  it('runs migrations from version 1', () => {
    const testPath = 'tests/migration-v1.db';
    if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
    
    // Create database manually with v1 schema (no content_hash, verifiability, etc.)
    const backend = new Store(testPath).raw;
    // Remove tables/columns to make it v1
    backend.exec('DROP TABLE IF EXISTS files');
    backend.exec('DROP TABLE IF EXISTS symbols');
    backend.exec('DROP TABLE IF EXISTS edges');
    backend.exec('DROP TABLE IF EXISTS snapshots');
    backend.exec('DROP TABLE IF EXISTS meta');
    backend.exec('DROP TABLE IF EXISTS clusters');
    backend.exec('DROP TABLE IF EXISTS cluster_membership');
    backend.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        language TEXT NOT NULL,
        git_blob_hash TEXT,
        last_scanned TEXT,
        size_bytes INTEGER DEFAULT 0,
        lines INTEGER DEFAULT 0
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        repo TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT,
        signature TEXT DEFAULT '',
        start_line INTEGER,
        end_line INTEGER,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (file_path) REFERENCES files(path)
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        source_symbol TEXT,
        target_symbol TEXT,
        edge_type TEXT NOT NULL,
        repo TEXT NOT NULL,
        weight REAL DEFAULT 1.0
      );
      CREATE TABLE snapshots (
        commit_sha TEXT PRIMARY KEY,
        parent_sha TEXT,
        timestamp TEXT,
        files_added TEXT DEFAULT '[]',
        files_modified TEXT DEFAULT '[]',
        files_removed TEXT DEFAULT '[]',
        symbols_delta TEXT DEFAULT '{}'
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    backend.close();

    // Now open via Store. It should detect schema version 1, apply migrations up to 6
    const storeV1 = new Store(testPath);
    expect(storeV1.getMeta('schema_version')).toBe('7');
    // Verify content_hash and target_repo columns exist
    const filesInfo = storeV1.raw.prepare("PRAGMA table_info(files)").all();
    expect(filesInfo.some((c: any) => c.name === 'content_hash')).toBe(true);
    expect(filesInfo.some((c: any) => c.name === 'namespace')).toBe(true);
    const edgesInfo = storeV1.raw.prepare("PRAGMA table_info(edges)").all();
    expect(edgesInfo.some((c: any) => c.name === 'target_repo')).toBe(true);
    expect(edgesInfo.some((c: any) => c.name === 'verifiability')).toBe(true);
    
    storeV1.close();
    fs.unlinkSync(testPath);
  });

  it('runs migrations from version 2', () => {
    const testPath = 'tests/migration-v2.db';
    if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
    
    // Create database manually with v2 schema (has content_hash, but not verifiability/namespace/target_repo)
    const backend = new Store(testPath).raw;
    backend.exec('DROP TABLE IF EXISTS files');
    backend.exec('DROP TABLE IF EXISTS symbols');
    backend.exec('DROP TABLE IF EXISTS edges');
    backend.exec('DROP TABLE IF EXISTS snapshots');
    backend.exec('DROP TABLE IF EXISTS meta');
    backend.exec('DROP TABLE IF EXISTS clusters');
    backend.exec('DROP TABLE IF EXISTS cluster_membership');
    backend.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        language TEXT NOT NULL,
        git_blob_hash TEXT,
        content_hash TEXT,
        last_scanned TEXT,
        size_bytes INTEGER DEFAULT 0,
        lines INTEGER DEFAULT 0
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        repo TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT,
        signature TEXT DEFAULT '',
        start_line INTEGER,
        end_line INTEGER,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (file_path) REFERENCES files(path)
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file TEXT NOT NULL,
        target_file TEXT NOT NULL,
        source_symbol TEXT,
        target_symbol TEXT,
        edge_type TEXT NOT NULL,
        repo TEXT NOT NULL,
        weight REAL DEFAULT 1.0
      );
      CREATE TABLE snapshots (
        commit_sha TEXT PRIMARY KEY,
        parent_sha TEXT,
        timestamp TEXT,
        files_added TEXT DEFAULT '[]',
        files_modified TEXT DEFAULT '[]',
        files_removed TEXT DEFAULT '[]',
        symbols_delta TEXT DEFAULT '{}'
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    backend.close();

    // Now open via Store. It should detect schema version 2, apply migrations up to 6
    const storeV2 = new Store(testPath);
    expect(storeV2.getMeta('schema_version')).toBe('7');
    storeV2.close();
    fs.unlinkSync(testPath);
  });

  it('handles invalid JSON metadata gracefully in updateFileMetadata', () => {
    store.upsertFile({
      path: 'src/bad-meta.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 100,
      lines: 10
    });
    
    // Manually break JSON metadata in DB
    store.raw.prepare("UPDATE files SET metadata = 'invalid_json' WHERE path = ?").run('src/bad-meta.ts');
    
    // updateFileMetadata should handle it and overwrite / merge cleanly
    store.updateFileMetadata('src/bad-meta.ts', { new_key: 'new_val' });
    const file = store.getFile('src/bad-meta.ts') as any;
    expect(JSON.parse(file.metadata)).toEqual({ new_key: 'new_val' });
    
    // With namespace
    store.updateFileMetadata('src/bad-meta.ts', { new_key: 'another_val', namespace: 'my-ns' });
    const file2 = store.getFile('src/bad-meta.ts') as any;
    expect(JSON.parse(file2.metadata)).toEqual({ new_key: 'another_val', namespace: 'my-ns' });
    expect(file2.namespace).toBe('my-ns');
  });

  it('performs glob and wildcard searches in searchSymbols', () => {
    store.upsertFile({
      path: 'src/glob-test.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });

    store.insertSymbol({
      filePath: 'src/glob-test.ts',
      repo: 'mapx',
      name: 'GlobTestClass',
      kind: 'class',
      scope: null,
      signature: '',
      startLine: 1,
      endLine: 2,
      metadata: '{}'
    });

    // Glob search
    const globRes = store.searchSymbols('GlobTest*', 'mapx');
    expect(globRes).toHaveLength(1);
    expect(globRes[0].name).toBe('GlobTestClass');

    // Wildcard search
    const wildRes = store.searchSymbols('*', 'mapx');
    expect(wildRes.length).toBeGreaterThan(0);

    // Non-repo search
    const nonRepoRes = store.searchSymbols('GlobTest*');
    expect(nonRepoRes).toHaveLength(1);
  });

  it('gets language breakdown without repo', () => {
    const bd = store.getLanguageBreakdown();
    expect(bd.typescript).toBeGreaterThan(0);
  });

  it('deletes repo correctly', () => {
    store.upsertFile({
      path: 'src/delete-me.ts',
      repo: 'delete-repo',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });
    store.insertSymbol({
      filePath: 'src/delete-me.ts',
      repo: 'delete-repo',
      name: 'DeleteClass',
      kind: 'class',
      scope: null,
      signature: '',
      startLine: 1,
      endLine: 2,
      metadata: '{}'
    });
    store.insertEdge({
      sourceFile: 'src/delete-me.ts',
      targetFile: 'src/utils.ts',
      sourceSymbol: 'DeleteClass',
      targetSymbol: 'helper',
      edgeType: 'call',
      repo: 'delete-repo',
      weight: 1.0,
      verifiability: 'verified'
    });
    store.setMeta('last_scan_commit:delete-repo', 'commit1');

    store.deleteRepo('delete-repo');

    expect(store.getAllFiles('delete-repo')).toHaveLength(0);
    expect(store.getSymbolsForFile('src/delete-me.ts')).toHaveLength(0);
    expect(store.getMeta('last_scan_commit:delete-repo')).toBeNull();
  });

  it('performs cluster membership, file, and edge queries', () => {
    store.clearClusters('mapx');
    store.upsertFile({
      path: 'src/c1-file.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });
    store.upsertFile({
      path: 'src/c2-file.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });

    store.insertCluster({
      repo: 'mapx',
      name: 'c1',
      label: 'Cluster 1',
      source: 'dir',
      parentName: null,
      depth: 1,
      fileCount: 1
    });
    store.insertCluster({
      repo: 'mapx',
      name: 'c2',
      label: 'Cluster 2',
      source: 'dir',
      parentName: null,
      depth: 1,
      fileCount: 1
    });

    store.insertClusterMembership({
      filePath: 'src/c1-file.ts',
      clusterName: 'c1',
      repo: 'mapx',
      isPrimary: 1
    });
    store.insertClusterMembership({
      filePath: 'src/c2-file.ts',
      clusterName: 'c2',
      repo: 'mapx',
      isPrimary: 1
    });

    // Test getClusterMemberships
    const memberships = store.getClusterMemberships('mapx');
    expect(memberships.some(m => m.file_path === 'src/c1-file.ts')).toBe(true);

    // Test getClusterFiles
    const files = store.getClusterFiles('c1', 'mapx');
    expect(files).toEqual(['src/c1-file.ts']);

    // Test getClusterEdges
    // Insert edge between c1-file and c2-file
    store.insertEdge({
      sourceFile: 'src/c1-file.ts',
      targetFile: 'src/c2-file.ts',
      sourceSymbol: 'A',
      targetSymbol: 'B',
      edgeType: 'call',
      repo: 'mapx',
      weight: 1.0
    });

    const cEdges = store.getClusterEdges('c1', 'mapx');
    expect(cEdges).toHaveLength(1);
    expect(cEdges[0].sourceCluster).toBe('c1');
    expect(cEdges[0].targetCluster).toBe('c2');
    expect(cEdges[0].edgeCount).toBe(1);
  });

  it('performs searchSymbolsFiltered option combinations', () => {
    store.upsertFile({
      path: 'src/c1-file.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });

    store.insertSymbol({
      filePath: 'src/c1-file.ts',
      repo: 'mapx',
      name: 'A',
      kind: 'class',
      scope: null,
      signature: '',
      startLine: 1,
      endLine: 2,
      metadata: '{}'
    });
    
    const r2 = store.searchSymbolsFiltered({
      term: 'A',
      exact: true,
      repo: 'mapx'
    });
    expect(r2).toHaveLength(1);

    // Wildcard search with filePrefix and kind
    const r3 = store.searchSymbolsFiltered({
      term: '*',
      kind: 'class',
      filePrefix: 'src/c1',
      repo: 'mapx'
    });
    expect(r3).toHaveLength(1);
    expect(r3[0].name).toBe('A');

    // Glob search in searchSymbolsFiltered
    const r4 = store.searchSymbolsFiltered({
      term: 'A*',
      repo: 'mapx'
    });
    expect(r4).toHaveLength(1);
  });

  it('performs getCallersOfSymbol and getCalleesOfSymbol combinations', () => {
    store.deleteEdgesForFile('src/c1-file.ts');
    store.deleteSymbolsForFile('src/c1-file.ts');
    store.deleteSymbolsForFile('src/c2-file.ts');

    store.upsertFile({
      path: 'src/c1-file.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });
    store.upsertFile({
      path: 'src/c2-file.ts',
      repo: 'mapx',
      language: 'typescript',
      gitBlobHash: null,
      contentHash: null,
      lastScanned: '',
      sizeBytes: 10,
      lines: 2
    });

    store.insertSymbol({
      filePath: 'src/c1-file.ts',
      repo: 'mapx',
      name: 'A',
      kind: 'class',
      scope: null,
      signature: '',
      startLine: 1,
      endLine: 2,
      metadata: '{}'
    });

    store.insertSymbol({
      filePath: 'src/c2-file.ts',
      repo: 'mapx',
      name: 'B',
      kind: 'class',
      scope: null,
      signature: '',
      startLine: 1,
      endLine: 2,
      metadata: '{}'
    });

    store.insertEdge({
      sourceFile: 'src/c1-file.ts',
      targetFile: 'src/c2-file.ts',
      sourceSymbol: 'A',
      targetSymbol: 'B',
      edgeType: 'call',
      repo: 'mapx',
      weight: 1.0
    });

    // Callers of B (should return edge pointing to B)
    const callers = store.getCallersOfSymbol('B', 'mapx');
    expect(callers).toHaveLength(1);

    // Callees of A (should return edge from A)
    const callees = store.getCalleesOfSymbol('A', 'mapx');
    expect(callees).toHaveLength(1);
  });

  it('performs getFilesFiltered path sort option', () => {
    const files = store.getFilesFiltered({
      sort: 'path',
      repo: 'mapx'
    });
    expect(files.length).toBeGreaterThan(0);
  });

  it('performs getSymbolByName with various combinations', () => {
    store.insertSymbol({
      filePath: 'src/main.ts',
      repo: 'mapx',
      name: 'MyClass',
      kind: 'class',
      scope: 'MyScope',
      signature: '',
      startLine: 1,
      endLine: 10,
      metadata: '{}'
    });

    // 1. scope and name with repo
    const s1 = store.getSymbolByName('MyScope::MyClass', 'mapx');
    expect(s1).toBeDefined();
    expect(s1?.name).toBe('MyClass');

    // 2. scope and name without repo
    const s2 = store.getSymbolByName('MyScope::MyClass');
    expect(s2).toBeDefined();
    expect(s2?.name).toBe('MyClass');

    // 3. name without repo
    const s3 = store.getSymbolByName('MyClass');
    expect(s3).toBeDefined();
    expect(s3?.name).toBe('MyClass');
  });

  it('performs getFilesFiltered with sort lines', () => {
    const files = store.getFilesFiltered({
      sort: 'lines',
      repo: 'mapx'
    });
    expect(files.length).toBeGreaterThan(0);
  });

  it('covers the remaining store methods to bridge coverage gaps', () => {
    // 1. deleteFrameworkEdgesForRepo
    store.insertEdge({
      sourceFile: 'src/main.ts',
      targetFile: 'src/utils.ts',
      sourceSymbol: 'A',
      targetSymbol: 'B',
      edgeType: 'route',
      repo: 'mapx',
      weight: 1.0
    });
    expect(store.getAllEdges('mapx').length).toBeGreaterThan(0);
    store.deleteFrameworkEdgesForRepo('mapx');
    expect(store.getAllEdges('mapx').some(e => e.edge_type === 'route')).toBe(false);

    // 2. getAllSymbols (repo and no-repo)
    expect(store.getAllSymbols('mapx').length).toBeGreaterThan(0);
    expect(store.getAllSymbols().length).toBeGreaterThan(0);

    // 3. getAllEdges (repo and no-repo)
    expect(store.getAllEdges('mapx').length).toBeGreaterThan(0);
    expect(store.getAllEdges().length).toBeGreaterThan(0);

    // 4. getFileCount, getSymbolCount, getEdgeCount (repo and no-repo)
    expect(store.getFileCount('mapx')).toBeGreaterThan(0);
    expect(store.getFileCount()).toBeGreaterThan(0);
    expect(store.getSymbolCount('mapx')).toBeGreaterThan(0);
    expect(store.getSymbolCount()).toBeGreaterThan(0);
    expect(store.getEdgeCount('mapx')).toBeGreaterThan(0);
    expect(store.getEdgeCount()).toBeGreaterThan(0);

    // 5. getLanguageBreakdown (with repo)
    const breakdown = store.getLanguageBreakdown('mapx');
    expect(breakdown.typescript).toBeGreaterThan(0);

    // 6. getClusters and getClusterMemberships without repo
    expect(store.getClusters().length).toBeGreaterThan(0);
    expect(store.getClusterMemberships().length).toBeGreaterThan(0);

    // 7. searchSymbolsFiltered default substring match case
    const filteredRes = store.searchSymbolsFiltered({
      term: 'Class',
      repo: 'mapx'
    });
    expect(filteredRes.length).toBeGreaterThan(0);

    // 8. snapshots CRUD
    store.upsertSnapshot({
      commitSha: 'commit123',
      parentSha: null,
      timestamp: '2026-05-29T00:00:00Z',
      filesAdded: '[]',
      filesModified: '[]',
      filesRemoved: '[]',
      symbolsDelta: '{}'
    });
    const latest = store.getLatestSnapshot();
    expect(latest).toBeDefined();
    expect(latest?.commit_sha).toBe('commit123');

    // 9. getAllFiles without repo
    expect(store.getAllFiles().length).toBeGreaterThan(0);

    // 10. searchSymbols substring match
    const ssNoRepo = store.searchSymbols('MyClass');
    expect(ssNoRepo.length).toBeGreaterThan(0);
  });

  it('handles columnExists catch block', () => {
    // Passing syntax error table name
    const exists = (store as any).columnExists('invalid; syntax', 'col');
    expect(exists).toBe(false);
  });

  describe('resetRepoForScan', () => {
    const REPO = 'reset-test-repo';
    const OTHER_REPO = 'other-repo';

    function seedRepo(s: Store, repo: string, filePath: string) {
      s.upsertFile({ path: filePath, repo, language: 'typescript', gitBlobHash: null, contentHash: 'h', lastScanned: '', sizeBytes: 10, lines: 1 });
      s.insertSymbol({ filePath, repo, name: 'Sym', kind: 'class', scope: null, signature: '', startLine: 1, endLine: 2, metadata: '{}' });
      s.insertEdge({ sourceFile: filePath, targetFile: 'other/dep.ts', sourceSymbol: 'Sym', targetSymbol: null, edgeType: 'import', repo, weight: 1 });
      s.insertCluster({ repo, name: `cluster:${repo}`, label: 'Cluster', source: 'dir', parentName: null, depth: 1, fileCount: 1 });
      s.insertClusterMembership({ filePath, clusterName: `cluster:${repo}`, repo, isPrimary: 1 });
    }

    it('clears files, symbols, edges, and clusters for the target repo', () => {
      const s = new Store(':memory:');
      seedRepo(s, REPO, 'src/reset.ts');

      s.resetRepoForScan(REPO);

      expect(s.getAllFiles(REPO)).toHaveLength(0);
      expect(s.getSymbolsForFile('src/reset.ts')).toHaveLength(0);
      expect(s.getEdgesForFile('src/reset.ts')).toHaveLength(0);
      expect(s.getClusters(REPO)).toHaveLength(0);
      expect(s.getClusterMemberships(REPO)).toHaveLength(0);
    });

    it('does NOT touch files, symbols, or edges belonging to other repos', () => {
      const s = new Store(':memory:');
      seedRepo(s, REPO, 'src/reset.ts');
      seedRepo(s, OTHER_REPO, 'src/other.ts');

      s.resetRepoForScan(REPO);

      expect(s.getAllFiles(OTHER_REPO)).toHaveLength(1);
      expect(s.getSymbolsForFile('src/other.ts')).toHaveLength(1);
    });

    it('preserves cross-repo incoming edges (target_repo of another repo)', () => {
      const s = new Store(':memory:');
      // Edge from OTHER_REPO pointing INTO REPO (as target_repo)
      s.upsertFile({ path: 'src/other.ts', repo: OTHER_REPO, language: 'typescript', gitBlobHash: null, contentHash: null, lastScanned: '', sizeBytes: 10, lines: 1 });
      s.insertEdge({ sourceFile: 'src/other.ts', targetFile: 'src/reset.ts', sourceSymbol: null, targetSymbol: null, edgeType: 'import', repo: OTHER_REPO, weight: 1, targetRepo: REPO });

      s.resetRepoForScan(REPO);

      // The incoming edge from OTHER_REPO should still exist
      const edges = s.getReverseEdges('src/reset.ts');
      expect(edges).toHaveLength(1);
      expect(edges[0].repo).toBe(OTHER_REPO);
    });

    it('preserves last_scan_commit and last_scan_time meta keys', () => {
      const s = new Store(':memory:');
      s.setMeta(`last_scan_commit:${REPO}`, 'abc123');
      s.setMeta(`last_scan_time:${REPO}`, '2026-01-01T00:00:00Z');

      s.resetRepoForScan(REPO);

      expect(s.getMeta(`last_scan_commit:${REPO}`)).toBe('abc123');
      expect(s.getMeta(`last_scan_time:${REPO}`)).toBe('2026-01-01T00:00:00Z');
    });

    it('is idempotent — calling twice on empty repo does not throw', () => {
      const s = new Store(':memory:');
      expect(() => {
        s.resetRepoForScan(REPO);
        s.resetRepoForScan(REPO);
      }).not.toThrow();
    });
  });
});
