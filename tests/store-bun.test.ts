import { vi, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

const mockBunDb = class {
  db: any;
  constructor(dbPath: string) {
    this.db = new Database(':memory:');
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  transaction(fn: any) {
    return this.db.transaction(fn);
  }
  close() {
    this.db.close();
  }
};

vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return {
    ...original,
    createRequire: (url: string) => {
      return (id: string) => {
        if (id === 'bun:sqlite') {
          return { Database: mockBunDb };
        }
        const req = original.createRequire(url);
        return req(id);
      };
    }
  };
});

import { BunStore } from '../src/core/store-bun.js';

describe('BunStore backend', () => {
  it('performs basic sqlite operations using the bun:sqlite interface wrapper', () => {
    const store = new BunStore(':memory:');
    
    store.exec(`
      CREATE TABLE test (
        id INTEGER PRIMARY KEY,
        val TEXT
      )
    `);

    const insert = store.prepare('INSERT INTO test (val) VALUES (?)');
    insert.run('hello');

    const select = store.prepare('SELECT * FROM test WHERE val = ?');
    const row = select.get('hello');
    expect(row).toBeDefined();
    expect(row?.val).toBe('hello');

    const allRows = store.prepare('SELECT * FROM test').all();
    expect(allRows).toHaveLength(1);

    const result = store.inTransaction(() => {
      store.prepare('INSERT INTO test (val) VALUES (?)').run('world');
      return store.prepare('SELECT COUNT(*) as count FROM test').get()?.count;
    });
    expect(result).toBe(2);

    expect(() => store.close()).not.toThrow();
  });
});
