import { createRequire } from 'node:module';
import type { StoreBackend, PreparedStmt } from './store-interface.js';

const _require = createRequire(import.meta.url);

export class BunStore implements StoreBackend {
  private db: any;

  constructor(dbPath: string) {
    const { Database } = _require('bun:sqlite');
    this.db = new Database(dbPath, { create: true });
    this.pragma('journal_mode = WAL');
    this.pragma('busy_timeout = 5000');
    this.pragma('foreign_keys = ON');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStmt {
    const stmt = this.db.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => stmt.get(...args) as Record<string, unknown> | undefined,
      all: (...args: unknown[]) => stmt.all(...args) as Record<string, unknown>[],
    };
  }

  pragma(pragma: string): void {
    this.db.exec(`PRAGMA ${pragma}`);
  }

  inTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  close(): void {
    this.db.close();
  }
}
