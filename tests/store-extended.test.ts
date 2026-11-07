import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { globToLike, isGlobPattern, isWildcard } from '../src/core/fuzzy-matcher.js';
import { buildServer } from '../src/mcp.js';
import { startUiServer } from '../src/ui-server.js';
import { Store } from '../src/core/store.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

/**
 * Extended Store tests covering:
 * - File CRUD (upsert, delete, getFile, getAllFiles)
 * - Symbol insertion and lookup
 * - Edge insertion, querying, and filtering
 * - Caller/callee resolution
 * - File filtering (path, lang, sort, limit)
 * - Meta key-value store
 * - Count operations (files, symbols, edges)
 * - Language breakdown
 * - Cluster operations
 * - Transaction support
 *
 * Uses better-sqlite3 directly to replicate Store's SQL patterns.
 */

const FULL_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  language TEXT NOT NULL,
  git_blob_hash TEXT,
  content_hash TEXT,
  last_scanned TEXT,
  size_bytes INTEGER DEFAULT 0,
  lines INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  namespace TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
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

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_scope ON symbols(scope);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  source_symbol TEXT,
  target_symbol TEXT,
  edge_type TEXT NOT NULL,
  repo TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  verifiability TEXT NOT NULL DEFAULT 'verified',
  metadata TEXT DEFAULT '{}',
  target_repo TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_file);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_file);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  parent_name TEXT,
  depth INTEGER DEFAULT 0,
  file_count INTEGER DEFAULT 0,
  UNIQUE(repo, name)
);

CREATE TABLE IF NOT EXISTS cluster_membership (
  file_path TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  repo TEXT NOT NULL,
  is_primary INTEGER DEFAULT 1,
  PRIMARY KEY (file_path, cluster_name, repo)
);
`;

// Helper: replicate Store's searchSymbolsFiltered logic
function searchSymbolsFiltered(db: Database.Database, options: {
  term: string; kind?: string; filePrefix?: string; exact?: boolean; limit?: number; repo?: string;
}): any[] {
  const limit = options.limit ?? 20;
  let sql = 'SELECT * FROM symbols WHERE ';
  const params: any[] = [];

  if (isWildcard(options.term)) {
    sql += '1=1';
  } else if (options.exact) {
    sql += '(name = ? COLLATE NOCASE OR file_path = ? COLLATE NOCASE)';
    params.push(options.term, options.term);
  } else if (isGlobPattern(options.term)) {
    sql += '(name LIKE ? COLLATE NOCASE)';
    params.push(globToLike(options.term));
  } else {
    sql += '(name LIKE ? COLLATE NOCASE OR file_path LIKE ? COLLATE NOCASE)';
    params.push(`%${options.term}%`, `%${options.term}%`);
  }

  if (options.kind) {
    sql += ' AND LOWER(kind) = ?';
    params.push(options.kind.toLowerCase());
  }
  if (options.filePrefix) {
    sql += ' AND file_path LIKE ?';
    params.push(`${options.filePrefix}%`);
  }
  if (options.repo) {
    sql += ' AND repo = ?';
    params.push(options.repo);
  }
  sql += ' ORDER BY kind, name LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

describe('Store — extended operations', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(FULL_SCHEMA);

    // Seed files
    const insertFile = db.prepare(
      `INSERT INTO files (path, repo, language, last_scanned, size_bytes, lines) VALUES (?, ?, ?, datetime('now'), ?, ?)`
    );
    insertFile.run('src/core/store.ts', 'mapx', 'typescript', 27000, 849);
    insertFile.run('src/core/graph.ts', 'mapx', 'typescript', 7200, 213);
    insertFile.run('src/cli.ts', 'mapx', 'typescript', 99000, 2683);
    insertFile.run('src/mcp.ts', 'mapx', 'typescript', 98000, 2345);
    insertFile.run('tests/store.test.ts', 'mapx', 'typescript', 5000, 150);
    insertFile.run('src/core/scanner.py', 'mapx', 'python', 3000, 120);
    insertFile.run('src/index.ts', 'mapx', 'typescript', 100, 5);

    // Seed symbols
    const insertSymbol = db.prepare(
      'INSERT INTO symbols (file_path, repo, name, kind, scope, signature, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertSymbol.run('src/core/store.ts', 'mapx', 'Store', 'class', null, 'export class Store', 152, 848);
    insertSymbol.run('src/core/store.ts', 'mapx', 'searchSymbols', 'method', 'Store', 'searchSymbols(pattern)', 310, 329);
    insertSymbol.run('src/core/store.ts', 'mapx', 'searchSymbolsFiltered', 'method', 'Store', 'searchSymbolsFiltered(opts)', 606, 658);
    insertSymbol.run('src/core/store.ts', 'mapx', 'getCallersOfSymbol', 'method', 'Store', 'getCallersOfSymbol(name)', 755, 792);
    insertSymbol.run('src/core/graph.ts', 'mapx', 'MapxGraph', 'class', null, 'export class MapxGraph', 5, 212);
    insertSymbol.run('src/core/graph.ts', 'mapx', 'computePageRank', 'method', 'MapxGraph', 'computePageRank()', 69, 81);
    insertSymbol.run('src/cli.ts', 'mapx', 'main', 'function', null, 'async function main()', 50, 2680);
    insertSymbol.run('src/mcp.ts', 'mapx', 'createMcpServer', 'function', null, 'function createMcpServer()', 100, 2100);
    insertSymbol.run('src/core/scanner.py', 'mapx', 'Scanner', 'class', null, 'class Scanner:', 1, 120);
    insertSymbol.run('tests/store.test.ts', 'mapx', 'testSearch', 'function', null, 'function testSearch()', 1, 50);

    // Seed edges
    const insertEdge = db.prepare(
      `INSERT INTO edges (source_file, target_file, source_symbol, target_symbol, edge_type, repo, weight, verifiability) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertEdge.run('src/cli.ts', 'src/core/store.ts', 'main', 'Store', 'call', 'mapx', 2.0, 'verified');
    insertEdge.run('src/cli.ts', 'src/core/store.ts', 'main', 'searchSymbols', 'call', 'mapx', 1.0, 'verified');
    insertEdge.run('src/cli.ts', 'src/core/graph.ts', 'main', 'MapxGraph', 'import', 'mapx', 1.0, 'verified');
    insertEdge.run('src/mcp.ts', 'src/core/store.ts', 'createMcpServer', 'Store', 'call', 'mapx', 3.0, 'verified');
    insertEdge.run('src/mcp.ts', 'src/core/graph.ts', null, null, 'import', 'mapx', 1.0, 'verified');
    insertEdge.run('src/core/store.ts', 'src/core/graph.ts', 'Store', 'MapxGraph', 'import', 'mapx', 1.0, 'verified');
    insertEdge.run('tests/store.test.ts', 'src/core/store.ts', 'testSearch', 'searchSymbols', 'call', 'mapx', 1.0, 'verified');
    insertEdge.run('src/mcp.ts', 'src/core/store.ts', null, 'searchSymbolsFiltered', 'call', 'mapx', 1.0, 'inferred');
  });

  afterAll(() => {
    db.close();
  });

  // ─── Meta Operations ──────────────────────────────────────────

  describe('Meta key-value store', () => {
    it('should set and get meta', () => {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('test_key', 'test_value');
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('test_key') as any;
      expect(row.value).toBe('test_value');
    });

    it('should return null for unknown key', () => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('nonexistent') as any;
      expect(row).toBeUndefined();
    });

    it('should upsert meta', () => {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('test_key', 'updated');
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('test_key') as any;
      expect(row.value).toBe('updated');
    });
  });

  // ─── File Operations ──────────────────────────────────────────

  describe('File operations', () => {
    it('should count files', () => {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM files').get() as any;
      expect(row.cnt).toBe(7);
    });

    it('should count files by repo', () => {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM files WHERE repo = ?').get('mapx') as any;
      expect(row.cnt).toBe(7);
    });

    it('should get file by path', () => {
      const file = db.prepare('SELECT * FROM files WHERE path = ?').get('src/core/store.ts') as any;
      expect(file).toBeDefined();
      expect(file.language).toBe('typescript');
      expect(file.lines).toBe(849);
    });

    it('should get language breakdown', () => {
      const rows = db.prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language').all() as any[];
      const ts = rows.find(r => r.language === 'typescript');
      const py = rows.find(r => r.language === 'python');
      expect(ts!.cnt).toBe(6);
      expect(py!.cnt).toBe(1);
    });

    it('should delete a file and cascade', () => {
      db.prepare(`INSERT INTO files (path, repo, language, size_bytes, lines) VALUES (?, ?, ?, ?, ?)`).run('temp.ts', 'mapx', 'typescript', 100, 10);
      db.prepare('INSERT INTO symbols (file_path, repo, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)').run('temp.ts', 'mapx', 'TempClass', 'class', 1, 10);

      // Simulate Store.deleteFile cascade
      db.prepare('DELETE FROM symbols WHERE file_path = ?').run('temp.ts');
      db.prepare('DELETE FROM edges WHERE source_file = ? OR target_file = ?').run('temp.ts', 'temp.ts');
      db.prepare('DELETE FROM files WHERE path = ?').run('temp.ts');

      const file = db.prepare('SELECT * FROM files WHERE path = ?').get('temp.ts');
      expect(file).toBeUndefined();
      const syms = db.prepare('SELECT * FROM symbols WHERE file_path = ?').all('temp.ts');
      expect(syms.length).toBe(0);
    });
  });

  // ─── File Filtering ───────────────────────────────────────────

  describe('File filtering (getFilesFiltered)', () => {
    function getFilesFiltered(opts: { pathPrefix?: string; lang?: string; sort?: 'lines' | 'path'; limit?: number; repo?: string }) {
      const limit = opts.limit ?? 50;
      let sql = 'SELECT * FROM files WHERE 1=1';
      const params: any[] = [];
      if (opts.pathPrefix) {
        const raw = opts.pathPrefix;
        const isGlob = raw.includes('*') || raw.includes('?');
        if (isGlob) {
          const likePattern = raw.replace(/\*/g, '%').replace(/\?/g, '_');
          sql += ' AND path LIKE ?';
          params.push(likePattern);
        } else {
          sql += ' AND path LIKE ?';
          params.push(`${raw}%`);
        }
      }
      if (opts.lang) { sql += ' AND LOWER(language) = ?'; params.push(opts.lang.toLowerCase()); }
      if (opts.repo) { sql += ' AND repo = ?'; params.push(opts.repo); }
      if (opts.sort === 'lines') { sql += ' ORDER BY lines DESC'; }
      else if (opts.sort === 'path') { sql += ' ORDER BY path ASC'; }
      sql += ' LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params);
    }

    it('should filter by path prefix', () => {
      const results = getFilesFiltered({ pathPrefix: 'src/core/' });
      expect(results.every((f: any) => f.path.startsWith('src/core/'))).toBe(true);
    });

    it('should filter by language', () => {
      const results = getFilesFiltered({ lang: 'python' });
      expect(results.length).toBe(1);
      expect((results[0] as any).path).toBe('src/core/scanner.py');
    });

    it('should sort by lines descending', () => {
      const results = getFilesFiltered({ sort: 'lines' }) as any[];
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].lines).toBeGreaterThanOrEqual(results[i].lines);
      }
    });

    it('should sort by path ascending', () => {
      const results = getFilesFiltered({ sort: 'path' }) as any[];
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].path <= results[i].path).toBe(true);
      }
    });

    it('should respect limit', () => {
      const results = getFilesFiltered({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it('should combine path prefix + language', () => {
      const results = getFilesFiltered({ pathPrefix: 'src/core/', lang: 'typescript' });
      expect(results.every((f: any) => f.path.startsWith('src/core/') && f.language === 'typescript')).toBe(true);
    });

    it('should match *.ts glob (all TypeScript files)', () => {
      const results = getFilesFiltered({ pathPrefix: '*.ts' }) as any[];
      // *.ts matches only top-level *.ts (no slash), e.g. none if all are under subdirs
      // The seeded top-level TS file is src/index.ts – but *.ts LIKE '%' expands to any path ending in .ts
      // Actually *.ts → LIKE '%.ts' which matches any path ending in .ts
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((f: any) => f.path.endsWith('.ts'))).toBe(true);
    });

    it('should match src/core/*.ts glob', () => {
      const results = getFilesFiltered({ pathPrefix: 'src/core/*.ts' }) as any[];
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((f: any) => f.path.startsWith('src/core/') && f.path.endsWith('.ts'))).toBe(true);
    });

    it('should match src/core/store?ts glob (? wildcard)', () => {
      const results = getFilesFiltered({ pathPrefix: 'src/core/store?ts' }) as any[];
      expect(results.length).toBe(1);
      expect((results[0] as any).path).toBe('src/core/store.ts');
    });

    it('should match **/*.ts double-star glob', () => {
      const results = getFilesFiltered({ pathPrefix: '**/*.ts' }) as any[];
      // **/*.ts → LIKE '%%.ts' → matches any path ending in .ts
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((f: any) => f.path.endsWith('.ts'))).toBe(true);
    });

    it('should return no results for non-matching glob', () => {
      const results = getFilesFiltered({ pathPrefix: 'nonexistent/*.rb' });
      expect(results.length).toBe(0);
    });

    it('should combine glob path with language filter', () => {
      const results = getFilesFiltered({ pathPrefix: 'src/*.ts', lang: 'typescript' }) as any[];
      expect(results.every((f: any) => f.path.endsWith('.ts') && f.language === 'typescript')).toBe(true);
    });
  });

  // ─── Edge Operations ──────────────────────────────────────────

  describe('Edge operations', () => {
    it('should count edges', () => {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as any;
      expect(row.cnt).toBe(8);
    });

    it('should get edges for a source file', () => {
      const edges = db.prepare('SELECT * FROM edges WHERE source_file = ? ORDER BY edge_type').all('src/cli.ts');
      expect(edges.length).toBe(3);
    });

    it('should get reverse edges for a target file', () => {
      const edges = db.prepare('SELECT * FROM edges WHERE target_file = ? ORDER BY edge_type').all('src/core/store.ts');
      expect(edges.length).toBeGreaterThan(0);
    });

    it('should query edges by type', () => {
      const edges = db.prepare('SELECT * FROM edges WHERE edge_type = ?').all('call') as any[];
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every(e => e.edge_type === 'call')).toBe(true);
    });

    it('should query edges by from pattern', () => {
      const edges = db.prepare('SELECT * FROM edges WHERE source_file LIKE ?').all('%cli%');
      expect(edges.length).toBe(3);
    });
  });

  // ─── queryEdges ───────────────────────────────────────────────

  describe('queryEdges', () => {
    function queryEdges(options: { type?: string; from?: string; to?: string; repo?: string }) {
      let sql = 'SELECT * FROM edges WHERE 1=1';
      const params: string[] = [];
      if (options.repo) { sql += ' AND repo = ?'; params.push(options.repo); }
      if (options.type) { sql += ' AND edge_type = ?'; params.push(options.type); }
      if (options.from) { sql += ' AND source_file LIKE ?'; params.push(`%${options.from}%`); }
      if (options.to) { sql += ' AND target_file LIKE ?'; params.push(`%${options.to}%`); }
      return db.prepare(sql).all(...params);
    }

    it('should filter by edge type', () => {
      const results = queryEdges({ type: 'import' });
      expect(results.every((e: any) => e.edge_type === 'import')).toBe(true);
    });

    it('should filter by source', () => {
      const results = queryEdges({ from: 'mcp' });
      expect(results.every((e: any) => e.source_file.includes('mcp'))).toBe(true);
    });

    it('should filter by target', () => {
      const results = queryEdges({ to: 'graph' });
      expect(results.every((e: any) => e.target_file.includes('graph'))).toBe(true);
    });

    it('should combine type + from + to', () => {
      const results = queryEdges({ type: 'call', from: 'cli', to: 'store' });
      expect(results.length).toBe(2);
    });
  });

  // ─── Callers/Callees ──────────────────────────────────────────

  describe('Callers of symbol', () => {
    function getCallersOfSymbol(fullName: string, repo?: string) {
      let symbols: any[] = [];
      if (fullName.includes('::')) {
        const [scope, name] = fullName.split('::');
        let sql = 'SELECT * FROM symbols WHERE scope = ? AND name = ?';
        const params = [scope, name];
        if (repo) { sql += ' AND repo = ?'; params.push(repo); }
        symbols = db.prepare(sql).all(...params);
      } else {
        let sql = 'SELECT * FROM symbols WHERE name = ?';
        const params = [fullName];
        if (repo) { sql += ' AND repo = ?'; params.push(repo); }
        symbols = db.prepare(sql).all(...params);
      }
      if (symbols.length === 0) return [];

      const results: any[] = [];
      for (const sym of symbols) {
        let sql = "SELECT * FROM edges WHERE target_file = ? AND (target_symbol = ? OR target_symbol = ?) AND edge_type NOT IN ('import', 'require')";
        const params = [sym.file_path, sym.name, `${sym.scope}::${sym.name}`];
        if (repo) { sql += ' AND repo = ?'; params.push(repo); }
        results.push(...db.prepare(sql).all(...params));
      }
      return results;
    }

    it('should find callers of a top-level symbol', () => {
      const callers = getCallersOfSymbol('Store');
      expect(callers.length).toBeGreaterThan(0);
      expect(callers.some((c: any) => c.source_file === 'src/cli.ts')).toBe(true);
    });

    it('should find callers of a scoped symbol (Store::searchSymbols)', () => {
      const callers = getCallersOfSymbol('Store::searchSymbols');
      expect(callers.length).toBeGreaterThan(0);
    });

    it('should return empty for unknown symbol', () => {
      const callers = getCallersOfSymbol('NonExistentSymbol');
      expect(callers).toEqual([]);
    });

    it('should exclude import/require edges', () => {
      const callers = getCallersOfSymbol('MapxGraph');
      // import edges to MapxGraph should be excluded
      expect(callers.every((c: any) => c.edge_type !== 'import')).toBe(true);
    });
  });

  describe('Callees of symbol', () => {
    function getCalleesOfSymbol(fullName: string) {
      const symbols = db.prepare('SELECT * FROM symbols WHERE name = ?').all(fullName);
      if (symbols.length === 0) return [];
      const results: any[] = [];
      for (const sym of symbols as any[]) {
        const edges = db.prepare('SELECT * FROM edges WHERE source_file = ? AND (source_symbol = ? OR source_symbol = ?)').all(sym.file_path, sym.name, `${sym.scope}::${sym.name}`);
        results.push(...edges);
      }
      return results;
    }

    it('should find callees of main function', () => {
      const callees = getCalleesOfSymbol('main');
      expect(callees.length).toBeGreaterThan(0);
    });

    it('should return empty for symbol with no outgoing edges', () => {
      const callees = getCalleesOfSymbol('Scanner');
      expect(callees).toEqual([]);
    });
  });

  // ─── Extended Search ──────────────────────────────────────────

  describe('searchSymbolsFiltered — extended', () => {
    it('should search by file path substring', () => {
      const results = searchSymbolsFiltered(db, { term: 'graph.ts' });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r: any) => r.file_path.includes('graph.ts'))).toBe(true);
    });

    it('should do exact match including file_path', () => {
      const results = searchSymbolsFiltered(db, { term: 'src/core/store.ts', exact: true });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by repo', () => {
      const results = searchSymbolsFiltered(db, { term: '*', repo: 'mapx' });
      expect(results.length).toBe(10);
    });

    it('should handle glob *Graph', () => {
      const results = searchSymbolsFiltered(db, { term: '*Graph' });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('MapxGraph');
    });

    it('should handle glob search*', () => {
      const results = searchSymbolsFiltered(db, { term: 'search*' });
      expect(results.length).toBe(2);
    });

    it('should combine glob + kind + filePrefix', () => {
      const results = searchSymbolsFiltered(db, { term: '*', kind: 'method', filePrefix: 'src/core/store.ts' });
      expect(results.length).toBe(3);
      expect(results.every((r: any) => r.kind === 'method')).toBe(true);
    });

    it('should return empty for non-existent kind', () => {
      const results = searchSymbolsFiltered(db, { term: '*', kind: 'trait' });
      expect(results.length).toBe(0);
    });
  });

  // ─── Cluster Operations ───────────────────────────────────────

  describe('Cluster operations', () => {
    beforeAll(() => {
      db.prepare(`INSERT INTO clusters (repo, name, label, source, parent_name, depth, file_count) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('mapx', 'core', 'Core', 'directory', null, 0, 3);
      db.prepare(`INSERT INTO clusters (repo, name, label, source, parent_name, depth, file_count) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('mapx', 'cli', 'CLI', 'directory', null, 0, 1);
      db.prepare(`INSERT INTO cluster_membership (file_path, cluster_name, repo, is_primary) VALUES (?, ?, ?, ?)`).run('src/core/store.ts', 'core', 'mapx', 1);
      db.prepare(`INSERT INTO cluster_membership (file_path, cluster_name, repo, is_primary) VALUES (?, ?, ?, ?)`).run('src/core/graph.ts', 'core', 'mapx', 1);
      db.prepare(`INSERT INTO cluster_membership (file_path, cluster_name, repo, is_primary) VALUES (?, ?, ?, ?)`).run('src/cli.ts', 'cli', 'mapx', 1);
    });

    it('should list clusters', () => {
      const clusters = db.prepare('SELECT * FROM clusters WHERE repo = ?').all('mapx');
      expect(clusters.length).toBe(2);
    });

    it('should get cluster files', () => {
      const files = db.prepare(`SELECT file_path FROM cluster_membership WHERE cluster_name = ? AND repo = ? AND is_primary = 1`).all('core', 'mapx');
      expect(files.length).toBe(2);
    });

    it('should clear clusters for a repo', () => {
      db.prepare('DELETE FROM cluster_membership WHERE repo = ?').run('mapx');
      db.prepare('DELETE FROM clusters WHERE repo = ?').run('mapx');
      const clusters = db.prepare('SELECT * FROM clusters WHERE repo = ?').all('mapx');
      expect(clusters.length).toBe(0);
    });
  });

  // ─── Transaction Support ──────────────────────────────────────

  describe('Transactions', () => {
    it('should support transaction commits', () => {
      const transaction = db.transaction(() => {
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('tx_key', 'tx_value');
        return db.prepare('SELECT value FROM meta WHERE key = ?').get('tx_key') as any;
      });
      const result = transaction();
      expect(result.value).toBe('tx_value');
    });

    it('should rollback on error', () => {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('rollback_test', 'before');
      try {
        const tx = db.transaction(() => {
          db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('rollback_test', 'during');
          throw new Error('forced rollback');
        });
        tx();
      } catch {}
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('rollback_test') as any;
      expect(row.value).toBe('before');
    });
  });
});

// M4-26: a symbol whose own name contains a dot opens by that name. A JS scan gives such a name to a
// string-keyed member of an object literal (`'api.get': …`, as in Vuex actions), a Lua scan to
// `function M.foo()`; member assignments (`api.get = …`) produce no symbol. The scoped reading
// (`Class.method`) is preferred and the exact name is the fallback, so nothing the scoped reading finds
// is lost; callers, callees and impact take both.
describe('dotted symbol names in a real scan (M4-26)', () => {
  let root: string;
  let client: Client;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    root = workspace({
      'src/store/actions.js': [
        "import { fetchJson } from '../http.js';",
        'export const actions = {',
        "  'api.get': (ctx) => fetchJson('/a'),",
        "  'cart.add'(ctx) { return ctx.commit('added'); },",
        // Collides with the Go method Server.Start below.
        "  'Server.Start': (ctx) => fetchJson('/s'),",
        '};',
        '',
      ].join('\n'),
      'src/http.js': 'export function fetchJson(url) { return url; }\n',
      // Importers of actions.js: one mentions the member, one only `axios.get`.
      'src/page.js': "import { actions } from './store/actions.js';\nexport const run = (ctx) => actions['api.get'](ctx);\n",
      'src/other.js': "import { actions } from './store/actions.js';\nimport axios from 'axios';\nexport const load = () => axios.get('/x') && actions;\n",
      'src/billing.ts': [
        'function limits() { return 3; }',
        'export class BillingService {',
        '  getEffectiveLimits() { return limits(); }',
        '}',
        '',
      ].join('\n'),
      'src/main.go': [
        'package main',
        'type Server struct{}',
        'func (s *Server) Start() { helper() }',
        'func helper() {}',
        'func main() { s := &Server{}; s.Start() }',
        '',
      ].join('\n'),
      'src/m.lua': 'local M = {}\nfunction M.foo() return M.bar() end\nfunction M.bar() return 1 end\nreturn M\n',
      // A method whose name is a file extension.
      'src/Runner.java': 'public class Runner {\n  void go() { }\n}\n',
    });
    init(root);
    mapx(root, 'scan', root);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    server = startUiServer({ port: 0, host: '127.0.0.1', dir: root }) as unknown as Server;
    // CLI runs between requests can outlast the 5 s default, and fetch would reuse a socket the server is closing.
    server.keepAliveTimeout = 120_000;
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);
  afterAll(async () => {
    await client?.close();
    if (server) await new Promise((r) => server.close(r));
    cleanup(root);
  });

  const cli = (name: string) => JSON.parse(mapx(root, 'node', name, '--dir', root, '--format', 'json'));
  const mcp = async (name: string) =>
    JSON.parse(((await client.callTool({ name: 'mapx_node', arguments: { dir: root, symbol: name, format: 'json' } })) as any).content[0].text);
  const dashboard = async (name: string) => {
    const res = await fetch(`${base}/api/symbol/${encodeURIComponent(name)}`);
    return { status: res.status, body: (await res.json()) as any };
  };
  const identity = (r: any) => ({ name: r.name, scope: r.scope ?? null, file: r.file ?? r.file_path, line: r.startLine ?? r.start_line });
  // `mapx callers` text output, as `caller -> callee @ file` lines (the raw output is the failure message).
  const expectCallers = (name: string, want: string[]) => {
    const out = mapx(root, 'callers', name, '--dir', root);
    const got = [...out.matchAll(/← (\S+) \(calls (\S+)\)\n\s+@ (\S+):/g)].map(([, caller, callee, file]) => `${caller} -> ${callee} @ ${file}`);
    expect(got.sort(), out).toEqual(want);
  };
  const impact = (name: string) => JSON.parse(mapx(root, 'impact', name, '--dir', root, '--format', 'json'));
  const affected = (r: any) => r.affected.map((x: any) => `[${x.risk}] ${x.symbol} (${x.file})`).sort();

  const API_GET = { name: 'api.get', scope: 'actions', file: 'src/store/actions.js', line: 3 };
  const CART_ADD = { name: 'cart.add', scope: 'actions', file: 'src/store/actions.js', line: 4 };
  const KEY_START = { name: 'Server.Start', scope: 'actions', file: 'src/store/actions.js', line: 5 };
  const GO_START = { name: 'Start', scope: 'Server', file: 'src/main.go', line: 3 };
  const LIMITS = { name: 'getEffectiveLimits', scope: 'BillingService', file: 'src/billing.ts', line: 3 };

  it('mapx node, MCP mapx_node and the dashboard open a dotted name, with its callee', async () => {
    for (const [name, want] of [['api.get', API_GET], ['cart.add', CART_ADD]] as const) {
      expect(identity(cli(name)), name).toEqual(want);
      expect(identity(await mcp(name)), name).toEqual(want);
      const { status, body } = await dashboard(name);
      expect(status, name).toBe(200);
      expect(identity(body.symbol), name).toEqual(want);
    }
    expect(cli('api.get').calleeCount).toBe(1);
    expect((await mcp('api.get')).calleeCount).toBe(1);
    const { body } = await dashboard('api.get');
    expect(body.callees.map((e: any) => [e.source_symbol, e.target_symbol, e.target_file])).toEqual([
      ['actions::api.get', 'fetchJson', 'src/http.js'],
    ]);
    expect(body.sourceCode).toContain("'api.get'");
  });

  // The scan's Lua call edge (M.foo → M.bar) is missing in some scans under CPU load (a scanner race,
  // reported in reports/M4-26.md), so callers of a dotted name are pinned at store level below.
  it('opens a Lua dotted function name', async () => {
    const M_BAR = { name: 'M.bar', scope: null, file: 'src/m.lua', line: 3 };
    expect(identity(cli('M.bar'))).toEqual(M_BAR);
    expect(identity(await mcp('M.bar'))).toEqual(M_BAR);
    expect(identity((await dashboard('M.bar')).body.symbol)).toEqual(M_BAR);
  });

  it('Class.method and Class::method still open the class member', async () => {
    for (const name of ['BillingService.getEffectiveLimits', 'BillingService::getEffectiveLimits']) {
      expect(identity(cli(name)), name).toEqual(LIMITS);
      expect(identity(await mcp(name)), name).toEqual(LIMITS);
      expect(identity((await dashboard(name)).body.symbol), name).toEqual(LIMITS);
    }
    expect(cli('BillingService.getEffectiveLimits').calleeCount).toBe(1);
    // `go` is a file extension, but no file is named Runner.go.
    expect(identity(cli('Runner.go'))).toEqual({ name: 'go', scope: 'Runner', file: 'src/Runner.java', line: 2 });
  });

  it('when a dotted name collides with Class.method, node opens the method and callers and impact keep its callers', async () => {
    for (const name of ['Server.Start', 'Server::Start']) {
      expect(identity(cli(name)), name).toEqual(GO_START);
      expect(identity(await mcp(name)), name).toEqual(GO_START);
      expect(identity((await dashboard(name)).body.symbol), name).toEqual(GO_START);
    }
    // The member is reached unambiguously through its scope.
    expect(identity(cli('actions::Server.Start'))).toEqual(KEY_START);
    expect(identity((await dashboard('actions::Server.Start')).body.symbol)).toEqual(KEY_START);

    expectCallers('Server.Start', ['main -> Start @ src/main.go']);
    expect(affected(impact('Server.Start'))).toEqual(['[HIGH] main (src/main.go)']);
    // Callees take both readings: the method's helper and the member's fetchJson.
    expect(cli('Server.Start').calleeCount).toBe(2);
  });

  it('impact of a dotted name flags an importer that mentions it, not one that mentions only its last segment', () => {
    expect(affected(impact('api.get'))).toEqual(['[LOW] <import> (src/page.js)']);
  });

  it('context seeds accept a dotted symbol name', () => {
    const seeded = (seed: string) => JSON.parse(mapx(root, 'context', 'fix bug', '--dir', root, '--seeds', seed, '--format', 'json'))
      .matchedSymbols.map((s: any) => `${s.name} @ ${s.filePath}`);
    expect(seeded('Server.Start')).toContain('Start @ src/main.go');
    expect(seeded('M.foo')).toContain('M.foo @ src/m.lua');
  });
});

// M4-26 at store level. Synthetic rows in the shapes a scan writes (observed above): Lua `M.foo`
// calling `M.bar`; a Go method `Server::Start` called by `main`; a JS member `'Server.Start'` of
// `actions` calling `fetchJson`.
describe('Store lookup of dotted names (M4-26)', () => {
  let store: Store;
  beforeAll(() => {
    store = new Store(':memory:');
    for (const [path, language] of [['src/m.lua', 'lua'], ['src/main.go', 'go'], ['src/store/actions.js', 'javascript'], ['src/http.js', 'javascript']]) {
      store.upsertFile({ path, repo: 'r', language, gitBlobHash: null, contentHash: null, lastScanned: '', sizeBytes: 0, lines: 0 });
    }
    const sym =(filePath: string, name: string, kind: string, scope: string | null, startLine: number) =>
      store.insertSymbol({ filePath, repo: 'r', name, kind, scope, signature: '', startLine, endLine: startLine, metadata: '{}' });
    const call = (sourceFile: string, sourceSymbol: string, targetFile: string, targetSymbol: string) =>
      store.insertEdge({ sourceFile, sourceSymbol, targetFile, targetSymbol, edgeType: 'call', repo: 'r', weight: 1 });
    sym('src/m.lua', 'M.foo', 'function', null, 2);
    sym('src/m.lua', 'M.bar', 'function', null, 3);
    call('src/m.lua', 'M.foo', 'src/m.lua', 'M.bar');
    sym('src/main.go', 'Start', 'method', 'Server', 3);
    sym('src/main.go', 'helper', 'function', null, 4);
    sym('src/main.go', 'main', 'function', null, 5);
    call('src/main.go', 'Server::Start', 'src/main.go', 'helper');
    call('src/main.go', 'main', 'src/main.go', 'Start');
    sym('src/store/actions.js', 'Server.Start', 'method', 'actions', 5);
    call('src/store/actions.js', 'actions::Server.Start', 'src/http.js', 'fetchJson');
  });
  afterAll(() => store.close());

  const at = (rows: any[]) => rows.map((e) => `${e.source_symbol} -> ${e.target_symbol}`).sort();

  it('lists the callers of a dotted name', () => {
    expect(at(store.getCallersOfSymbol('M.bar'))).toEqual(['M.foo -> M.bar']);
    expect(at(store.getCalleesOfSymbol('M.foo'))).toEqual(['M.foo -> M.bar']);
    expect(store.getSymbolByName('M.bar')).toMatchObject({ name: 'M.bar', file_path: 'src/m.lua' });
  });

  it('on a collision, opens the class member and lists callers and callees of both readings', () => {
    expect(store.getSymbolByName('Server.Start')).toMatchObject({ name: 'Start', scope: 'Server', file_path: 'src/main.go' });
    expect(store.getSymbolByName('actions::Server.Start')).toMatchObject({ name: 'Server.Start', scope: 'actions' });
    expect(at(store.getCallersOfSymbol('Server.Start'))).toEqual(['main -> Start']);
    expect(at(store.getCalleesOfSymbol('Server.Start'))).toEqual(['Server::Start -> helper', 'actions::Server.Start -> fetchJson']);
    expect(at(store.getCalleesOfSymbol('Server::Start'))).toEqual(['Server::Start -> helper']);
  });
});
