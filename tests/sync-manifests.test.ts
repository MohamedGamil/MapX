import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-02-R9: sync follows go.mod module paths and composer.json PSR-4 mappings, so it ends with the
// edges scan --force gives (M0-02-R8 covered package.json, tsconfig/jsconfig, bundlers, __init__.py).
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

const FILES = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'cmd/main.go': 'package main\n\nimport "example.com/app/util"\n\nfunc main() { util.Run() }\n',
  'util/util.go': 'package util\n\nfunc Run() {}\n',
  'composer.json': JSON.stringify({ name: 'acme/app', autoload: { 'psr-4': { 'App\\': 'src/' } } }),
  // No namespace declarations: `use App\\Models\\User` resolves through composer.json's PSR-4 roots.
  'src/Models/User.php': '<?php\nclass User { public function name() { return 1; } }\n',
  'lib/Models/User.php': '<?php\nclass User { public function name() { return 2; } }\n',
  'src/Http/Controller.php': '<?php\nnamespace App\\Http;\nuse App\\Models\\User;\nclass Controller { public function show() { return new User(); } }\n',
  'web/app.ts': "export function hello() { return 1; }\n",
};

describe('sync follows go.mod and composer.json (real CLI, git)', () => {
  let root: string;
  beforeEach(() => {
    root = workspace(FILES);
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    init(root);
    mapx(root, 'scan', '.');
  }, 120000);
  afterEach(() => cleanup(root));

  const edges = () => query<{ s: string; t: string; ty: string }>(root,
    `SELECT source_file || '#' || COALESCE(source_symbol, '') AS s, target_file || '#' || COALESCE(target_symbol, '') AS t, edge_type AS ty
     FROM edges ORDER BY 1, 2, 3`);
  const syncEqualsForce = () => {
    mapx(root, 'sync', '.');
    const synced = edges();
    mapx(root, 'scan', '.', '--force');
    expect(synced).toEqual(edges());
    return synced;
  };

  it('re-resolves Go imports after the module path changes', () => {
    expect(edges().some((e) => e.s.startsWith('cmd/main.go') && e.t.startsWith('util/util.go'))).toBe(true);
    writeFileSync(join(root, 'go.mod'), 'module example.com/renamed\n\ngo 1.22\n');
    const synced = syncEqualsForce();
    // The import names the old module path, which no longer resolves to the project package.
    expect(synced.some((e) => e.s.startsWith('cmd/main.go') && e.t.startsWith('util/util.go') && e.ty === 'import')).toBe(false);
  }, 120000);

  it('re-resolves PHP use statements after a PSR-4 mapping changes', () => {
    const importOf = (es: { s: string; t: string; ty: string }[]) => es.filter((e) => e.s.startsWith('src/Http/Controller.php') && e.ty === 'import').map((e) => e.t);
    expect(importOf(edges())).toEqual(['src/Models/User.php#App\\Models\\User']);
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ name: 'acme/app', autoload: { 'psr-4': { 'App\\': 'lib/' } } }));
    expect(importOf(syncEqualsForce())).toEqual(['lib/Models/User.php#App\\Models\\User']);
  }, 120000);

  const scannedAt = () => Object.fromEntries(query<{ path: string; last_scanned: string }>(root, 'SELECT path, last_scanned FROM files').map((f) => [f.path, f.last_scanned]));

  it('re-parses only the PHP files after a composer.json change', () => {
    const before = scannedAt();
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ name: 'acme/app', autoload: { 'psr-4': { 'App\\': 'lib/' } } }));
    mapx(root, 'sync', '.');
    const after = scannedAt();
    expect(after['src/Http/Controller.php']).not.toBe(before['src/Http/Controller.php']);
    for (const p of ['web/app.ts', 'cmd/main.go', 'util/util.go']) expect(after[p], p).toBe(before[p]);
  }, 120000);

  it('re-parses only the files a changed manifest governs', () => {
    const before = scannedAt();
    writeFileSync(join(root, 'go.mod'), 'module example.com/renamed\n\ngo 1.22\n');
    mapx(root, 'sync', '.');
    const after = scannedAt();
    expect(after['cmd/main.go']).not.toBe(before['cmd/main.go']);
    for (const p of ['web/app.ts', 'src/Models/User.php', 'src/Http/Controller.php']) expect(after[p], p).toBe(before[p]);
  }, 120000);

  it('records the new signatures on the first sync of an index from before M0-02-R9, without re-parsing', () => {
    // An older record: folder keys only, no go:/php: keys and no #families marker.
    const db = new Database(join(root, '.mapx', 'mapx.db'));
    const row = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'js_configs:%'").get() as { key: string; value: string };
    const legacy = Object.fromEntries(Object.entries(JSON.parse(row.value) as Record<string, string>).filter(([k]) => !k.startsWith('\0') && k !== '#families'));
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(legacy), row.key);
    db.close();
    const before = scannedAt();
    writeFileSync(join(root, 'go.mod'), 'module example.com/renamed\n\ngo 1.22\n');
    mapx(root, 'sync', '.');
    expect(scannedAt()['cmd/main.go']).toBe(before['cmd/main.go']);
    const recorded = JSON.parse(query<{ value: string }>(root, "SELECT value FROM meta WHERE key LIKE 'js_configs:%'")[0]!.value);
    expect(recorded['#families']).toBe('\0go:,\0php:');
    expect(Object.keys(recorded)).toEqual(expect.arrayContaining(['\0go:', '\0php:']));
  }, 120000);
});
