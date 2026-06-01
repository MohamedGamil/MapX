import { createRequire } from 'node:module';
import type { StoreBackend, PreparedStmt } from './store-interface.js';

const _require = createRequire(import.meta.url);

export class NodeStore implements StoreBackend {
  private db: any;
  private stmtCache = new Map<string, PreparedStmt>();

  constructor(dbPath: string) {
    const Database = _require('better-sqlite3');
    this.db = new Database(dbPath);
    this.pragma('journal_mode = WAL');
    this.pragma('busy_timeout = 5000');
    this.pragma('foreign_keys = ON');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStmt {
    let cached = this.stmtCache.get(sql);
    if (!cached) {
      const stmt = this.db.prepare(sql);
      cached = {
        run: (...args: unknown[]) => stmt.run(...args),
        get: (...args: unknown[]) => stmt.get(...args) as Record<string, unknown> | undefined,
        all: (...args: unknown[]) => stmt.all(...args) as Record<string, unknown>[],
      };
      this.stmtCache.set(sql, cached);
    }
    return cached;
  }

  pragma(pragma: string): void {
    this.db.pragma(pragma);
  }

  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }
}
