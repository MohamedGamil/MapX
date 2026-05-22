import type { StoreBackend } from './store-interface.js';
import { createRequire } from 'node:module';

const dynamicRequire = createRequire(import.meta.url);

const CURRENT_SCHEMA_VERSION = 6;

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  language TEXT NOT NULL,
  git_blob_hash TEXT,
  last_scanned TEXT,
  size_bytes INTEGER DEFAULT 0,
  lines INTEGER DEFAULT 0
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
  weight REAL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_file);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_file);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

CREATE TABLE IF NOT EXISTS snapshots (
  commit_sha TEXT PRIMARY KEY,
  parent_sha TEXT,
  timestamp TEXT,
  files_added TEXT DEFAULT '[]',
  files_modified TEXT DEFAULT '[]',
  files_removed TEXT DEFAULT '[]',
  symbols_delta TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

interface Migration {
  version: number;
  description: string;
  up: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: 'Add content_hash column to files table',
    up: [
      `ALTER TABLE files ADD COLUMN content_hash TEXT`,
    ],
  },
  {
    version: 3,
    description: 'Add verifiability column to edges table',
    up: [
      `ALTER TABLE edges ADD COLUMN verifiability TEXT NOT NULL DEFAULT 'verified'`,
      `CREATE INDEX IF NOT EXISTS idx_edges_verifiability ON edges (verifiability)`,
    ],
  },
  {
    version: 4,
    description: 'Add metadata column to edges and files tables',
    up: [
      `ALTER TABLE edges ADD COLUMN metadata TEXT DEFAULT '{}'`,
      `ALTER TABLE files ADD COLUMN metadata TEXT DEFAULT '{}'`,
    ],
  },
  {
    version: 5,
    description: 'Add clusters and cluster_membership tables, namespace column in files',
    up: [
      `ALTER TABLE files ADD COLUMN namespace TEXT`,
      `CREATE TABLE IF NOT EXISTS clusters (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        source TEXT NOT NULL,
        parent_name TEXT,
        depth INTEGER DEFAULT 0,
        file_count INTEGER DEFAULT 0,
        UNIQUE(repo, name)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_clusters_repo ON clusters(repo)`,
      `CREATE INDEX IF NOT EXISTS idx_clusters_parent ON clusters(parent_name)`,
      `CREATE TABLE IF NOT EXISTS cluster_membership (
        file_path    TEXT NOT NULL,
        cluster_name TEXT NOT NULL,
        repo         TEXT NOT NULL,
        is_primary   INTEGER DEFAULT 1,
        PRIMARY KEY (file_path, cluster_name, repo)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_membership_file ON cluster_membership(file_path)`,
      `CREATE INDEX IF NOT EXISTS idx_membership_cluster ON cluster_membership(cluster_name)`,
    ],
  },
  {
    version: 6,
    description: 'Add target_repo column to edges table',
    up: [
      `ALTER TABLE edges ADD COLUMN target_repo TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_edges_target_repo ON edges(target_repo)`,
    ],
  },
];

function createStoreBackend(dbPath: string): StoreBackend {
  const isBun = typeof (globalThis as any).Bun !== 'undefined';
  if (isBun) {
    const { BunStore } = dynamicRequire('./store-bun.js');
    return new BunStore(dbPath);
  }
  const { NodeStore } = dynamicRequire('./store-node.js');
  return new NodeStore(dbPath);
}

export class Store {
  private backend: StoreBackend;

  constructor(dbPath: string) {
    this.backend = createStoreBackend(dbPath);
    this.backend.exec(INITIAL_SCHEMA);
    this.runMigrations();
  }

  private runMigrations(): void {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion >= CURRENT_SCHEMA_VERSION) return;

    const pending = MIGRATIONS.filter(m => m.version > currentVersion);
    if (pending.length === 0) {
      this.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION));
      return;
    }

    this.backend.inTransaction(() => {
      for (const migration of pending) {
        for (const sql of migration.up) {
          this.backend.exec(sql);
        }
        this.setMeta('schema_version', String(migration.version));
      }
    });
  }

  private getSchemaVersion(): number {
    try {
      const version = this.getMeta('schema_version');
      if (version !== null) return parseInt(version, 10) || 0;
    } catch {}

    const hasContentHash = this.columnExists('files', 'content_hash');
    if (hasContentHash) {
      this.setMeta('schema_version', '2');
      return 2;
    }

    return 1;
  }

  private columnExists(table: string, column: string): boolean {
    try {
      const rows = this.backend.prepare(`PRAGMA table_info(${table})`).all();
      return rows.some((row: any) => row.name === column);
    } catch {
      return false;
    }
  }

  get raw(): StoreBackend {
    return this.backend;
  }

  setMeta(key: string, value: string): void {
    this.backend.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
    ).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.backend.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? (row.value as string) : null;
  }

  upsertFile(file: {
    path: string;
    repo: string;
    language: string;
    gitBlobHash: string | null;
    contentHash: string | null;
    lastScanned: string;
    sizeBytes: number;
    lines: number;
    metadata?: Record<string, any>;
    namespace?: string | null;
  }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO files (path, repo, language, git_blob_hash, content_hash, last_scanned, size_bytes, lines, metadata, namespace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      file.path,
      file.repo,
      file.language,
      file.gitBlobHash,
      file.contentHash,
      file.lastScanned,
      file.sizeBytes,
      file.lines,
      file.metadata ? JSON.stringify(file.metadata) : '{}',
      file.namespace ?? null
    );
  }

  updateFileMetadata(filePath: string, metadata: Record<string, any>): void {
    const file = this.getFile(filePath);
    let merged = { ...metadata };
    if (file && file.metadata) {
      try {
        merged = { ...JSON.parse(file.metadata as string), ...metadata };
      } catch {}
    }
    const namespace = metadata.namespace || null;
    if (namespace) {
      this.backend.prepare('UPDATE files SET metadata = ?, namespace = ? WHERE path = ?').run(JSON.stringify(merged), namespace, filePath);
    } else {
      this.backend.prepare('UPDATE files SET metadata = ? WHERE path = ?').run(JSON.stringify(merged), filePath);
    }
  }

  deleteFile(filePath: string): void {
    this.backend.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    this.backend.prepare('DELETE FROM edges WHERE source_file = ? OR target_file = ?').run(filePath, filePath);
    this.backend.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  getFile(filePath: string): Record<string, unknown> | undefined {
    return this.backend.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
  }

  getAllFiles(repo?: string): Record<string, unknown>[] {
    if (repo) {
      return this.backend.prepare('SELECT * FROM files WHERE repo = ?').all(repo);
    }
    return this.backend.prepare('SELECT * FROM files').all();
  }

  insertSymbol(sym: {
    filePath: string;
    repo: string;
    name: string;
    kind: string;
    scope: string | null;
    signature: string;
    startLine: number;
    endLine: number;
    metadata: string;
  }): void {
    this.backend.prepare(`
      INSERT INTO symbols (file_path, repo, name, kind, scope, signature, start_line, end_line, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sym.filePath, sym.repo, sym.name, sym.kind, sym.scope, sym.signature, sym.startLine, sym.endLine, sym.metadata);
  }

  deleteSymbolsForFile(filePath: string): void {
    this.backend.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
  }

  searchSymbols(namePattern: string, repo?: string): Record<string, unknown>[] {
    if (repo) {
      return this.backend.prepare(
        'SELECT * FROM symbols WHERE name LIKE ? AND repo = ? ORDER BY kind, name'
      ).all(`%${namePattern}%`, repo);
    }
    return this.backend.prepare(
      'SELECT * FROM symbols WHERE name LIKE ? ORDER BY kind, name'
    ).all(`%${namePattern}%`);
  }

  getSymbolsForFile(filePath: string): Record<string, unknown>[] {
    return this.backend.prepare(
      'SELECT * FROM symbols WHERE file_path = ? ORDER BY start_line'
    ).all(filePath);
  }

  getAllSymbols(repo?: string): Record<string, unknown>[] {
    if (repo) {
      return this.backend.prepare('SELECT * FROM symbols WHERE repo = ? ORDER BY file_path, start_line').all(repo);
    }
    return this.backend.prepare('SELECT * FROM symbols ORDER BY file_path, start_line').all();
  }

  insertEdge(edge: {
    sourceFile: string;
    targetFile: string;
    sourceSymbol: string | null;
    targetSymbol: string | null;
    edgeType: string;
    repo: string;
    weight: number;
    verifiability?: 'verified' | 'inferred';
    metadata?: Record<string, any>;
    targetRepo?: string | null;
  }): void {
    this.backend.prepare(`
      INSERT INTO edges (source_file, target_file, source_symbol, target_symbol, edge_type, repo, weight, verifiability, metadata, target_repo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.sourceFile,
      edge.targetFile,
      edge.sourceSymbol,
      edge.targetSymbol,
      edge.edgeType,
      edge.repo,
      edge.weight,
      edge.verifiability ?? 'verified',
      edge.metadata ? JSON.stringify(edge.metadata) : '{}',
      edge.targetRepo ?? null
    );
  }

  deleteEdgesForFile(filePath: string): void {
    this.backend.prepare('DELETE FROM edges WHERE source_file = ?').run(filePath);
  }

  getEdgesForFile(filePath: string): Record<string, unknown>[] {
    return this.backend.prepare(
      'SELECT * FROM edges WHERE source_file = ? ORDER BY edge_type'
    ).all(filePath);
  }

  getReverseEdges(filePath: string): Record<string, unknown>[] {
    return this.backend.prepare(
      'SELECT * FROM edges WHERE target_file = ? ORDER BY edge_type'
    ).all(filePath);
  }

  getAllEdges(repo?: string): Record<string, unknown>[] {
    if (repo) {
      return this.backend.prepare('SELECT * FROM edges WHERE repo = ?').all(repo);
    }
    return this.backend.prepare('SELECT * FROM edges').all();
  }

  queryEdges(options: { type?: string; from?: string; to?: string; repo?: string }): Record<string, unknown>[] {
    let sql = 'SELECT * FROM edges WHERE 1=1';
    const params: string[] = [];

    if (options.repo) {
      sql += ' AND repo = ?';
      params.push(options.repo);
    }
    if (options.type) {
      sql += ' AND edge_type = ?';
      params.push(options.type);
    }
    if (options.from) {
      sql += ' AND source_file LIKE ?';
      params.push(`%${options.from}%`);
    }
    if (options.to) {
      sql += ' AND target_file LIKE ?';
      params.push(`%${options.to}%`);
    }

    return this.backend.prepare(sql).all(...params);
  }

  getFileCount(repo?: string): number {
    const row = repo
      ? this.backend.prepare('SELECT COUNT(*) as cnt FROM files WHERE repo = ?').get(repo)
      : this.backend.prepare('SELECT COUNT(*) as cnt FROM files').get();
    return row ? (row.cnt as number) : 0;
  }

  getSymbolCount(repo?: string): number {
    const row = repo
      ? this.backend.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE repo = ?').get(repo)
      : this.backend.prepare('SELECT COUNT(*) as cnt FROM symbols').get();
    return row ? (row.cnt as number) : 0;
  }

  getEdgeCount(repo?: string): number {
    const row = repo
      ? this.backend.prepare('SELECT COUNT(*) as cnt FROM edges WHERE repo = ?').get(repo)
      : this.backend.prepare('SELECT COUNT(*) as cnt FROM edges').get();
    return row ? (row.cnt as number) : 0;
  }

  getLanguageBreakdown(repo?: string): Record<string, number> {
    const rows = repo
      ? this.backend.prepare('SELECT language, COUNT(*) as cnt FROM files WHERE repo = ? GROUP BY language').all(repo)
      : this.backend.prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language').all();
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.language as string] = row.cnt as number;
    }
    return result;
  }

  upsertSnapshot(snap: {
    commitSha: string;
    parentSha: string | null;
    timestamp: string;
    filesAdded: string;
    filesModified: string;
    filesRemoved: string;
    symbolsDelta: string;
  }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO snapshots (commit_sha, parent_sha, timestamp, files_added, files_modified, files_removed, symbols_delta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(snap.commitSha, snap.parentSha, snap.timestamp, snap.filesAdded, snap.filesModified, snap.filesRemoved, snap.symbolsDelta);
  }

  getLatestSnapshot(): Record<string, unknown> | undefined {
    return this.backend.prepare('SELECT * FROM snapshots ORDER BY timestamp DESC LIMIT 1').get();
  }

  clearClusters(repo: string): void {
    this.backend.prepare('DELETE FROM cluster_membership WHERE repo = ?').run(repo);
    this.backend.prepare('DELETE FROM clusters WHERE repo = ?').run(repo);
  }

  insertCluster(cluster: {
    repo: string;
    name: string;
    label: string;
    source: string;
    parentName: string | null;
    depth: number;
    fileCount: number;
  }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO clusters (repo, name, label, source, parent_name, depth, file_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      cluster.repo,
      cluster.name,
      cluster.label,
      cluster.source,
      cluster.parentName,
      cluster.depth,
      cluster.fileCount
    );
  }

  insertClusterMembership(membership: {
    filePath: string;
    clusterName: string;
    repo: string;
    isPrimary: number;
  }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO cluster_membership (file_path, cluster_name, repo, is_primary)
      VALUES (?, ?, ?, ?)
    `).run(
      membership.filePath,
      membership.clusterName,
      membership.repo,
      membership.isPrimary
    );
  }

  getClusters(repo?: string): Record<string, unknown>[] {
    if (repo) {
      return this.backend.prepare('SELECT * FROM clusters WHERE repo = ?').all(repo);
    }
    return this.backend.prepare('SELECT * FROM clusters').all();
  }

  getClusterMemberships(repo?: string): Record<string, unknown>[] {
    if (repo) {
      return this.backend.prepare('SELECT * FROM cluster_membership WHERE repo = ?').all(repo);
    }
    return this.backend.prepare('SELECT * FROM cluster_membership').all();
  }

  getClusterFiles(clusterName: string, repo: string): string[] {
    const rows = this.backend.prepare(`
      SELECT file_path FROM cluster_membership
      WHERE cluster_name = ? AND repo = ? AND is_primary = 1
    `).all(clusterName, repo);
    return rows.map((row: any) => row.file_path as string);
  }

  getClusterEdges(clusterName: string, repo: string): {
    sourceCluster: string;
    targetCluster: string;
    edgeCount: number;
    dominantType: string;
  }[] {
    const rows = this.backend.prepare(`
      SELECT 
        src_cm.cluster_name AS sourceCluster,
        tgt_cm.cluster_name AS targetCluster,
        COUNT(*) AS edgeCount,
        edge_type AS dominantType
      FROM edges e
      JOIN cluster_membership src_cm ON e.source_file = src_cm.file_path AND src_cm.is_primary = 1 AND src_cm.repo = e.repo
      JOIN cluster_membership tgt_cm ON e.target_file = tgt_cm.file_path AND tgt_cm.is_primary = 1 AND tgt_cm.repo = e.repo
      WHERE e.repo = ? AND (src_cm.cluster_name = ? OR tgt_cm.cluster_name = ?) AND src_cm.cluster_name != tgt_cm.cluster_name
      GROUP BY src_cm.cluster_name, tgt_cm.cluster_name, e.edge_type
    `).all(repo, clusterName, clusterName);

    const grouped = new Map<string, { sourceCluster: string; targetCluster: string; edgeCount: number; types: Record<string, number> }>();
    for (const r of rows as any[]) {
      const key = `${r.sourceCluster}->${r.targetCluster}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          sourceCluster: r.sourceCluster,
          targetCluster: r.targetCluster,
          edgeCount: 0,
          types: {},
        });
      }
      const entry = grouped.get(key)!;
      entry.edgeCount += r.edgeCount;
      entry.types[r.dominantType] = (entry.types[r.dominantType] || 0) + r.edgeCount;
    }

    return Array.from(grouped.values()).map(g => {
      let dominantType = '';
      let maxCount = -1;
      for (const [t, c] of Object.entries(g.types)) {
        if (c > maxCount) {
          maxCount = c;
          dominantType = t;
        }
      }
      return {
        sourceCluster: g.sourceCluster,
        targetCluster: g.targetCluster,
        edgeCount: g.edgeCount,
        dominantType,
      };
    });
  }

  deleteRepo(repoName: string): void {
    this.inTransaction(() => {
      this.backend.prepare('DELETE FROM symbols WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM edges WHERE repo = ? OR target_repo = ?').run(repoName, repoName);
      this.backend.prepare('DELETE FROM files WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM meta WHERE key LIKE ? OR key LIKE ?').run(`last_scan_commit:${repoName}`, `last_scan_time:${repoName}`);
    });
  }

  inTransaction<T>(fn: () => T): T {
    return this.backend.inTransaction(fn);
  }

  close(): void {
    this.backend.close();
  }
}
