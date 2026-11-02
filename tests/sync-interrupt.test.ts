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

  /** Runs `fn` with Store.upsertFile throwing, as a sync killed inside its upsert transaction. */
  const crashingUpserts = async (fn: () => Promise<unknown>) => {
    const original = Store.prototype.upsertFile;
    (Store.prototype as any).upsertFile = function () { throw new Error('simulated crash'); };
    try {
      await expect(fn()).rejects.toThrow('simulated crash');
    } finally {
      Store.prototype.upsertFile = original;
    }
  };

  // M0-02-R11: the removed-file records a restored file's referrers come from, and the queued
  // referrers of other repos, are consumed only with the upserts that re-index them (review 2026-11-02).
  it('keeps a restored file and its referrers\' edges when the sync dies before its upserts commit', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    rmSync(join(root, 'src/b.ts'));
    await (await scanner(store)).scanIncremental();
    expect(store.getFile('src/b.ts')).toBeUndefined();
    if (withGit) git(root, 'checkout', '--', 'src/b.ts');
    else write(root, { 'src/b.ts': FILES['src/b.ts'] });

    await crashingUpserts(async () => (await scanner(store)).scanIncremental());
    await (await scanner(store)).scanIncremental();
    await (await scanner(store)).scanIncremental();

    const fresh = new Store(':memory:');
    await (await scanner(fresh)).scanFull(undefined, { force: true });
    expect(dump(store).files.map((f) => f.split(' ')[0])).toEqual(dump(fresh).files.map((f) => f.split(' ')[0]));
    expect(dump(store).symbols).toEqual(dump(fresh).symbols);
    expect(dump(store).edges).toEqual(dump(fresh).edges);
    expect(dump(store).edges).toContain('src/a.ts a src/b.ts b call');
  }, 120000);

  it('keeps a changed tsconfig alias when the sync dies before its upserts commit', async () => {
    write(root, {
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib1/*"] } } }\n',
      'src/lib1/x.ts': 'export function x() { return 1; }\n',
      'src/lib2/x.ts': 'export function x() { return 2; }\n',
      'src/u.ts': "import { x } from '@lib/x';\nexport function u() { return x(); }\n",
    });
    if (withGit) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'alias'); }
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    write(root, { 'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib2/*"] } } }\n' });
    appendFileSync(join(root, 'src/b.ts'), 'export function b4() { return 4; }\n');

    await crashingUpserts(async () => (await scanner(store)).scanIncremental());
    await (await scanner(store)).scanIncremental();

    const fresh = new Store(':memory:');
    await (await scanner(fresh)).scanFull(undefined, { force: true });
    expect(dump(store).edges).toEqual(dump(fresh).edges);
    expect(dump(store).edges).toContain('src/u.ts u src/lib2/x.ts x call');
  }, 120000);

  it('empties the queue of a sync that re-indexes nothing', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    const repo = (await Config.load(root)).repos[0]!.name;
    // A queued file that is no longer indexed: nothing to re-parse, but the entry is consumed.
    store.setMeta('pending_referrers:' + repo, JSON.stringify(['src/ghost.ts']));
    await (await scanner(store)).scanIncremental();
    expect(JSON.parse(store.getMeta('pending_referrers:' + repo) ?? '[]')).toEqual([]);
  }, 120000);

  it.skipIf(!withGit)('keeps the dirty paths of a reverted file when the sync dies before its upserts commit', async () => {
    appendFileSync(join(root, 'src/b.ts'), 'export function b9() { return 9; }\n');
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    expect(store.getAllSymbols().some((s) => s.name === 'b9')).toBe(true);
    git(root, 'checkout', '--', 'src/b.ts');
    // Another change, so the sync reaches its upserts.
    appendFileSync(join(root, 'src/c.ts'), 'export function c5() { return 5; }\n');

    await crashingUpserts(async () => (await scanner(store)).scanIncremental());
    await (await scanner(store)).scanIncremental();
    await (await scanner(store)).scanIncremental();

    expect(store.getAllSymbols().some((s) => s.name === 'b9')).toBe(false);
    const fresh = new Store(':memory:');
    await (await scanner(fresh)).scanFull(undefined, { force: true });
    expect(dump(store).symbols).toEqual(dump(fresh).symbols);
  }, 120000);

  it('keeps the referrers another repo queued when the sync dies before its upserts commit', async () => {
    const store = new Store(':memory:');
    await (await scanner(store)).scanFull();
    const repo = (await Config.load(root)).repos[0]!.name;
    store.setMeta('pending_referrers:' + repo, JSON.stringify(['src/c.ts']));
    appendFileSync(join(root, 'src/b.ts'), 'export function b3() { return 3; }\n');

    await crashingUpserts(async () => (await scanner(store)).scanIncremental());
    expect(JSON.parse(store.getMeta('pending_referrers:' + repo) ?? '[]')).toEqual(['src/c.ts']);

    // The next sync re-parses it and consumes the entry.
    const parsed: string[] = [];
    await (await scanner(store, (p) => { if (p.phase === 'parse' && p.file) parsed.push(p.file); })).scanIncremental();
    expect(parsed).toContain('src/c.ts');
    expect(JSON.parse(store.getMeta('pending_referrers:' + repo) ?? '[]')).toEqual([]);
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
