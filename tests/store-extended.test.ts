import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { globToLike, isGlobPattern, isWildcard } from '../src/core/fuzzy-matcher.js';

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
      if (opts.pathPrefix) { sql += ' AND path LIKE ?'; params.push(`${opts.pathPrefix}%`); }
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
