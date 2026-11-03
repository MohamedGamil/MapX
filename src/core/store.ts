import type { StoreBackend } from './store-interface.js';
import type { MapxGraph } from './graph.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globToLike, isGlobPattern, isWildcard as isWildcardTerm } from './fuzzy-matcher.js';
import { BunStore } from './store-bun.js';
import { NodeStore } from './store-node.js';
import type { ExternalRefRow } from './external-refs.js';

/** A stored external-reference candidate with its decision (M5-19) and attribution (M5-20); 0/1 for booleans. */
export interface ExternalCandidate {
  id: number;
  file_path: string;
  specifier: string;
  /** The name used from the specifier (M5-22: `from google.cloud import storage` names `google.cloud.storage`). */
  symbol: string | null;
  ecosystem: string;
  external: number;
  metadata: string | null;
  package: string | null;
  origin: string | null;
  direct: number | null;
  dev: number | null;
  attribution: string | null;
}

/** A candidate's decision as the end of a run writes it. */
export type ExternalDecision = Omit<ExternalCandidate, 'file_path' | 'specifier' | 'symbol' | 'ecosystem' | 'metadata'>;

const CURRENT_SCHEMA_VERSION = 10;

function parseSearchPattern(pattern: string): { scopeLike: string | null; namePattern: string } {
  const commonExtensions = new Set([
    'ts', 'js', 'cs', 'java', 'py', 'php', 'go', 'rs', 'swift', 'kt', 
    'svelte', 'vue', 'lua', 'ex', 'zig', 'sh', 'pas', 'scala', 'rb', 
    'c', 'cpp', 'h', 'hpp', 'json', 'yaml', 'yml', 'md'
  ]);

  if (pattern.includes('::')) {
    const parts = pattern.split('::');
    const namePart = parts.pop()!;
    const scopePart = parts.join('::');
    const scopeLike = isWildcardTerm(scopePart) ? '%' : (isGlobPattern(scopePart) ? globToLike(scopePart) : `%${scopePart}%`);
    return { scopeLike, namePattern: namePart };
  }

  if (pattern.includes('.')) {
    const parts = pattern.split('.');
    const last = parts[parts.length - 1].toLowerCase();
    if (!commonExtensions.has(last)) {
      const namePart = parts.pop()!;
      const scopePart = parts.join('.');
      const scopeLike = isWildcardTerm(scopePart) ? '%' : (isGlobPattern(scopePart) ? globToLike(scopePart) : `%${scopePart}%`);
      return { scopeLike, namePattern: namePart };
    }
  }

  return { scopeLike: null, namePattern: pattern };
}

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
  {
    version: 7,
    description: 'Add layer column to clusters table for architectural layer assignments',
    up: [
      `ALTER TABLE clusters ADD COLUMN layer TEXT DEFAULT 'other'`,
    ],
  },
  {
    version: 8,
    description: 'Add codebase classification role columns, classification_signals, cluster_metrics, and arch_smells tables',
    up: [
      `ALTER TABLE files ADD COLUMN role TEXT DEFAULT 'other'`,
      `ALTER TABLE files ADD COLUMN role_confidence REAL DEFAULT 0.0`,
      `CREATE TABLE IF NOT EXISTS classification_signals (
        file_path TEXT NOT NULL,
        repo TEXT NOT NULL,
        source TEXT NOT NULL,
        role TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (file_path, repo, source)
      )`,
      `CREATE TABLE IF NOT EXISTS cluster_metrics (
        cluster_name TEXT NOT NULL,
        repo TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        afferent_coupling REAL NOT NULL,
        efferent_coupling REAL NOT NULL,
        instability REAL NOT NULL,
        internal_edges INTEGER NOT NULL,
        external_edges INTEGER NOT NULL,
        cohesion_ratio REAL NOT NULL,
        abstractness REAL NOT NULL,
        distance_from_main_seq REAL NOT NULL,
        PRIMARY KEY (cluster_name, repo)
      )`,
      `CREATE TABLE IF NOT EXISTS arch_smells (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        involved_files TEXT NOT NULL,
        involved_clusters TEXT NOT NULL,
        suggestion TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_arch_smells_repo ON arch_smells(repo)`,
    ],
  },
  {
    version: 9,
    description: 'Add pagerank column to files table',
    up: [
      `ALTER TABLE files ADD COLUMN pagerank REAL DEFAULT 0.0`,
      `CREATE INDEX IF NOT EXISTS idx_files_pagerank ON files(pagerank)`
    ]
  },
  {
    version: 10,
    description: 'Add external references: the candidates table and the external_refs view of those decided external (M5-19)',
    up: [
      // Never edges: edge counts, metrics and PageRank ignore them (docs/research/deptrac/03 §4).
      // Every reference that gave no edge and may name something outside the workspace is a
      // candidate; `external` is decided against the workspace as it stands, again at the end of
      // every scan and sync, since other files decide it (review of M5-19). `package` …
      // `attribution` are filled by the per-ecosystem attribution (M5-20 … M5-23).
      `CREATE TABLE IF NOT EXISTS external_ref_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        repo TEXT NOT NULL,
        line INTEGER NOT NULL,
        source_symbol TEXT,
        specifier TEXT NOT NULL,
        symbol TEXT,
        kind TEXT NOT NULL,
        ecosystem TEXT NOT NULL,
        external INTEGER NOT NULL DEFAULT 0,
        package TEXT,
        origin TEXT,
        direct INTEGER,
        dev INTEGER,
        attribution TEXT,
        metadata TEXT DEFAULT '{}'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_external_ref_candidates_file ON external_ref_candidates(file_path)`,
      `CREATE INDEX IF NOT EXISTS idx_external_ref_candidates_repo ON external_ref_candidates(repo)`,
      `CREATE INDEX IF NOT EXISTS idx_external_ref_candidates_specifier ON external_ref_candidates(specifier)`,
      `CREATE VIEW IF NOT EXISTS external_refs AS
        SELECT id, file_path, repo, line, source_symbol, specifier, symbol, kind, ecosystem,
               package, origin, direct, dev, attribution, metadata
        FROM external_ref_candidates WHERE external = 1`,
    ]
  }
];

function createStoreBackend(dbPath: string): StoreBackend {
  const isBun = typeof (globalThis as any).Bun !== 'undefined';
  if (isBun) {
    return new BunStore(dbPath);
  }
  return new NodeStore(dbPath);
}

export class Store {
  private backend: StoreBackend;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const parentDir = path.dirname(dbPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    }
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

  deleteMeta(key: string): void {
    this.backend.prepare('DELETE FROM meta WHERE key = ?').run(key);
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

  /**
   * A file's content and git blob hashes and scan time, once its parse result is written (M0-02-R10).
   * `scannedAt` is when the content was read, not when the result is written: an edit made while the
   * scan parsed stays newer than the index, so staleness and the git sync still see it (review of
   * M0-02-R12).
   */
  setFileHashes(filePath: string, contentHash: string | null, gitBlobHash: string | null, scannedAt = new Date().toISOString()): void {
    this.backend.prepare('UPDATE files SET content_hash = ?, git_blob_hash = ?, last_scanned = ? WHERE path = ?')
      .run(contentHash, gitBlobHash, scannedAt, filePath);
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
    this.backend.prepare('DELETE FROM external_ref_candidates WHERE file_path = ?').run(filePath);
    this.backend.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  /** Other files with an edge into `filePath`. */
  /** Files with an import or require edge into the file (M2-08). */
  getImporters(filePath: string): string[] {
    return this.backend.prepare("SELECT DISTINCT source_file FROM edges WHERE target_file = ? AND source_file != ? AND edge_type IN ('import', 'require')")
      .all(filePath, filePath).map(r => r.source_file as string);
  }

  /** Files whose metadata JSON contains `text` (a pre-filter; callers parse to confirm) (M2-08-R2). */
  filesWithMetadataText(text: string): Array<{ path: unknown; metadata: unknown }> {
    return this.backend.prepare("SELECT path, metadata FROM files WHERE metadata LIKE ? ESCAPE '\\'")
      .all(`%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`) as Array<{ path: unknown; metadata: unknown }>;
  }

  getReferrers(filePath: string): string[] {
    return this.backend.prepare('SELECT DISTINCT source_file FROM edges WHERE target_file = ? AND source_file != ?')
      .all(filePath, filePath).map(r => r.source_file as string);
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

  /**
   * Get files matching a path suffix pattern (e.g., 'pubspec.yaml').
   * Uses SQL LIKE for efficient filtering without loading all files.
   */
  getFilesByPattern(pathSuffix: string): Record<string, unknown>[] {
    return this.backend.prepare('SELECT * FROM files WHERE path LIKE ?').all(`%${pathSuffix}`);
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
    const { scopeLike, namePattern: term } = parseSearchPattern(namePattern);
    let likePattern: string;
    if (isWildcardTerm(term)) {
      likePattern = '%';
    } else if (isGlobPattern(term)) {
      likePattern = globToLike(term);
    } else {
      likePattern = `%${term}%`;
    }

    if (scopeLike) {
      if (repo) {
        return this.backend.prepare(
          'SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE AND scope LIKE ? COLLATE NOCASE AND repo = ? ORDER BY kind, name'
        ).all(likePattern, scopeLike, repo);
      }
      return this.backend.prepare(
        'SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE AND scope LIKE ? COLLATE NOCASE ORDER BY kind, name'
      ).all(likePattern, scopeLike);
    } else {
      if (repo) {
        return this.backend.prepare(
          'SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE AND repo = ? ORDER BY kind, name'
        ).all(likePattern, repo);
      }
      return this.backend.prepare(
        'SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE ORDER BY kind, name'
      ).all(likePattern);
    }
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

  /** A file's outgoing edges and its external-reference candidates: both come from resolving its references (M5-19). */
  deleteEdgesForFile(filePath: string): void {
    this.backend.prepare('DELETE FROM edges WHERE source_file = ?').run(filePath);
    this.backend.prepare('DELETE FROM external_ref_candidates WHERE file_path = ?').run(filePath);
  }

  /** Replaces a file's external-reference candidates (M5-19). */
  replaceExternalRefs(filePath: string, repo: string, refs: ExternalRefRow[]): void {
    this.backend.prepare('DELETE FROM external_ref_candidates WHERE file_path = ?').run(filePath);
    if (!refs.length) return;
    const insert = this.backend.prepare(
      'INSERT INTO external_ref_candidates (file_path, repo, line, source_symbol, specifier, symbol, kind, ecosystem, external, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of refs) {
      insert.run(filePath, repo, r.line, r.sourceSymbol, r.specifier, r.symbol, r.kind, r.ecosystem, r.external ? 1 : 0, r.metadata ? JSON.stringify(r.metadata) : '{}');
    }
  }

  /** Every candidate with what decides it and its decision, for the decision at the end of a scan (M5-19, M5-20). */
  getExternalCandidates(): ExternalCandidate[] {
    return this.backend.prepare(
      'SELECT id, file_path, specifier, symbol, ecosystem, external, metadata, package, origin, direct, dev, attribution FROM external_ref_candidates'
    ).all() as unknown as ExternalCandidate[];
  }

  /** Records candidates' decisions: external (0 or 1) and the attribution, by id (M5-19, M5-20). */
  setExternalDecisions(decisions: ExternalDecision[]): void {
    const update = this.backend.prepare(
      'UPDATE external_ref_candidates SET external = ?, package = ?, origin = ?, direct = ?, dev = ?, attribution = ? WHERE id = ?'
    );
    this.inTransaction(() => {
      for (const d of decisions) update.run(d.external, d.package, d.origin, d.direct, d.dev, d.attribution, d.id);
    });
  }

  /** Drops the candidates of files no longer indexed (an index an older MapX synced) (M5-19). */
  deleteOrphanExternalCandidates(): void {
    this.backend.prepare('DELETE FROM external_ref_candidates WHERE file_path NOT IN (SELECT path FROM files)').run();
  }

  /** PHP classes, interfaces, traits, enums and functions of the workspace, by lower-case qualified name (M5-19). */
  getPhpDeclaredNames(): Set<string> {
    const rows = this.backend.prepare(
      "SELECT s.name, f.namespace FROM symbols s JOIN files f ON f.path = s.file_path WHERE f.language = 'php' AND (s.scope IS NULL OR s.scope = '') AND s.kind IN ('class', 'interface', 'trait', 'enum', 'function')"
    ).all();
    return new Set(rows.map(r => (r.namespace ? `${r.namespace}\\${r.name}` : String(r.name)).toLowerCase()));
  }

  /** External references: the candidates decided external, by file and line (M5-19). */
  getExternalRefs(options: { repo?: string; file?: string } = {}): Record<string, unknown>[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.repo) { where.push('repo = ?'); params.push(options.repo); }
    if (options.file) { where.push('file_path = ?'); params.push(options.file); }
    return this.backend.prepare(
      `SELECT * FROM external_refs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY file_path, line, specifier, symbol, kind, id`
    ).all(...params);
  }

  deleteFrameworkEdgesForRepo(repoName: string): void {
    this.backend.prepare(
      "DELETE FROM edges WHERE repo = ? AND edge_type IN ('route', 'middleware', 'hook', 'graphql_resolver', 'message_handler', 'websocket_handler')"
    ).run(repoName);
  }

  deleteEdgesByType(edgeType: string): void {
    this.backend.prepare('DELETE FROM edges WHERE edge_type = ?').run(edgeType);
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

  /**
   * Edge query behind `mapx edges` and mapx_edges. `type` is a list, as an array or comma-separated
   * (M0-03-R3: an array used to throw); `file` with `direction` selects edges leaving it (outgoing),
   * reaching it (incoming) or both; `from` / `to` are substring filters (M0-03-R2).
   */
  queryEdges(options: {
    type?: string | string[];
    from?: string;
    to?: string;
    repo?: string;
    file?: string;
    direction?: 'outgoing' | 'incoming' | 'both';
    verifiedOnly?: boolean;
  }): Record<string, unknown>[] {
    let sql = 'SELECT * FROM edges WHERE 1=1';
    const params: string[] = [];

    if (options.repo) {
      sql += ' AND repo = ?';
      params.push(options.repo);
    }
    const types = [options.type ?? []].flat().flatMap(t => String(t).split(',')).map(t => t.trim()).filter(Boolean);
    if (types.length) {
      sql += ` AND edge_type IN (${types.map(() => '?').join(', ')})`;
      params.push(...types);
    }
    if (options.file) {
      const direction = options.direction ?? 'both';
      if (direction === 'outgoing') sql += ' AND source_file = ?';
      else if (direction === 'incoming') sql += ' AND target_file = ?';
      else {
        sql += ' AND (source_file = ? OR target_file = ?)';
        params.push(options.file);
      }
      params.push(options.file);
    }
    if (options.verifiedOnly) {
      sql += " AND COALESCE(verifiability, 'verified') != 'inferred'";
    }
    if (options.from) {
      sql += ' AND source_file LIKE ?';
      params.push(`%${options.from}%`);
    }
    if (options.to) {
      sql += ' AND target_file LIKE ?';
      params.push(`%${options.to}%`);
    }

    return this.backend.prepare(sql + ' ORDER BY source_file, target_file, edge_type').all(...params);
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
    layer?: string;
  }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO clusters (repo, name, label, source, parent_name, depth, file_count, layer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cluster.repo,
      cluster.name,
      cluster.label,
      cluster.source,
      cluster.parentName,
      cluster.depth,
      cluster.fileCount,
      cluster.layer ?? 'other'
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

  /**
   * Wipe all data owned by a repo in preparation for a fresh forced re-scan.
   * Unlike deleteRepo(), this intentionally preserves:
   *   - Cross-repo edges where this repo is only the TARGET (those belong to
   *     other repos' scans and will be cleaned up when those repos are re-scanned).
   *   - last_scan_commit / last_scan_time meta keys (updated once scan completes).
   */
  resetRepoForScan(repoName: string): void {
    this.inTransaction(() => {
      this.backend.prepare('DELETE FROM symbols WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM edges WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM files WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM cluster_membership WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM clusters WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM classification_signals WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM cluster_metrics WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM arch_smells WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM external_ref_candidates WHERE repo = ?').run(repoName);
    });
  }

  deleteRepo(repoName: string): void {
    this.inTransaction(() => {
      this.backend.prepare('DELETE FROM symbols WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM edges WHERE repo = ? OR target_repo = ?').run(repoName, repoName);
      this.backend.prepare('DELETE FROM files WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM classification_signals WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM cluster_metrics WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM arch_smells WHERE repo = ?').run(repoName);
      this.backend.prepare('DELETE FROM external_ref_candidates WHERE repo = ?').run(repoName);
      // Every `<kind>:<repo>` record of the repo (scan state, resume state, Vue registry, HTTP inputs, profile).
      this.backend.prepare("DELETE FROM meta WHERE substr(key, -length(?) - 1) = ':' || ?").run(repoName, repoName);
      // The other repos no longer saw this one: when it comes back it is newly visible to them, so
      // their references into it are resolved again (M0-10-R4).
      for (const row of this.backend.prepare("SELECT key, value FROM meta WHERE key LIKE 'resolution_repos:%'").all()) {
        try {
          const repos = JSON.parse(row.value as string) as string[];
          if (repos.includes(repoName)) this.setMeta(row.key as string, JSON.stringify(repos.filter(r => r !== repoName)));
        } catch { /* a malformed record is replaced by the next scan */ }
      }
    });
  }

  /** The repos with indexed files. */
  getRepoNames(): string[] {
    return this.backend.prepare('SELECT DISTINCT repo FROM files ORDER BY repo').all().map(r => r.repo as string);
  }

  searchSymbolsFiltered(options: {
    term: string;
    kind?: string;
    filePrefix?: string;
    exact?: boolean;
    limit?: number;
    offset?: number;
    repo?: string;
  }): Record<string, any>[] {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const { scopeLike, namePattern: term } = parseSearchPattern(options.term);

    let sql = 'SELECT * FROM symbols WHERE ';
    const params: any[] = [];

    const wildcard = isWildcardTerm(term);

    if (wildcard) {
      sql += '1=1';
    } else if (options.exact) {
      sql += '(name = ? COLLATE NOCASE OR file_path = ? COLLATE NOCASE)';
      params.push(term, term);
    } else if (isGlobPattern(term)) {
      const likePattern = globToLike(term);
      sql += '(name LIKE ? COLLATE NOCASE)';
      params.push(likePattern);
    } else {
      sql += '(name LIKE ? COLLATE NOCASE OR file_path LIKE ? COLLATE NOCASE)';
      params.push(`%${term}%`, `%${term}%`);
    }

    if (scopeLike) {
      sql += ' AND scope LIKE ? COLLATE NOCASE';
      params.push(scopeLike);
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

    sql += ' ORDER BY kind, name LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.backend.prepare(sql).all(...params);
  }

  countSymbolsFiltered(options: {
    term: string;
    kind?: string;
    filePrefix?: string;
    exact?: boolean;
    repo?: string;
  }): number {
    let sql = 'SELECT COUNT(*) as cnt FROM symbols WHERE ';
    const params: any[] = [];
    const { scopeLike, namePattern: term } = parseSearchPattern(options.term);

    const wildcard = isWildcardTerm(term);

    if (wildcard) {
      sql += '1=1';
    } else if (options.exact) {
      sql += '(name = ? COLLATE NOCASE OR file_path = ? COLLATE NOCASE)';
      params.push(term, term);
    } else if (isGlobPattern(term)) {
      const likePattern = globToLike(term);
      sql += '(name LIKE ? COLLATE NOCASE)';
      params.push(likePattern);
    } else {
      sql += '(name LIKE ? COLLATE NOCASE OR file_path LIKE ? COLLATE NOCASE)';
      params.push(`%${term}%`, `%${term}%`);
    }

    if (scopeLike) {
      sql += ' AND scope LIKE ? COLLATE NOCASE';
      params.push(scopeLike);
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

    const row = this.backend.prepare(sql).get(...params) as { cnt: number };
    return row?.cnt ?? 0;
  }

  /**
   * Return all distinct symbol names in the index.
   * Used by the fuzzy matcher to generate suggestions when a search fails.
   */
  getAllSymbolNames(repo?: string): string[] {
    const sql = repo
      ? 'SELECT DISTINCT name FROM symbols WHERE repo = ? ORDER BY name'
      : 'SELECT DISTINCT name FROM symbols ORDER BY name';
    const rows = repo
      ? this.backend.prepare(sql).all(repo)
      : this.backend.prepare(sql).all();
    return rows.map((r: any) => r.name as string);
  }

  /**
   * Return all symbol kinds and their counts.
   * Used to provide helpful error messages when a kind filter yields no results.
   */
  listSymbolKinds(repo?: string): { kind: string; count: number }[] {
    const sql = repo
      ? 'SELECT kind, COUNT(*) as count FROM symbols WHERE repo = ? GROUP BY kind ORDER BY count DESC'
      : 'SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind ORDER BY count DESC';
    const rows = repo
      ? this.backend.prepare(sql).all(repo)
      : this.backend.prepare(sql).all();
    return rows as { kind: string; count: number }[];
  }

  /**
   * Return a lightweight candidates list for fuzzy matching.
   * Only fetches name, kind, file_path — no full row scan.
   */
  getSymbolCandidatesForFuzzy(repo?: string): Array<{ name: string; kind: string; file_path: string }> {
    const sql = repo
      ? 'SELECT DISTINCT name, kind, file_path FROM symbols WHERE repo = ?'
      : 'SELECT DISTINCT name, kind, file_path FROM symbols';
    const rows = repo
      ? this.backend.prepare(sql).all(repo)
      : this.backend.prepare(sql).all();
    return rows as Array<{ name: string; kind: string; file_path: string }>;
  }

  /**
   * Symbols named by `fullName`: `Scope::name`, or `Scope.name` (`.` and `::` taken as the same
   * separator), matched by scope; and symbols whose own name is `fullName`, such as the string-keyed
   * member `'api.get'` (M4-26). With `one`, the scoped match is preferred and the exact name is the
   * fallback, so a lookup never loses what the scoped reading finds; without it, both are returned.
   * A name ending in a file extension is not split when a file of that path exists.
   */
  private findSymbolsByName(fullName: string, repo: string | undefined, one: boolean): Record<string, any>[] {
    const select = (first: boolean, sql: string, ...params: string[]): Record<string, any>[] => {
      if (repo) {
        sql += ' AND repo = ?';
        params.push(repo);
      }
      if (!first) return this.backend.prepare(sql).all(...params);
      const row = this.backend.prepare(`${sql} LIMIT 1`).get(...params);
      return row ? [row] : [];
    };
    const exact = () => select(one, 'SELECT * FROM symbols WHERE name = ?', fullName);

    let scope: string | null = null;
    let name = fullName;
    if (fullName.includes('::')) {
      const parts = fullName.split('::');
      name = parts.pop()!;
      scope = parts.join('::');
    } else if (fullName.includes('.')) {
      const parts = fullName.split('.');
      const last = parts[parts.length - 1].toLowerCase();
      const commonExtensions = new Set([
        'ts', 'js', 'cs', 'java', 'py', 'php', 'go', 'rs', 'swift', 'kt', 
        'svelte', 'vue', 'lua', 'ex', 'zig', 'sh', 'pas', 'scala', 'rb', 
        'c', 'cpp', 'h', 'hpp', 'json', 'yaml', 'yml', 'md'
      ]);
      // `Runner.go` is a method `go`, unless `Runner.go` is a scanned file.
      if (!commonExtensions.has(last) || !this.getFile(fullName)) {
        name = parts.pop()!;
        scope = parts.join('.');
      }
    }
    if (!scope) return exact();

    let scoped = select(one, 'SELECT * FROM symbols WHERE scope = ? AND name = ?', scope, name);
    if (scoped.length === 0) {
      // Fallback with normalized scope matching
      const candidates = select(false, 'SELECT * FROM symbols WHERE name = ?', name);
      const normScope = scope.replace(/\./g, '::');
      scoped = candidates.filter(cand => cand.scope && (cand.scope as string).replace(/\./g, '::') === normScope);
      if (one) scoped = scoped.slice(0, 1);
    }
    if (one) return scoped.length > 0 ? scoped : exact();
    const seen = new Set(scoped.map(s => s.id));
    return [...scoped, ...exact().filter(s => !seen.has(s.id))];
  }

  getSymbolByName(fullName: string, repo?: string): Record<string, any> | undefined {
    return this.findSymbolsByName(fullName, repo, true)[0];
  }

  getFilesFiltered(options: {
    pathPrefix?: string;
    lang?: string;
    sort?: 'lines' | 'path';
    limit?: number;
    repo?: string;
  }): Record<string, any>[] {
    const limit = options.limit ?? 50;
    let sql = 'SELECT * FROM files WHERE 1=1';
    const params: any[] = [];

    if (options.pathPrefix) {
      const raw = options.pathPrefix;
      // Glob pattern: convert to SQL LIKE (*, ? → %, _)
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

    if (options.lang) {
      sql += ' AND LOWER(language) = ?';
      params.push(options.lang.toLowerCase());
    }

    if (options.repo) {
      sql += ' AND repo = ?';
      params.push(options.repo);
    }

    if (options.sort === 'lines') {
      sql += ' ORDER BY lines DESC';
    } else if (options.sort === 'path') {
      sql += ' ORDER BY path ASC';
    }

    sql += ' LIMIT ?';
    params.push(limit);

    return this.backend.prepare(sql).all(...params);
  }

  getCallersOfSymbol(fullName: string, repo?: string): Record<string, any>[] {
    const symbols = this.findSymbolsByName(fullName, repo, false);
    if (symbols.length === 0) {
      return [];
    }

    const results: Record<string, any>[] = [];
    for (const sym of symbols) {
      let sql = "SELECT * FROM edges WHERE target_file = ? AND (target_symbol = ? OR target_symbol = ?) AND edge_type NOT IN ('import', 'require')";
      const params = [sym.file_path, sym.name, `${sym.scope}::${sym.name}`];
      if (repo) {
        sql += ' AND repo = ?';
        params.push(repo);
      }
      const edges = this.backend.prepare(sql).all(...params);
      results.push(...edges);
    }
    return results;
  }

  /**
   * Start line of `name` (or `Scope::name`) declared in `file`, or null when it is not declared there
   * or cannot be told apart from a homonym (M0-11-R2: the first same-named declaration used to win).
   * With several declarations of the name, the one whose scope matches `Scope::` wins; otherwise the
   * single one whose scope is in `scopeHints` (names the caller also references in that file, such as
   * the class it instantiates).
   */
  getSymbolLineInFile(file: string, name: string, scopeHints: string[] = []): number | null {
    // `A::m`, `a.b` and PHP `App\Models\User` all end in the declared name.
    const parts = name.split(/::|\.|\\/);
    const short = parts.pop() ?? name;
    const rows = this.backend
      .prepare('SELECT start_line, scope FROM symbols WHERE file_path = ? AND name = ? ORDER BY start_line')
      .all(file, short) as Array<{ start_line: number; scope: string | null }>;
    if (rows.length <= 1) return rows[0]?.start_line ?? null;
    const lastSegment = (s: string | null) => (s ?? '').split(/::|\.|\\/).pop() ?? '';
    const pick = (scopes: string[]) => {
      const wanted = new Set(scopes.map(lastSegment).filter(Boolean));
      const matches = rows.filter(r => wanted.has(lastSegment(r.scope)));
      return matches.length === 1 ? matches[0].start_line : null;
    };
    return (parts.length ? pick([parts[parts.length - 1]]) : null) ?? pick(scopeHints);
  }

  getCalleesOfSymbol(fullName: string, repo?: string): Record<string, any>[] {
    const symbols = this.findSymbolsByName(fullName, repo, false);
    if (symbols.length === 0) {
      return [];
    }

    const results: Record<string, any>[] = [];
    for (const sym of symbols) {
      let sql = 'SELECT * FROM edges WHERE source_file = ? AND (source_symbol = ? OR source_symbol = ?)';
      const params = [sym.file_path, sym.name, `${sym.scope}::${sym.name}`];
      if (repo) {
        sql += ' AND repo = ?';
        params.push(repo);
      }
      const edges = this.backend.prepare(sql).all(...params);
      results.push(...edges);
    }
    return results;
  }

  updateFilePageRank(filePath: string, pagerank: number): void {
    this.backend.prepare('UPDATE files SET pagerank = ? WHERE path = ?')
      .run(pagerank, filePath);
  }

  getTopFilesByPageRank(graph?: MapxGraph | null, limit: number = 5): any[] {
    if (graph && graph.constructor.name !== 'MapxGraph' && typeof graph.getRankedFiles === 'function') {
      return graph.getRankedFiles().slice(0, limit);
    }
    const rows = this.backend.prepare(
      'SELECT path, pagerank, language FROM files ORDER BY pagerank DESC LIMIT ?'
    ).all(limit);
    if (rows.length > 0) {
      return rows.map(r => ({
        path: r.path,
        pagerank: r.pagerank,
        language: r.language
      }));
    }
    if (graph && typeof graph.getRankedFiles === 'function') {
      return graph.getRankedFiles().slice(0, limit);
    }
    return [];
  }

  getTopSymbolsByPageRank(graph?: MapxGraph | null, limit: number = 5): any[] {
    if (graph && graph.constructor.name !== 'MapxGraph' && typeof graph.getRankedSymbols === 'function') {
      return graph.getRankedSymbols().slice(0, limit);
    }
    const rows = this.backend.prepare(`
      SELECT s.name, s.kind, s.file_path, s.start_line, s.scope,
             (f.pagerank * (1 + (CASE WHEN s.scope IS NOT NULL THEN 2 ELSE 1 END) * 0.1)) AS pagerank
      FROM symbols s
      JOIN files f ON s.file_path = f.path
      ORDER BY pagerank DESC
      LIMIT ?
    `).all(limit);
    if (rows.length > 0) {
      return rows.map(r => ({
        name: r.name,
        kind: r.kind,
        filePath: r.file_path,
        startLine: r.start_line,
        pagerank: r.pagerank,
        scope: r.scope
      }));
    }
    if (graph && typeof graph.getRankedSymbols === 'function') {
      return graph.getRankedSymbols().slice(0, limit);
    }
    return [];
  }

  updateFileRole(filePath: string, role: string, confidence: number): void {
    this.backend.prepare('UPDATE files SET role = ?, role_confidence = ? WHERE path = ?')
      .run(role, confidence, filePath);
  }

  insertClassificationSignal(signal: { filePath: string; repo: string; source: string; role: string; confidence: number; reason: string }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO classification_signals (file_path, repo, source, role, confidence, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(signal.filePath, signal.repo, signal.source, signal.role, signal.confidence, signal.reason);
  }

  getClassificationSignals(filePath: string): Record<string, any>[] {
    return this.backend.prepare('SELECT * FROM classification_signals WHERE file_path = ?').all(filePath) as any[];
  }

  deleteClassificationSignalsForFile(filePath: string): void {
    this.backend.prepare('DELETE FROM classification_signals WHERE file_path = ?').run(filePath);
  }

  insertClusterMetrics(m: {
    clusterName: string;
    repo: string;
    fileCount: number;
    afferentCoupling: number;
    efferentCoupling: number;
    instability: number;
    internalEdges: number;
    externalEdges: number;
    cohesionRatio: number;
    abstractness: number;
    distanceFromMainSeq: number;
  }): void {
    this.backend.prepare(`
      INSERT OR REPLACE INTO cluster_metrics (
        cluster_name, repo, file_count, afferent_coupling, efferent_coupling,
        instability, internal_edges, external_edges, cohesion_ratio,
        abstractness, distance_from_main_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.clusterName, m.repo, m.fileCount, m.afferentCoupling, m.efferentCoupling,
      m.instability, m.internalEdges, m.externalEdges, m.cohesionRatio,
      m.abstractness, m.distanceFromMainSeq
    );
  }

  getClusterMetrics(repo: string): Record<string, any>[] {
    return this.backend.prepare('SELECT * FROM cluster_metrics WHERE repo = ?').all(repo) as any[];
  }

  insertArchSmell(smell: {
    repo: string;
    type: string;
    severity: string;
    description: string;
    involvedFiles: string[];
    involvedClusters?: string[];
    suggestion: string;
  }): void {
    this.backend.prepare(`
      INSERT INTO arch_smells (repo, type, severity, description, involved_files, involved_clusters, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      smell.repo,
      smell.type,
      smell.severity,
      smell.description,
      JSON.stringify(smell.involvedFiles),
      JSON.stringify(smell.involvedClusters ?? []),
      smell.suggestion
    );
  }

  getArchSmells(repo: string): Record<string, any>[] {
    const rows = this.backend.prepare('SELECT * FROM arch_smells WHERE repo = ?').all(repo) as any[];
    return rows.map(r => ({
      ...r,
      involvedFiles: JSON.parse(r.involved_files),
      involvedClusters: JSON.parse(r.involved_clusters),
    }));
  }

  inTransaction<T>(fn: () => T): T {
    return this.backend.inTransaction(fn);
  }

  close(): void {
    this.backend.close();
  }
}
