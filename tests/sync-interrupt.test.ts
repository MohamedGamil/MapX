import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { findStaleFiles } from '../src/core/staleness.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';

// M0-02-R10: a sync interrupted after it started re-indexing files leaves them for the next sync to
// re-parse, so the index ends equal to scan --force (docs/baton/iterations/M0-02-R10.md).

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

const FILES = {
  'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
  'src/b.ts': 'export function b() { return 1; }\n',
  'src/c.ts': "import { a } from './a';\nexport function c() { return a(); }\n",
  'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User { public function name() { return 1; } }\n',
};

const dump = (store: Store) => ({
  edges: store.getAllEdges().map((e) => `${e.source_file} ${e.source_symbol} ${e.target_file} ${e.target_symbol} ${e.edge_type}`).sort(),
  symbols: store.getAllSymbols().map((s) => `${s.file_path} ${s.name} ${s.kind} ${s.scope} ${s.start_line}`).sort(),
  files: store.getAllFiles().map((f) => `${f.path} ${f.content_hash} ${f.metadata} ${f.namespace}`).sort(),
});

describe.each([['git sync', true], ['hash sync', false]])('an interrupted %s', (_name, withGit) => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-interrupt-'));
    write(root, FILES);
    if (withGit) {
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const scanner = async (store: Store, onProgress?: ConstructorParameters<typeof Scanner>[3]) => {
    const config = await Config.load(root);
    return new Scanner(store, config, new MapxGraph(config.repos[0]!.name), onProgress);
  };
  const edit = () => {
    appendFileSync(join(root, 'src/b.ts'), 'export function b2() { return 2; }\n');
    appendFileSync(join(root, 'src/c.ts'), 'export function c2() { return c(); }\n');
    appendFileSync(join(root, 'app/Models/User.php'), '// edited\n');
  };

  it('is completed by the next sync, which ends equal to scan --force', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    edit();

    let interrupted!: Scanner;
    interrupted = await scanner(store, (p) => {
      if (p.phase === 'resolve' && p.current === 1) interrupted.abort();
    });
    const first = await interrupted.scanIncremental();
    expect(first.interrupted).toBe(true);

    // The interrupted files are stale until a sync completes them (review 2026-11-01).
    const stale = findStaleFiles(store, root);
    expect(stale.changed).toEqual(expect.arrayContaining(['src/a.ts']));

    await (await scanner(store)).scanIncremental();
    const fresh = new Store(':memory:');
    await (await scanner(fresh)).scanFull(undefined, { force: true });
    const synced = dump(store);
    const forced = dump(fresh);
    expect(synced.symbols).toEqual(forced.symbols);
    expect(synced.edges).toEqual(forced.edges);
    expect(synced.files).toEqual(forced.files);
    expect(findStaleFiles(store, root).changed).toEqual([]);
    if (withGit) {
      // The blob of the indexed bytes is recorded, which the next sync's skip compares with.
      for (const p of ['src/b.ts', 'src/c.ts']) expect(store.getFile(p)?.git_blob_hash).toMatch(/^[0-9a-f]{40}$/);
    }
  }, 120000);

  it.skipIf(process.getuid?.() === 0)('drops an interrupted file that can no longer be read, instead of retrying it every sync', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    edit();
    let interrupted!: Scanner;
    interrupted = await scanner(store, (p) => {
      if (p.phase === 'resolve' && p.current === 1) interrupted.abort();
    });
    await interrupted.scanIncremental();
    chmodSync(join(root, 'src/a.ts'), 0o000);
    try {
      await (await scanner(store)).scanIncremental();
      const phases = new Set<string>();
      await (await scanner(store, (p) => phases.add(p.phase))).scanIncremental();
      expect(phases.has('cluster')).toBe(false);
      expect(store.getFile('src/a.ts')).toBeUndefined();
    } finally {
      chmodSync(join(root, 'src/a.ts'), 0o644);
    }
  }, 120000);

  it('still skips unchanged files once a sync completes', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    edit();
    await (await scanner(store)).scanIncremental();
    const phases = new Set<string>();
    const again = await (await scanner(store, (p) => phases.add(p.phase))).scanIncremental();
    expect(again.filesScanned).toBe(0);
    expect(phases.has('parse')).toBe(false);
    expect(phases.has('cluster')).toBe(false);
  }, 120000);
});
