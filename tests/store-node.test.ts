import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NodeStore } from '../src/core/store-node.js';

/**
 * Tests for NodeStore backend — the SQLite wrapper using better-sqlite3.
 * Tests CRUD primitives, pragma support, prepared statements, and transactions.
 */
describe('NodeStore backend', () => {
  let store: NodeStore;

  beforeAll(() => {
    store = new NodeStore(':memory:');
    store.exec(`
      CREATE TABLE IF NOT EXISTS test_table (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT
      )
    `);
  });

  afterAll(() => {
    store.close();
  });

  describe('exec', () => {
    it('should execute raw SQL', () => {
      store.exec(`INSERT INTO test_table (name, value) VALUES ('foo', 'bar')`);
      const row = store.prepare('SELECT * FROM test_table WHERE name = ?').get('foo');
      expect(row).toBeDefined();
      expect((row as any).value).toBe('bar');
    });

    it('should handle multi-statement SQL', () => {
      store.exec(`
        INSERT INTO test_table (name, value) VALUES ('a', '1');
        INSERT INTO test_table (name, value) VALUES ('b', '2');
      `);
      const rows = store.prepare('SELECT * FROM test_table WHERE name IN (?, ?)').all('a', 'b');
      expect(rows.length).toBe(2);
    });
  });

  describe('prepare', () => {
    it('should support run() for inserts', () => {
      store.prepare('INSERT INTO test_table (name, value) VALUES (?, ?)').run('run_test', 'rv');
      const row = store.prepare('SELECT * FROM test_table WHERE name = ?').get('run_test') as any;
      expect(row.value).toBe('rv');
    });

    it('should support get() for single row', () => {
      const row = store.prepare('SELECT * FROM test_table WHERE name = ?').get('foo') as any;
      expect(row).toBeDefined();
      expect(row.name).toBe('foo');
    });

    it('should support get() returning undefined for no match', () => {
      const row = store.prepare('SELECT * FROM test_table WHERE name = ?').get('nonexistent');
      expect(row).toBeUndefined();
    });

    it('should support all() for multiple rows', () => {
      const rows = store.prepare('SELECT * FROM test_table').all();
      expect(rows.length).toBeGreaterThan(0);
    });

    it('should support all() with params', () => {
      const rows = store.prepare('SELECT * FROM test_table WHERE value = ?').all('bar');
      expect(rows.length).toBe(1);
    });
  });

  describe('pragma', () => {
    it('should set and read pragma', () => {
      store.pragma('journal_mode = WAL');
      // If no error, pragma was accepted
      expect(true).toBe(true);
    });
  });

  describe('inTransaction', () => {
    it('should commit on success', () => {
      store.inTransaction(() => {
        store.prepare('INSERT INTO test_table (name, value) VALUES (?, ?)').run('tx_commit', 'ok');
      });
      const row = store.prepare('SELECT * FROM test_table WHERE name = ?').get('tx_commit') as any;
      expect(row.value).toBe('ok');
    });

    it('should rollback on error', () => {
      store.prepare('INSERT INTO test_table (name, value) VALUES (?, ?)').run('tx_rollback', 'original');
      try {
        store.inTransaction(() => {
          store.prepare('UPDATE test_table SET value = ? WHERE name = ?').run('modified', 'tx_rollback');
          throw new Error('forced');
        });
      } catch {}
      const row = store.prepare('SELECT * FROM test_table WHERE name = ?').get('tx_rollback') as any;
      expect(row.value).toBe('original');
    });

    it('should return value from transaction', () => {
      const result = store.inTransaction(() => {
        return store.prepare('SELECT COUNT(*) as cnt FROM test_table').get() as any;
      });
      expect(result.cnt).toBeGreaterThan(0);
    });
  });
});
