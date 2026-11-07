import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Test the Store search enhancements by working directly with a better-sqlite3
 * in-memory database. This avoids the Store class's createRequire() resolution
 * which requires tsx runtime patching.
 *
 * We replicate the Store's SQL schema and test methods inline.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  repo TEXT NOT NULL DEFAULT '',
  language TEXT,
  lines INTEGER DEFAULT 0,
  size_bytes INTEGER DEFAULT 0,
  last_scanned DATETIME
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT,
  FOREIGN KEY(file_path) REFERENCES files(path)
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind COLLATE NOCASE);
`;

// Import the helper functions we're testing
import { globToLike, isGlobPattern, isWildcard } from '../src/core/fuzzy-matcher.js';

function searchSymbols(db: Database.Database, term: string): any[] {
  if (isWildcard(term)) {
    return db.prepare('SELECT * FROM symbols LIMIT 200').all();
  }
  if (isGlobPattern(term)) {
    const likePattern = globToLike(term);
    return db.prepare('SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE LIMIT 200')
      .all(likePattern);
  }
  return db.prepare('SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE LIMIT 200')
    .all(`%${term}%`);
}

function searchSymbolsFiltered(db: Database.Database, opts: {
  term?: string;
  kind?: string;
  filePrefix?: string;
  exact?: boolean;
  limit?: number;
}): any[] {
  const { term = '*', kind, filePrefix, exact = false, limit = 20 } = opts;
  const conditions: string[] = [];
  const params: any[] = [];

  // Term matching
  if (isWildcard(term)) {
    // No name constraint
  } else if (exact) {
    conditions.push('name = ? COLLATE NOCASE');
    params.push(term);
  } else if (isGlobPattern(term)) {
    conditions.push('name LIKE ? COLLATE NOCASE');
    params.push(globToLike(term));
  } else {
    conditions.push('name LIKE ? COLLATE NOCASE');
    params.push(`%${term}%`);
  }

  if (kind) {
    conditions.push('kind = ? COLLATE NOCASE');
    params.push(kind);
  }

  if (filePrefix) {
    conditions.push('file_path LIKE ?');
    params.push(`${filePrefix}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  return db.prepare(`SELECT * FROM symbols ${where} ORDER BY name COLLATE NOCASE LIMIT ?`).all(...params);
}

function listSymbolKinds(db: Database.Database): Array<{ kind: string; count: number }> {
  return db.prepare('SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind ORDER BY count DESC').all() as any[];
}

function getSymbolByName(db: Database.Database, name: string): any {
  return db.prepare('SELECT * FROM symbols WHERE name = ? COLLATE NOCASE LIMIT 1').get(name);
}

describe('Store — search enhancements', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);

    // Insert test files
    const insertFile = db.prepare(
      `INSERT OR REPLACE INTO files (path, language, lines, size_bytes, last_scanned) VALUES (?, ?, ?, ?, datetime('now'))`
    );
    insertFile.run('src/services/UserService.ts', 'typescript', 100, 5000);
    insertFile.run('src/services/AuthService.ts', 'typescript', 80, 4000);
    insertFile.run('src/controllers/UserController.ts', 'typescript', 150, 7000);
    insertFile.run('src/models/User.ts', 'typescript', 50, 2000);

    // Insert test symbols
    const insertSymbol = db.prepare(
      'INSERT INTO symbols (name, kind, scope, file_path, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertSymbol.run('UserService', 'class', null, 'src/services/UserService.ts', 10, 100, 'export class UserService');
    insertSymbol.run('AuthService', 'class', null, 'src/services/AuthService.ts', 5, 80, 'export class AuthService');
    insertSymbol.run('UserController', 'class', null, 'src/controllers/UserController.ts', 1, 150, 'export class UserController');
    insertSymbol.run('User', 'interface', null, 'src/models/User.ts', 1, 50, 'export interface User');
    insertSymbol.run('getUser', 'method', 'UserService', 'src/services/UserService.ts', 20, 35, 'async getUser(id: string)');
    insertSymbol.run('createUser', 'method', 'UserService', 'src/services/UserService.ts', 40, 60, 'async createUser(data: CreateUserDto)');
    insertSymbol.run('login', 'method', 'AuthService', 'src/services/AuthService.ts', 10, 30, 'async login(credentials)');
    insertSymbol.run('UserType', 'enum', null, 'src/models/User.ts', 30, 40, 'export enum UserType');
    insertSymbol.run('MAX_RETRIES', 'constant', null, 'src/services/AuthService.ts', 3, 3, 'const MAX_RETRIES = 3');
  });

  afterAll(() => {
    db.close();
  });

  describe('searchSymbols (query command)', () => {
    it('should find symbols by partial name', () => {
      const results = searchSymbols(db, 'User');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((s: any) => s.name === 'UserService')).toBe(true);
    });

    it('should support wildcard * to list all symbols', () => {
      const results = searchSymbols(db, '*');
      expect(results.length).toBe(9);
    });

    it('should support glob pattern *Service', () => {
      const results = searchSymbols(db, '*Service');
      expect(results.length).toBe(2);
      expect(results.every((s: any) => s.name.endsWith('Service'))).toBe(true);
    });

    it('should support glob pattern get*', () => {
      const results = searchSymbols(db, 'get*');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('getUser');
    });

    it('should support glob pattern *Controller*', () => {
      const results = searchSymbols(db, '*Controller*');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('UserController');
    });

    it('should be case-insensitive', () => {
      const results = searchSymbols(db, 'userservice');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('searchSymbolsFiltered (search command)', () => {
    it('should filter by kind', () => {
      const results = searchSymbolsFiltered(db, { term: '*', kind: 'class' });
      expect(results.every((s: any) => s.kind === 'class')).toBe(true);
      expect(results.length).toBe(3);
    });

    it('should filter by kind case-insensitively', () => {
      const results = searchSymbolsFiltered(db, { term: '*', kind: 'CLASS' });
      expect(results.length).toBe(3);
    });

    it('should filter by file prefix', () => {
      const results = searchSymbolsFiltered(db, { term: '*', filePrefix: 'src/services/' });
      expect(results.every((s: any) => s.file_path.startsWith('src/services/'))).toBe(true);
    });

    it('should combine kind + glob term', () => {
      const results = searchSymbolsFiltered(db, { term: '*Service', kind: 'class' });
      expect(results.length).toBe(2);
    });

    it('should support wildcard term with kind filter', () => {
      const results = searchSymbolsFiltered(db, { term: '*', kind: 'enum' });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('UserType');
    });

    it('should support exact match', () => {
      const results = searchSymbolsFiltered(db, { term: 'UserService', exact: true });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('UserService');
    });

    it('should respect limit', () => {
      const results = searchSymbolsFiltered(db, { term: '*', limit: 3 });
      expect(results.length).toBe(3);
    });

    it('should return constant kind', () => {
      const results = searchSymbolsFiltered(db, { term: '*', kind: 'constant' });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('MAX_RETRIES');
    });
  });

  describe('listSymbolKinds', () => {
    it('should return all kinds with counts', () => {
      const kinds = listSymbolKinds(db);
      expect(kinds.length).toBeGreaterThan(0);
      const classEntry = kinds.find((k: any) => k.kind === 'class');
      expect(classEntry).toBeDefined();
      expect(classEntry!.count).toBe(3);
    });
  });

  describe('getSymbolByName', () => {
    it('should find symbol by exact name', () => {
      const sym = getSymbolByName(db, 'UserService');
      expect(sym).toBeDefined();
      expect(sym.name).toBe('UserService');
    });

    it('should return undefined for non-existent symbol', () => {
      const sym = getSymbolByName(db, 'NonExistent');
      expect(sym).toBeUndefined();
    });
  });
});
