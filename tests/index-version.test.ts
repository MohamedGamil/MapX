import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, mapxResult, workspace } from './helpers/e2e.js';
import { ATTRIBUTION_VERSION, EXTRACTOR_VERSION } from '../src/core/extractor-version.js';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import { getMcpStalenessWarning } from '../src/mcp.js';

// M5-26: the index records the extractor version that built it; an index an older MapX built is
// stale for `mapx check` and the other commands, and the next scan or sync re-parses it once.
const FILES = {
  'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
  'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
  'src/b.ts': 'export function b() { return 1; }\n',
};

describe('the extractor version of an index (M5-26)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace(FILES);
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const meta = (sql: string, ...args: unknown[]) => {
    const db = new Database(join(root, '.mapx', 'mapx.db'));
    try {
      return db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  };
  const version = () => meta("SELECT value FROM meta WHERE key LIKE 'extractor_version:%'").map((r) => r.value);
  /** Makes the index look built by an older MapX: an older version, or none recorded. */
  const age = (to: string | null) => meta(to === null
    ? "DELETE FROM meta WHERE key LIKE 'extractor_version:%' RETURNING key"
    : "UPDATE meta SET value = ? WHERE key LIKE 'extractor_version:%' RETURNING key", ...(to === null ? [] : [to]));

  it('records the current version with a scan', () => {
    expect(version()).toEqual([String(EXTRACTOR_VERSION)]);
  });

  it.each([['an older version', '0'], ['no version', null]])('makes mapx check exit 4 for %s, and --sync rebuilds it', (_name, to) => {
    expect(age(to)).toHaveLength(1);
    const stale = mapxResult(root, 'check');
    expect(stale.status).toBe(4);
    expect(stale.stderr).toContain('was built by an older MapX');

    const before = Object.fromEntries(meta('SELECT path, last_scanned FROM files').map((r) => [r.path, r.last_scanned]));
    const synced = mapxResult(root, 'check', '--sync');
    // Past the index gate: no architecture configuration here, so 3.
    expect(synced.status).toBe(3);
    expect(version()).toEqual([String(EXTRACTOR_VERSION)]);
    // Every file was re-parsed, not only changed ones (there are none).
    for (const r of meta('SELECT path, last_scanned FROM files')) expect(r.last_scanned).not.toBe(before[r.path as string]);
    expect(mapxResult(root, 'check').status).toBe(3);
  }, 120000);

  it('warns in the other commands for an older index only', () => {
    expect(mapxResult(root, 'query', 'a').stderr).not.toContain('older MapX');
    age('0');
    expect(mapxResult(root, 'query', 'a').stderr).toContain('was built by an older MapX');
  }, 120000);

  it('warns in MCP tool results for an older index only', () => {
    const read = () => {
      const store = new Store(join(root, '.mapx', 'mapx.db'));
      try {
        return getMcpStalenessWarning(store, root);
      } finally {
        store.close();
      }
    };
    expect(read()).not.toContain('older MapX');
    age('0');
    expect(read()).toContain('was built by an older MapX: run mapx_sync');
  }, 120000);

  const scannedAt = () => Object.fromEntries(meta('SELECT path, last_scanned FROM files').map((r) => [r.path, r.last_scanned]));

  it('re-parses the older index once: the sync after the upgrading one parses nothing', async () => {
    age('0');
    const config = await Config.load(root);
    const store = new Store(join(root, '.mapx', 'mapx.db'));
    try {
      const sync = () => new Scanner(store, config, new MapxGraph(config.repos[0]!.name)).scanIncremental();
      const before = scannedAt();
      await sync();
      // Every file was re-parsed (review: a count would also match the unchanged files).
      for (const [path, at] of Object.entries(scannedAt())) expect(at).not.toBe(before[path]);
      expect((await sync()).filesScanned).toBe(0);
    } finally {
      store.close();
    }
  }, 120000);

  it('ignores the resume state an older interrupted scan left', async () => {
    const config = await Config.load(root);
    const store = new Store(join(root, '.mapx', 'mapx.db'));
    try {
      writeFileSync(join(root, 'src/a.ts'), "import { b } from './b';\nexport function a() { return b() + 1; }\n");
      let scanner!: Scanner;
      scanner = new Scanner(store, config, new MapxGraph(config.repos[0]!.name), (p) => { if (p.phase === 'parse') scanner.abort(); });
      expect((await scanner.scanFull()).interrupted).toBe(true);
    } finally {
      store.close();
    }
    age('0');
    const before = scannedAt();
    mapx(root, 'scan', '.');
    expect(version()).toEqual([String(EXTRACTOR_VERSION)]);
    for (const [path, at] of Object.entries(scannedAt())) expect(at).not.toBe(before[path]);
  }, 120000);

  it('does not record the version for an interrupted scan', async () => {
    age(null);
    const config = await Config.load(root);
    const store = new Store(join(root, '.mapx', 'mapx.db'));
    try {
      let scanner!: Scanner;
      scanner = new Scanner(store, config, new MapxGraph(config.repos[0]!.name), (p) => { if (p.phase === 'parse') scanner.abort(); });
      const r = await scanner.scanFull();
      expect(r.interrupted).toBe(true);
    } finally {
      store.close();
    }
    expect(version()).toEqual([]);
  }, 120000);
});

describe('mapx check --sync with a repo it cannot rebuild (review of M5-26)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
      'src/a.ts': 'export function a() { return 1; }\n',
      'frontend/package.json': JSON.stringify({ name: 'front', version: '1.0.0' }),
      'frontend/src/b.ts': 'export function b() { return 1; }\n',
    });
    for (const dir of ['frontend', '.']) {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'init', '-q'], { cwd: join(root, dir) });
      execFileSync('git', ['add', '-A'], { cwd: join(root, dir) });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: join(root, dir) });
    }
    init(root);
    mapx(root, 'workspaces', 'add', 'frontend');
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  it('keeps exit 4 when a repo is still outdated after the sync', () => {
    const db = new Database(join(root, '.mapx', 'mapx.db'));
    try {
      expect(db.prepare("UPDATE meta SET value = '0' WHERE key LIKE 'extractor_version:%' RETURNING key").all().length).toBeGreaterThan(1);
    } finally {
      db.close();
    }
    renameSync(join(root, 'frontend'), join(root, 'frontend-moved'));
    const r = mapxResult(root, 'check', '--sync');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('could not rebuild');
  }, 120000);
});

// M5-19-R1 (review): an index whose external-reference attribution older rules made is outdated for
// the gate, `status` and the warnings, like an older extractor; the sync attributes it again and
// parses no file. Only the attribution version differs from a current index.
describe('the attribution-rules version of an index (M5-19-R1)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.0.0' } }),
      'src/a.ts': "import _ from 'lodash';\nexport function a() { return _.noop(); }\n",
    });
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const db = <T>(use: (d: Database.Database) => T): T => {
    const d = new Database(join(root, '.mapx', 'mapx.db'));
    try { return use(d); } finally { d.close(); }
  };
  const record = () => JSON.parse((db((d) => d.prepare("SELECT value FROM meta WHERE key = 'external_inputs'").get()) as { value: string }).value);
  /** Records the previous attribution version: the only change to the index. */
  const older = () => {
    const r = record();
    r.rules = ATTRIBUTION_VERSION - 1;
    db((d) => d.prepare("UPDATE meta SET value = ? WHERE key = 'external_inputs'").run(JSON.stringify(r)));
  };
  const state = () => db((d) => ({
    scanned: d.prepare('SELECT path, last_scanned FROM files').all(),
    extractor: d.prepare("SELECT value FROM meta WHERE key LIKE 'extractor_version:%'").all(),
  }));
  const mcpWarning = () => {
    const store = new Store(join(root, '.mapx', 'mapx.db'));
    try { return getMcpStalenessWarning(store, root); } finally { store.close(); }
  };

  it('a current index is clean for the gate, status and the warnings', () => {
    expect(record().rules).toBe(ATTRIBUTION_VERSION);
    expect(mapxResult(root, 'check').status).toBe(3);
    expect(mapxResult(root, 'status').stdout).not.toContain('older MapX');
    expect(mcpWarning()).not.toContain('older MapX');
  }, 120000);

  it('an older attribution version: check exits 4, status and the warnings say so, and --sync attributes again without parsing a file', () => {
    older();
    const before = state();
    const stale = mapxResult(root, 'check');
    expect(stale.status).toBe(4);
    expect(stale.stderr).toContain('was built by an older MapX');
    const status = mapxResult(root, 'status');
    expect(status.stdout).toContain('was built by an older MapX');
    expect(status.stdout).toContain('Index is stale');
    expect(mapxResult(root, 'query', 'a').stderr).toContain('was built by an older MapX');
    expect(mcpWarning()).toContain('was built by an older MapX: run mapx_sync');

    // Past the gate (no architecture configuration: 3); no file parsed, the extractor version kept.
    expect(mapxResult(root, 'check', '--sync').status).toBe(3);
    expect(record().rules).toBe(ATTRIBUTION_VERSION);
    expect(state()).toEqual(before);
    expect(mapxResult(root, 'check').status).toBe(3);
    expect(mapxResult(root, 'status').stdout).not.toContain('older MapX');
  }, 120000);

  it('an older record of an index with no external reference left is brought up to date by the sync too', () => {
    writeFileSync(join(root, 'src/a.ts'), 'export function a() { return 1; }\n');
    mapx(root, 'scan', '.');
    db((d) => d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('external_inputs', ?)").run(JSON.stringify({ at: Date.now(), files: {}, yarnRoots: [], rules: ATTRIBUTION_VERSION - 1 })));
    expect(mapxResult(root, 'check').status).toBe(4);
    expect(mapxResult(root, 'check', '--sync').status).toBe(3);
    expect(record().rules).toBe(ATTRIBUTION_VERSION);
  }, 120000);
});
