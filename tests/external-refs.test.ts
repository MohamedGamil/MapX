import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import { extractorVersionKey } from '../src/core/extractor-version.js';
import { jsImports } from '../src/core/external-refs.js';
import { builtinModules } from 'node:module';
import { NODE_BUILTINS, NODE_PREFIX_ONLY_BUILTINS, nodeBuiltin, npmPackageName, parsePackageLock, parsePnpmLock, parseYarnLock } from '../src/core/manifests/npm.js';
import { ComposerAttributor, composerRoots, lockPackagesOf, packageByConvention, parseComposerLock, phpBuiltin } from '../src/core/manifests/composer.js';
import { PHP_BUILTINS_SOURCE } from '../src/core/manifests/php-builtins.js';
import { EXTERNAL_INPUTS_KEY, changedInputFiles, parseExternalInputs } from '../src/core/manifests/inputs.js';
import { cleanup, init, mapx, mapxResult, query } from './helpers/e2e';

// M5-19: references to modules, packages, classes and functions outside the workspace are kept apart
// from edges; whether a candidate is external is decided again at the end of every scan and sync, so
// sync keeps external_refs equal to scan --force (docs/baton/iterations/M5-19.md and its review).

const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');

interface Attribution { package?: string | null; origin?: string | null; direct?: boolean | null; dev?: boolean | null; attribution?: string | null }
interface Label extends Attribution { app: string; file: string; line: number; sourceSymbol: string | null; specifier: string; symbol: string | null; kind: string; ecosystem: string }
const labels = JSON.parse(readFileSync(join(FIXTURE, 'expected-externals.json'), 'utf8')) as { apps: string[]; rows: Label[] };
const REPOS: Record<string, string[]> = { workspace: ['frontend', 'backend'] };

const key = (r: Omit<Label, 'app'>) => [r.file, r.line, r.sourceSymbol, r.specifier, r.symbol, r.kind, r.ecosystem].join(' | ');

describe('the external_refs store', () => {
  it('is added by migration 10 to an index at schema 9: the candidates table and the external_refs view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mapx-extrefs-'));
    try {
      const path = join(dir, 'mapx.db');
      new Store(path).close();
      const db = new Database(path);
      db.exec('DROP VIEW external_refs; DROP TABLE external_ref_candidates');
      db.prepare("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run();
      db.close();
      const store = new Store(path);
      expect(store.getMeta('schema_version')).toBe('10');
      const columns = (table: string) => store.raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      expect(columns('external_ref_candidates')).toEqual(expect.arrayContaining(['file_path', 'line', 'specifier', 'symbol', 'kind', 'external', 'package', 'origin', 'direct', 'dev', 'attribution']));
      expect(columns('external_refs')).toEqual(expect.arrayContaining(['file_path', 'line', 'specifier', 'symbol', 'kind', 'ecosystem', 'package']));
      store.replaceExternalRefs('a.ts', 'r', [
        { line: 1, sourceSymbol: null, specifier: 'pg', symbol: null, kind: 'import', ecosystem: 'npm', external: true },
        { line: 2, sourceSymbol: null, specifier: 'lib/x', symbol: null, kind: 'import', ecosystem: 'npm', external: false },
      ]);
      // The view holds the candidates decided external only.
      expect(store.getExternalRefs().map((r) => r.specifier)).toEqual(['pg']);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Scans a copy of a fixture app with the real CLI, once per app; its external_refs rows. */
const scanned = new Map<string, Array<Omit<Label, 'app'>>>();
function scanApp(app: string): Array<Omit<Label, 'app'>> {
  const cached = scanned.get(app);
  if (cached) return cached;
  const root = join(mkdtempSync(join(tmpdir(), 'mapx-extrefs-')), app);
  try {
    cpSync(join(FIXTURE, app), root, { recursive: true });
    init(root);
    for (const repo of REPOS[app] ?? []) {
      execFileSync('git', ['init', '-q', join(root, repo)]);
      mapx(root, 'workspaces', 'add', repo);
    }
    mapx(root, 'scan');
    // Never an edge: every edge stays between indexed files.
    expect(query(root, 'SELECT source_file, target_file FROM edges WHERE target_file NOT IN (SELECT path FROM files)')).toEqual([]);
    const flag = (n: number | null) => (n === null ? null : n === 1);
    const rows = query<{ file_path: string; line: number; source_symbol: string | null; specifier: string; symbol: string | null; kind: string; ecosystem: string; package: string | null; origin: string | null; direct: number | null; dev: number | null; attribution: string | null }>(
      root, 'SELECT file_path, line, source_symbol, specifier, symbol, kind, ecosystem, package, origin, direct, dev, attribution FROM external_refs')
      .map((r) => ({
        file: r.file_path, line: r.line, sourceSymbol: r.source_symbol, specifier: r.specifier, symbol: r.symbol, kind: r.kind, ecosystem: r.ecosystem,
        package: r.package, origin: r.origin, direct: flag(r.direct), dev: flag(r.dev), attribution: r.attribution,
      }));
    scanned.set(app, rows);
    return rows;
  } finally {
    cleanup(dirname(root));
  }
}

const sourcesOf = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === '.mapx') return [];
  return statSync(path).isDirectory() ? sourcesOf(path) : [path];
});

/**
 * The import statements of an app's sources that name something outside the app, read with plain
 * patterns, independently of the scanner: a non-relative JS/TS specifier, an absolute Python module
 * outside the `app` package, a Go path outside the go.mod module, a PHP `use` outside `App\`.
 */
function importOracle(app: string): string[] {
  const root = join(FIXTURE, app);
  const found: string[] = [];
  for (const path of sourcesOf(root)) {
    const file = relative(root, path);
    const lines = readFileSync(path, 'utf8').split('\n');
    const add = (i: number, specifier: string) => found.push(`${file}:${i + 1} ${specifier}`);
    lines.forEach((line, i) => {
      if (/\.tsx?$/.test(file)) {
        const m = /(?:from\s+|import\s+|require\()'([^'.][^']*)'/.exec(line);
        if (m) add(i, m[1]!);
      } else if (file.endsWith('.py')) {
        const m = /^(?:from|import)\s+([\w.]+)/.exec(line);
        if (m && !m[1]!.startsWith('app')) add(i, m[1]!);
      } else if (file.endsWith('.go')) {
        const m = /^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/.exec(line);
        if (m && !m[1]!.startsWith('example.com/shop')) add(i, m[1]!);
      } else if (file.endsWith('.php')) {
        const m = /^use\s+([\w\\]+);/.exec(line);
        if (m && !m[1]!.startsWith('App\\')) add(i, m[1]!);
      }
    });
  }
  return [...new Set(found)].sort();
}

describe('a scan of the arch-rules fixture', () => {
  it.each(labels.apps)('fills external_refs with exactly the labelled references of %s, and no edge leaves the workspace', (app) => {
    expect(scanApp(app).map(key).sort()).toEqual(labels.rows.filter((l) => l.app === app).map(key).sort());
  }, 120000);

  // M5-20 (npm), M5-21 (Composer): every row carries the labelled package, origin, direct, dev and attribution.
  it.each(labels.apps)('attributes every npm and Composer row of %s as labelled: package or built-in, direct or transitive, dev or production', (app) => {
    const attributed = (r: Omit<Label, 'app'>) => `${key(r)} | ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`;
    const ecosystems = new Set(['npm', 'composer']);
    expect(scanApp(app).filter((r) => ecosystems.has(r.ecosystem)).map(attributed).sort())
      .toEqual(labels.rows.filter((l) => l.app === app && ecosystems.has(l.ecosystem)).map(attributed).sort());
  }, 120000);

  it.each(labels.apps)('gives a row to every import of %s that names something outside the workspace', (app) => {
    const imports = [...new Set(scanApp(app).filter((r) => r.kind === 'import' || r.kind === 'require').map((r) => `${r.file}:${r.line} ${r.specifier}`))].sort();
    expect(imports).toEqual(importOracle(app));
  }, 120000);
});

describe('JS/TS import statements', () => {
  it('reads named, default, namespace, side-effect, export-from and require forms, not quoted ones', () => {
    const code = [
      "import a, { b as c, type d } from 'm1';",
      "import * as ns from 'm2';",
      "import 'm3';",
      "export { e } from 'm4';",
      "const f = require('m5');",
      "const s = \"import x from 'quoted'\";",
    ].join('\n');
    const masked = code.replace(/"[^"]*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"');
    expect(jsImports(code, masked).map((i) => [i.specifier, i.line, i.require, i.names.map((n) => `${n.local}=${n.imported}`).join(','), i.local ?? ''])).toEqual([
      ['m1', 1, false, 'c=b,d=d,a=default', ''],
      ['m2', 2, false, 'ns=*', ''],
      ['m3', 3, false, '', ''],
      ['m4', 4, false, 'null=e', ''],
      ['m5', 5, true, '', 'f'],
    ]);
  });
});

const write = (root: string, files: Record<string, string | null>) => {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(root, path), { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

const dumpRefs = (store: Store) => store.getExternalRefs()
  .map((r) => `${r.file_path}:${r.line} ${r.source_symbol} ${r.specifier} ${r.symbol} ${r.kind} ${r.ecosystem}`).sort();
/** With the attribution (M5-20): package, origin, direct, dev, attribution. */
const dumpAll = (store: Store) => store.getExternalRefs()
  .map((r) => `${r.file_path}:${r.line} ${r.source_symbol} ${r.specifier} ${r.symbol} ${r.kind} ${r.ecosystem} | ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`).sort();
const dumpEdges = (store: Store) => store.getAllEdges()
  .map((e) => `${e.source_file} ${e.source_symbol} ${e.target_file} ${e.target_symbol} ${e.edge_type}`).sort();

/** A temp workspace, scanned in process: the sync paths and scan --force on the same files. */
function project(withGit: boolean) {
  let root = '';
  const scanner = async (store: Store, onProgress?: ConstructorParameters<typeof Scanner>[3]) => {
    const config = await Config.load(root);
    return new Scanner(store, config, new MapxGraph(config.repos[0]!.name), onProgress);
  };
  return {
    get root() { return root; },
    create(files: Record<string, string>) {
      root = mkdtempSync(join(tmpdir(), 'mapx-extrefs-sync-'));
      write(root, files);
      if (withGit) {
        git(root, 'init', '-q');
        git(root, 'add', '-A');
        git(root, 'commit', '-qm', 'init');
      }
    },
    remove() { if (root) rmSync(root, { recursive: true, force: true }); },
    scanner,
    sync: async (store: Store, full = false) => full ? (await scanner(store)).scanFull() : (await scanner(store)).scanIncremental(),
    forced: async () => {
      const fresh = new Store(':memory:');
      await (await scanner(fresh)).scanFull(undefined, { force: true });
      return fresh;
    },
  };
}

// Sync keeps external_refs equal to scan --force, on the git and hash sync paths and a full scan.
const FILES = {
  // Listed packages: calls on their bindings take the npm-package path of resolution (M0-17-R4).
  'package.json': JSON.stringify({ name: 'sync-app', dependencies: { pg: '^8.0.0', express: '^4.0.0', axios: '^1.0.0' } }),
  'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
  'go.mod': 'module example.com/sync\n\ngo 1.22\n',
  'src/db.ts': "import { Pool } from 'pg';\nexport function db() { return new Pool(); }\n",
  'src/web.ts': "import express from 'express';\nimport { db } from './db';\nexport function web() { db(); return express(); }\n",
  'src/gone.ts': "import * as fs from 'node:fs';\nexport function gone() { return fs.readFileSync('x'); }\n",
  'src/moved.ts': "import { z } from 'zod';\nexport const schema = z.object({});\n",
  'py/job.py': 'import requests\n\n\ndef job():\n    requests.get("x")\n',
  'cmd/main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n}\n',
  'app/Mail.php': '<?php\nnamespace App;\n\nuse GuzzleHttp\\Client;\n\nclass Mail { public function send() { return new Client(); } }\n',
};

describe.each([
  ['git sync', true, false],
  ['hash sync', false, false],
  ['full scan', false, true],
] as const)('a %s', (_name, withGit, full) => {
  const p = project(withGit);
  beforeEach(() => p.create(FILES));
  afterEach(() => p.remove());

  const edit = () => {
    // Edited: one external import added, one removed; deleted; renamed; added.
    write(p.root, {
      'src/db.ts': "import { Client } from 'pg';\nimport lodash from 'lodash';\nexport function db() { lodash.noop(); return new Client(); }\n",
      'py/job.py': 'import httpx\n\n\ndef job():\n    httpx.get("x")\n',
      'cmd/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfmt.Println(os.Args)\n}\n',
      'app/Mail.php': '<?php\nnamespace App;\n\nclass Mail { public function send() { return new \\DateTime(); } }\n',
      'src/added.ts': "import axios from 'axios';\nexport const api = axios.create();\n",
    });
    rmSync(join(p.root, 'src/gone.ts'));
    renameSync(join(p.root, 'src/moved.ts'), join(p.root, 'src/renamed.ts'));
  };

  it('keeps external_refs equal to scan --force after edits, deletions and renames', async () => {
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    expect(dumpRefs(store)).toEqual(expect.arrayContaining([
      'src/gone.ts:1 null node:fs * import npm',
      'src/moved.ts:1 null zod z import npm',
      'cmd/main.go:3 null fmt null import go',
      'app/Mail.php:4 null GuzzleHttp\\Client Client import composer',
      'py/job.py:1 null requests null import pypi',
      'src/web.ts:3 web express default call npm',
      'src/db.ts:2 db pg Pool instantiation npm',
    ]));
    edit();
    await p.sync(store, full);
    const fresh = await p.forced();
    expect(dumpAll(store)).toEqual(dumpAll(fresh));
    expect(dumpRefs(store)).toEqual(expect.arrayContaining([
      'src/db.ts:2 null lodash default import npm',
      'src/renamed.ts:1 null zod z import npm',
      'src/added.ts:1 null axios default import npm',
      'py/job.py:1 null httpx null import pypi',
      'cmd/main.go:5 null os null import go',
      // `const api = axios.create()` is a function symbol to the parser (M0-17-R2).
      'src/added.ts:2 api axios default.create call npm',
    ]));
    expect(dumpRefs(store).filter((r) => /^src\/(gone|moved)\.ts|requests|GuzzleHttp/.test(r))).toEqual([]);
    expect(dumpEdges(store)).toEqual(dumpEdges(fresh));
  }, 120000);

  // A full scan writes its results in batches of many files: M0-02-R12 covers its interruption.
  it.skipIf(full)('ends equal to scan --force after a sync interrupted while it wrote results', async () => {
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    edit();
    let interrupted!: Scanner;
    interrupted = await p.scanner(store, (e) => {
      if (e.phase === 'resolve' && e.current === 1) interrupted.abort();
    });
    expect((await interrupted.scanIncremental()).interrupted).toBe(true);
    await p.sync(store, full);
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
  }, 120000);

  it('fills external_refs of an index an older extractor built, without --force', async () => {
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    // As an index built before M5-19 (extractor version 8, M5-10): no external references.
    store.raw.exec('DELETE FROM external_ref_candidates');
    store.setMeta(extractorVersionKey(store.getRepoNames()[0]!), '8');
    await p.sync(store, full);
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
    expect(dumpRefs(store).length).toBeGreaterThan(0);
  }, 120000);

  it('drops the candidates an older MapX left for a file it deleted', async () => {
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    // As a sync by a MapX before M5-19: the file row goes, its candidates stay.
    rmSync(join(p.root, 'src/gone.ts'));
    store.raw.prepare('DELETE FROM symbols WHERE file_path = ?').run('src/gone.ts');
    store.raw.prepare('DELETE FROM edges WHERE source_file = ? OR target_file = ?').run('src/gone.ts', 'src/gone.ts');
    store.raw.prepare('DELETE FROM files WHERE path = ?').run('src/gone.ts');
    expect(dumpRefs(store)).toContain('src/gone.ts:1 null node:fs * import npm');
    await p.sync(store, full);
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
  }, 120000);
});

// Review of M5-19 (P1): another file decides whether a reference is external. A sync that re-parses
// only the changed files must still end equal to scan --force.
const DECIDED_ELSEWHERE: Array<{ name: string; before: Record<string, string>; change: Record<string, string | null>; gone?: string; appears?: string; stays?: string }> = [
  {
    name: 'a workspace package named like the import is added',
    before: {
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/a.ts': "import { Pool } from 'pg';\nexport const p = () => new Pool();\n",
    },
    change: { 'packages/pg/package.json': '{"name":"pg","main":"index.ts"}', 'packages/pg/util.ts': 'export const z = 1;\n' },
    gone: 'apps/web/a.ts:1 null pg Pool import npm',
  },
  {
    name: 'a file of another namespace is added (the class stays outside)',
    before: {
      'composer.json': '{"autoload":{"psr-4":{"App\\\\":"src/"}}}',
      'src/A.php': '<?php\nnamespace App;\nuse Vendor\\Lib\\Thing;\nclass A { public function r() { return new Thing(); } }\n',
    },
    change: { 'lib/X.php': '<?php\nnamespace Vendor\\Other;\nclass X {}\n' },
    stays: 'src/A.php:3 null Vendor\\Lib\\Thing Thing import composer',
  },
  {
    name: 'the only file of a namespace is deleted',
    before: {
      'src/A.php': '<?php\nnamespace App;\nuse Acme\\Missing;\nclass A { public function r() { return new Missing(); } }\n',
      'lib/X.php': '<?php\nnamespace Acme\\Other;\nclass X {}\n',
    },
    change: { 'lib/X.php': null },
    stays: 'src/A.php:3 null Acme\\Missing Missing import composer',
  },
  {
    name: 'a Python package named like the import is added',
    before: {
      'main.py': "import requests.adapters\nfrom yaml import load\n\ndef run():\n    requests.adapters.HTTPAdapter()\n    load('x')\n",
      'util.py': 'def u():\n    pass\n',
    },
    change: { 'requests/__init__.py': 'X = 1\n' },
    gone: 'main.py:1 null requests.adapters null import pypi',
  },
  {
    name: 'an indexed module named like a bare specifier is added at the root',
    before: {
      'package.json': '{"name":"root"}',
      'src/a.ts': "import { Pool } from 'pg';\nexport const p = () => new Pool();\n",
    },
    change: { 'pg.ts': 'export const other = 1;\n' },
    gone: 'src/a.ts:1 null pg Pool import npm',
  },
  {
    name: 'a Python package is deleted (its missing module becomes outside)',
    before: {
      'main.py': 'from foo.missing import Gone\n\ndef run():\n    Gone()\n',
      'foo/__init__.py': '',
      'foo/other.py': 'def o():\n    pass\n',
    },
    change: { foo: null },
    appears: 'main.py:1 null foo.missing Gone import pypi',
  },
  {
    name: 'path aliases are added to tsconfig',
    before: {
      'package.json': '{"name":"root"}',
      'src/a.ts': "import { h } from 'lib/helpers';\nexport const p = () => h();\n",
      'src/other.ts': 'export const q = 1;\n',
    },
    change: { 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"lib/*":["src/lib/*"]}}}' },
    gone: 'src/a.ts:1 null lib/helpers h import npm',
  },
  {
    name: 'a go.mod is added',
    before: { 'svc/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"github.com/x/y"\n)\n\nfunc main() { fmt.Println(); y.Do() }\n' },
    change: { 'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n' },
    appears: 'svc/main.go:5 null github.com/x/y null import go',
  },
];

describe.each([['git sync', true], ['hash sync', false]] as const)('a %s, when another file decides', (_name, withGit) => {
  const p = project(withGit);
  afterEach(() => p.remove());

  it.each(DECIDED_ELSEWHERE)('$name: equal to scan --force', async ({ before, change, gone, appears, stays }) => {
    p.create(before);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    if (gone ?? stays) expect(dumpRefs(store)).toContain(gone ?? stays);
    if (appears) expect(dumpRefs(store)).not.toContain(appears);
    write(p.root, change);
    if (withGit) {
      git(p.root, 'add', '-A');
      git(p.root, 'commit', '-qm', 'change');
    }
    await p.sync(store);
    const fresh = await p.forced();
    const forced = dumpRefs(fresh);
    expect(dumpAll(store)).toEqual(dumpAll(fresh));
    if (gone) expect(forced).not.toContain(gone);
    if (appears ?? stays) expect(forced).toContain(appears ?? stays);
  }, 120000);
});

// Review of M5-19 (P2): what is, and is not, an external reference.
describe('a scan decides', () => {
  const p = project(false);
  afterEach(() => p.remove());
  const refsOf = async (files: Record<string, string>) => {
    p.create(files);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    return dumpRefs(store);
  };

  it('a Python standard-library module external although a folder of other files has its name', async () => {
    const refs = await refsOf({
      'types/index.ts': 'export type T = 1;\n',
      'http/client.ts': 'export const c = 1;\n',
      'main.py': 'from types import SimpleNamespace\nimport http.client\n',
    });
    expect(refs).toEqual(expect.arrayContaining([
      'main.py:1 null types SimpleNamespace import pypi',
      'main.py:2 null http.client null import pypi',
    ]));
  }, 120000);

  it('a PHP class per name: a workspace namespace does not make its other classes the project\'s', async () => {
    const refs = await refsOf({
      'lib/X.php': '<?php\nnamespace Vendor\\Other;\nclass X {}\n',
      'src/A.php': '<?php\nnamespace App;\nuse Vendor\\Other\\X;\nuse Vendor\\Other\\Y;\nclass A {\n  public function r() { new X(); return new Y(); }\n}\n',
    });
    expect(refs.filter((r) => r.startsWith('src/A.php'))).toEqual([
      'src/A.php:4 null Vendor\\Other\\Y Y import composer',
      'src/A.php:6 A::r Vendor\\Other\\Y Y instantiation composer',
    ]);
  }, 120000);

  it('no URL, SvelteKit `$` alias or PHP construct as an external reference; a facade as the file names it', async () => {
    const refs = await refsOf({
      'package.json': '{"name":"root"}',
      'svelte.config.js': 'export default { kit: {} };\n',
      'src/deno.ts': "import { z } from 'https://deno.land/x/z/mod.ts';\nimport * as fs from 'node:fs';\nexport const s = () => z.string();\n",
      'src/routes/page.ts': "import Btn from '$lib/Btn.svelte';\nimport { goto } from '$app/navigation';\nexport const g = () => goto(Btn);\n",
      'routes/web.php': '<?php\nuse Illuminate\\Support\\Facades\\DB;\n\nif (isset($x) && !empty($y)) { unset($x); }\nDB::transaction(fn () => null);\n',
    });
    expect(refs).toEqual([
      'routes/web.php:2 null Illuminate\\Support\\Facades\\DB DB import composer',
      'routes/web.php:5 null Illuminate\\Support\\Facades\\DB DB call composer',
      'src/deno.ts:2 null node:fs * import npm',
    ]);
  }, 120000);
});

// ─── M5-20: npm package attribution and Node built-ins ──────────────────────────────────────

describe('Node built-ins and npm package names', () => {
  it('lists every built-in of the running Node, with and without the node: prefix', () => {
    for (const m of builtinModules) {
      if (m.startsWith('node:')) expect(NODE_PREFIX_ONLY_BUILTINS.has(m.slice(5)), m).toBe(true);
      else expect(NODE_BUILTINS.has(m), m).toBe(true);
    }
  });

  it('names the built-in module, node: or not, subpaths included; never a node:-only name without the prefix', () => {
    expect(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'path/posix', 'node:test', 'node:test/reporters', 'node:sqlite', 'events', 'punycode']
      .map(nodeBuiltin)).toEqual(['node:fs', 'node:fs', 'node:fs', 'node:fs', 'node:path', 'node:test', 'node:test', 'node:sqlite', 'node:events', 'node:punycode']);
    expect(['test', 'sqlite', 'sea', 'fs/whatever', 'punycode/', 'lodash', '@types/node'].map(nodeBuiltin)).toEqual([null, null, null, null, null, null, null]);
  });

  it('attributes scoped and deep imports to their package', () => {
    expect(['@scope/pkg/sub/path', '@scope/pkg', 'lodash/get', 'lodash', 'pg'].map(npmPackageName)).toEqual(['@scope/pkg', '@scope/pkg', 'lodash', 'lodash', 'pg']);
  });
});

describe('npm lockfiles', () => {
  const sorted = (m: Map<string, boolean | null>) => [...m].sort(([a], [b]) => a.localeCompare(b));

  it('package-lock v3: dev flags, nested copies (production wins), no workspace folders or links', () => {
    const lock = parsePackageLock(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'apps/web': { name: 'web' },
        'node_modules/web': { resolved: 'apps/web', link: true },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '1.0.0', dev: true },
        'node_modules/b/node_modules/a': { version: '2.0.0', dev: true },
        'node_modules/@s/c': { version: '1.0.0', dev: true },
        'node_modules/@s/c/node_modules/d': { version: '1.0.0', dev: true },
        'node_modules/x/node_modules/d': { version: '2.0.0' },
        'node_modules/o': { version: '1.0.0', devOptional: true },
      },
    }));
    expect(sorted(lock.dev)).toEqual([['@s/c', true], ['a', false], ['b', true], ['d', false], ['o', false]]);
  });

  it('package-lock v1: the dependencies tree', () => {
    const lock = parsePackageLock(JSON.stringify({
      lockfileVersion: 1,
      dependencies: { a: { version: '1', requires: { b: '1' } }, b: { version: '1' }, t: { version: '1', dev: true, dependencies: { u: { version: '1', dev: true } } } },
    }));
    expect(sorted(lock.dev)).toEqual([['a', false], ['b', false], ['t', true], ['u', true]]);
  });

  it('pnpm v9: importers are the roots, snapshots the edges', () => {
    const lock = parsePnpmLock([
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      express:',
      '        specifier: ^4.0.0',
      '        version: 4.19.2',
      '    devDependencies:',
      "      '@acme/lint':",
      '        specifier: ^1.0.0',
      '        version: 1.0.0',
      '  packages/app:',
      '    devDependencies:',
      '      express:',
      '        specifier: ^4.0.0',
      '        version: 4.19.2',
      'packages:',
      '  express@4.19.2:',
      '    resolution: {integrity: sha512-x}',
      "  '@acme/lint@1.0.0':",
      '    resolution: {integrity: sha512-y}',
      '  debug@2.6.9:',
      '    resolution: {integrity: sha512-z}',
      '  semver@7.6.3:',
      '    resolution: {integrity: sha512-w}',
      '  orphan@1.0.0:',
      '    resolution: {integrity: sha512-v}',
      'snapshots:',
      '  express@4.19.2:',
      '    dependencies:',
      '      debug: 2.6.9',
      "  '@acme/lint@1.0.0(express@4.19.2)':",
      '    dependencies:',
      '      semver: 7.6.3',
      '      debug: 2.6.9',
      '  debug@2.6.9: {}',
      '  semver@7.6.3: {}',
    ].join('\n'));
    expect(sorted(lock.dev)).toEqual([['@acme/lint', true], ['debug', false], ['express', false], ['orphan', null], ['semver', true]]);
  });

  it('pnpm v6 and v5: top-level sections of a single project, `/name@v` and `/name/v` keys', () => {
    const v6 = parsePnpmLock([
      "lockfileVersion: '6.0'",
      'dependencies:',
      '  pg:',
      '    specifier: ^8.0.0',
      '    version: 8.11.3',
      'devDependencies:',
      '  vitest:',
      '    specifier: ^1.0.0',
      '    version: 1.0.0(@types/node@20.0.0)',
      'packages:',
      '  /pg@8.11.3:',
      '    dependencies:',
      '      pg-pool: 3.6.0(pg@8.11.3)',
      '    dev: false',
      '  /pg-pool@3.6.0(pg@8.11.3):',
      '    dev: false',
      '  /vitest@1.0.0(@types/node@20.0.0):',
      '    dependencies:',
      "      '@vitest/runner': 1.0.0",
      '    dev: true',
      '  /@vitest/runner@1.0.0:',
      '    dev: true',
    ].join('\n'));
    expect(sorted(v6.dev)).toEqual([['@vitest/runner', true], ['pg', false], ['pg-pool', false], ['vitest', true]]);
    const v5 = parsePnpmLock([
      'lockfileVersion: 5.4',
      'specifiers:',
      '  pg: ^8.0.0',
      'dependencies:',
      '  pg: 8.11.3',
      'devDependencies:',
      '  jest: 29.0.0',
      'packages:',
      '  /pg/8.11.3:',
      '    dependencies:',
      '      pg-pool: 3.6.0_pg@8.11.3',
      '  /pg-pool/3.6.0_pg@8.11.3:',
      '    dev: false',
      '  /jest/29.0.0:',
      '    dependencies:',
      '      \'@jest/core\': 29.0.0',
      '  /@jest/core/29.0.0:',
      '    dev: true',
    ].join('\n'));
    expect(sorted(v5.dev)).toEqual([['@jest/core', true], ['jest', true], ['pg', false], ['pg-pool', false]]);
  });

  it('yarn v1 and Berry: the graph rooted at the manifests; workspace entries are no packages', () => {
    const roots = [{ prod: new Set(['express']), dev: new Set(['eslint']) }];
    const v1 = parseYarnLock([
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
      '# yarn lockfile v1',
      '',
      'express@^4.0.0, express@^4.19.0:',
      '  version "4.19.2"',
      '  dependencies:',
      '    debug "2.6.9"',
      '',
      '"@acme/x@^1.0.0":',
      '  version "1.0.0"',
      '',
      'debug@2.6.9:',
      '  version "2.6.9"',
      '',
      'eslint@^8.0.0:',
      '  version "8.57.0"',
      '  dependencies:',
      '    "@acme/x" "^1.0.0"',
      '    semver "^7.6.0"',
      '',
      'semver@^7.6.0:',
      '  version "7.6.3"',
    ].join('\n'), roots);
    expect(sorted(v1.dev)).toEqual([['@acme/x', true], ['debug', false], ['eslint', true], ['express', false], ['semver', true]]);
    const berry = parseYarnLock([
      '__metadata:',
      '  version: 8',
      '',
      '"express@npm:^4.0.0":',
      '  version: 4.19.2',
      '  dependencies:',
      '    debug: "npm:2.6.9"',
      '',
      '"debug@npm:2.6.9":',
      '  version: 2.6.9',
      '',
      '"eslint@npm:^8.0.0":',
      '  version: 8.57.0',
      '  dependencies:',
      '    "@acme/x": "npm:^1.0.0"',
      '',
      '"@acme/x@npm:^1.0.0":',
      '  version: 1.0.0',
      '',
      '"root@workspace:.":',
      '  version: 0.0.0-use.local',
      '  dependencies:',
      '    express: "npm:^4.0.0"',
    ].join('\n'), roots);
    expect(sorted(berry.dev)).toEqual([['@acme/x', true], ['debug', false], ['eslint', true], ['express', false]]);
  });

  // Review of M5-20: an `npm:` alias stands for its real package in the roots and the edges.
  it('pnpm: an npm: alias is its real package, in an importer (v9, v5) and as a dependency', () => {
    const v9 = parsePnpmLock([
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      alias:',
      '        specifier: npm:real@^1',
      '        version: real@1.0.0',
      '    devDependencies:',
      '      tool:',
      '        specifier: ^1.0.0',
      '        version: 1.0.0',
      'packages:',
      '  real@1.0.0:',
      '    resolution: {integrity: a}',
      '  realdep@1.0.0:',
      '    resolution: {integrity: b}',
      '  tool@1.0.0:',
      '    resolution: {integrity: c}',
      '  inner@2.0.0:',
      '    resolution: {integrity: d}',
      'snapshots:',
      '  real@1.0.0:',
      '    dependencies:',
      '      realdep: 1.0.0',
      '  realdep@1.0.0: {}',
      '  tool@1.0.0:',
      '    dependencies:',
      '      dalias: inner@2.0.0',
      '  inner@2.0.0: {}',
    ].join('\n'));
    expect(sorted(v9.dev)).toEqual([['inner', true], ['real', false], ['realdep', false], ['tool', true]]);
    const v5 = parsePnpmLock(['lockfileVersion: 5.4', 'dependencies:', '  alias: /real/1.0.0', 'packages:', '  /real/1.0.0:', '    dev: false'].join('\n'));
    expect(sorted(v5.dev)).toEqual([['real', false]]);
  });

  it('throws on text that is no lockfile (read as unreadable)', () => {
    expect(() => parsePackageLock('{not json')).toThrow();
    expect(() => parsePackageLock('[]')).toThrow();
    expect(() => parsePnpmLock('{{{ garbage')).toThrow();
    expect(() => parseYarnLock('garbage', [])).toThrow();
  });
});

/** The attribution of each npm row: `file:line specifier symbol kind → package origin direct dev attribution`. */
const npmAttribution = (store: Store) => store.getExternalRefs().filter((r) => r.ecosystem === 'npm')
  .map((r) => `${r.file_path}:${r.line} ${r.specifier} ${r.symbol} ${r.kind} → ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`).sort();

// The importing file and its manifests: `pg` a dependency, `vitest` a dev dependency, `debug` reached
// through express (production), `semver` through vitest (dev), `left-pad` nowhere.
const NPM_SOURCE = [
  "import { Pool } from 'pg';",
  "import { describe } from 'vitest';",
  "import debug from 'debug';",
  "import { satisfies } from 'semver';",
  "import pad from 'left-pad';",
  "import { readFile } from 'node:fs/promises';",
  'export const run = () => 1;',
  '',
].join('\n');
const NPM_MANIFEST = JSON.stringify({ name: 'app', dependencies: { pg: '^8.0.0', express: '^4.0.0' }, devDependencies: { vitest: '^1.0.0' } });
const PACKAGE_LOCK = JSON.stringify({
  name: 'app', lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/pg': { version: '8.11.3' },
    'node_modules/express': { version: '4.19.2' },
    'node_modules/debug': { version: '2.6.9' },
    'node_modules/vitest': { version: '1.0.0', dev: true },
    'node_modules/semver': { version: '7.6.3', dev: true },
  },
});
/** The rows of NPM_SOURCE at `file`, attributed with or without a lockfile. */
const attributed = (file: string, by: 'lock' | 'manifest') => [
  `${file}:1 pg Pool import → pg package 1 0 ${by}`,
  `${file}:2 vitest describe import → vitest package 1 1 ${by}`,
  `${file}:3 debug default import → debug package 0 ${by === 'lock' ? 0 : null} ${by}`,
  `${file}:4 semver satisfies import → semver package 0 ${by === 'lock' ? 1 : null} ${by}`,
  `${file}:5 left-pad default import → left-pad package 0 null ${by}`,
  `${file}:6 node:fs/promises readFile import → node:fs builtin null null null`,
];

describe('npm attribution of a scan', () => {
  const p = project(false);
  afterEach(() => p.remove());
  const scan = async (files: Record<string, string>) => {
    p.create(files);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    return npmAttribution(store);
  };

  it('a package-lock: direct, transitive, dev-only, unlisted and built-in', async () => {
    expect(await scan({ 'package.json': NPM_MANIFEST, 'package-lock.json': PACKAGE_LOCK, 'src/a.ts': NPM_SOURCE })).toEqual(attributed('src/a.ts', 'lock'));
  }, 120000);

  it('a pnpm monorepo: the package manifest, the root manifest and the root lockfile', async () => {
    const refs = await scan({
      'package.json': JSON.stringify({ name: 'root', private: true, devDependencies: { vitest: '^1.0.0' } }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    devDependencies:',
        '      vitest:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '  packages/app:',
        '    dependencies:',
        '      pg:',
        '        specifier: ^8.0.0',
        '        version: 8.11.3',
        '      express:',
        '        specifier: ^4.0.0',
        '        version: 4.19.2',
        'packages:',
        '  pg@8.11.3:',
        '    resolution: {integrity: a}',
        '  express@4.19.2:',
        '    resolution: {integrity: b}',
        '  debug@2.6.9:',
        '    resolution: {integrity: c}',
        '  vitest@1.0.0:',
        '    resolution: {integrity: d}',
        '  semver@7.6.3:',
        '    resolution: {integrity: e}',
        'snapshots:',
        '  pg@8.11.3: {}',
        '  express@4.19.2:',
        '    dependencies:',
        '      debug: 2.6.9',
        '  debug@2.6.9: {}',
        '  vitest@1.0.0:',
        '    dependencies:',
        '      semver: 7.6.3',
        '  semver@7.6.3: {}',
      ].join('\n'),
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { pg: '^8.0.0', express: '^4.0.0' } }),
      'packages/app/src/a.ts': NPM_SOURCE,
    });
    expect(refs).toEqual(attributed('packages/app/src/a.ts', 'lock'));
  }, 120000);

  it('a yarn lock: transitive dev-ness from the workspace manifests', async () => {
    const lock = [
      '# yarn lockfile v1',
      '',
      'pg@^8.0.0:',
      '  version "8.11.3"',
      'express@^4.0.0:',
      '  version "4.19.2"',
      '  dependencies:',
      '    debug "2.6.9"',
      'debug@2.6.9:',
      '  version "2.6.9"',
      'vitest@^1.0.0:',
      '  version "1.0.0"',
      '  dependencies:',
      '    semver "^7.6.0"',
      'semver@^7.6.0:',
      '  version "7.6.3"',
    ].join('\n');
    expect(await scan({ 'package.json': NPM_MANIFEST, 'yarn.lock': lock, 'src/a.ts': NPM_SOURCE })).toEqual(attributed('src/a.ts', 'lock'));
  }, 120000);

  it('no lockfile: direct from the manifest only, flagged manifest', async () => {
    expect(await scan({ 'package.json': NPM_MANIFEST, 'src/a.ts': NPM_SOURCE })).toEqual(attributed('src/a.ts', 'manifest'));
  }, 120000);

  it.each([
    ['a corrupt package-lock.json', { 'package-lock.json': '{"lockfileVersion": 3, "packages": {' }],
    ['a corrupt pnpm-lock.yaml', { 'pnpm-lock.yaml': '\u0000\u0001 not yaml {{{' }],
    ['a package-lock.json that is a folder', { 'package-lock.json/x.txt': 'x' }],
  ])('%s: direct from the manifest only, flagged manifest, no crash', async (_name, extra) => {
    expect(await scan({ 'package.json': NPM_MANIFEST, 'src/a.ts': NPM_SOURCE, ...extra })).toEqual(attributed('src/a.ts', 'manifest'));
  }, 120000);

  // Review of M5-20: with a lockfile, so the result shows the corrupt manifest is skipped and the
  // higher manifest and the lockfile still answer.
  it('a corrupt package.json nearer the file: skipped; the higher manifest and the lockfile answer', async () => {
    expect(await scan({ 'package.json': NPM_MANIFEST, 'package-lock.json': PACKAGE_LOCK, 'src/package.json': '{ broken', 'src/a.ts': NPM_SOURCE }))
      .toEqual(attributed('src/a.ts', 'lock'));
  }, 120000);

  // M5-20-R1 (found by M5-21): a nested lockfile that is there but cannot be read ends the walk, as a
  // corrupt one does; the nested package's manifests answer, never the root folder's lockfile.
  const NESTED = { 'package.json': JSON.stringify({ name: 'root', private: true }), 'package-lock.json': PACKAGE_LOCK, 'packages/app/package.json': NPM_MANIFEST, 'packages/app/src/a.ts': NPM_SOURCE };
  it.each([
    ['a folder', { 'packages/app/package-lock.json/x.txt': 'x' }],
    ['a file it cannot read', { 'packages/app/package-lock.json': PACKAGE_LOCK }],
  ])('a nested package-lock.json that is %s: the nested package.json alone, flagged manifest, never the root lock', async (name, extra) => {
    // Root can read a file without permission: the case holds only for another user.
    if (name !== 'a folder' && process.getuid?.() === 0) return;
    p.create({ ...NESTED, ...extra });
    if (name !== 'a folder') chmodSync(join(p.root, 'packages/app/package-lock.json'), 0o000);
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      expect(npmAttribution(store)).toEqual(attributed('packages/app/src/a.ts', 'manifest'));
    } finally {
      if (name !== 'a folder') chmodSync(join(p.root, 'packages/app/package-lock.json'), 0o644);
    }
  }, 120000);

  it('a nested package.json without a lockfile: the root folder\'s lockfile answers', async () => {
    expect(await scan(NESTED)).toEqual(attributed('packages/app/src/a.ts', 'lock'));
  }, 120000);

  // Review of M5-20 (owner's decision): a bare built-in name the nearest manifest lists is that npm
  // package (a polyfill); a `node:` specifier is always the built-in.
  it('a polyfill the nearest manifest lists is the npm package; node: and unlisted names are built-ins', async () => {
    expect(await scan({
      'package.json': JSON.stringify({ name: 'app', dependencies: { buffer: '^6.0.0', events: '^3.0.0' }, devDependencies: { util: '^0.12.0' } }),
      'src/a.ts': "import 'buffer';\nimport 'node:buffer';\nimport 'events';\nimport 'util';\nimport 'fs';\nimport 'node:events';\n",
      'lib/package.json': JSON.stringify({ name: 'lib' }),
      'lib/b.ts': "import 'buffer';\n",
    })).toEqual([
      'lib/b.ts:1 buffer null import → node:buffer builtin null null null',
      'src/a.ts:1 buffer null import → buffer package 1 0 manifest',
      'src/a.ts:2 node:buffer null import → node:buffer builtin null null null',
      'src/a.ts:3 events null import → events package 1 0 manifest',
      'src/a.ts:4 util null import → util package 1 1 manifest',
      'src/a.ts:5 fs null import → node:fs builtin null null null',
      'src/a.ts:6 node:events null import → node:events builtin null null null',
    ]);
  }, 120000);

  it('attributes nothing for a row the workspace satisfies, and only npm rows', async () => {
    const refs = await scan({
      'package.json': NPM_MANIFEST,
      'package-lock.json': PACKAGE_LOCK,
      'src/a.ts': "import { Pool } from 'pg';\nexport const p = () => new Pool();\n",
      'main.py': 'import os\n',
    });
    expect(refs).toEqual([
      'src/a.ts:1 pg Pool import → pg package 1 0 lock',
      'src/a.ts:2 pg Pool instantiation → pg package 1 0 lock',
    ]);
  }, 120000);
});

// Sync = scan --force when what attributes changes: manifests and lockfiles are read again by every run.
const ATTRIBUTION_CHANGES: Array<{ name: string; change: Record<string, string | null>; expect: string }> = [
  {
    name: 'a dependency moves to devDependencies',
    change: { 'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0' }, devDependencies: { vitest: '^1.0.0', pg: '^8.0.0' } }) },
    expect: 'src/a.ts:1 pg Pool import → pg package 1 1 lock',
  },
  {
    name: 'the lockfile is deleted',
    change: { 'package-lock.json': null },
    expect: 'src/a.ts:3 debug default import → debug package 0 null manifest',
  },
  {
    name: 'the lockfile is edited: a transitive package becomes dev-only',
    change: { 'package-lock.json': PACKAGE_LOCK.replace('"node_modules/debug":{"version":"2.6.9"}', '"node_modules/debug":{"version":"2.6.9","dev":true}') },
    expect: 'src/a.ts:3 debug default import → debug package 0 1 lock',
  },
  {
    name: 'the lockfile is corrupted',
    change: { 'package-lock.json': '{ corrupt' },
    expect: 'src/a.ts:4 semver satisfies import → semver package 0 null manifest',
  },
  {
    name: 'a nearer package.json lists a transitive package',
    change: { 'src/package.json': JSON.stringify({ name: 'inner', devDependencies: { debug: '^2.0.0' } }) },
    expect: 'src/a.ts:3 debug default import → debug package 1 1 lock',
  },
];

describe.each([['git sync', true], ['hash sync', false]] as const)('a %s, when a manifest or lockfile changes', (_name, withGit) => {
  const p = project(withGit);
  afterEach(() => p.remove());

  it.each(ATTRIBUTION_CHANGES)('$name: equal to scan --force', async ({ change, expect: expected }) => {
    p.create({ 'package.json': NPM_MANIFEST, 'package-lock.json': PACKAGE_LOCK, 'src/a.ts': NPM_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    expect(npmAttribution(store)).toEqual(attributed('src/a.ts', 'lock'));
    write(p.root, change);
    if (withGit) {
      git(p.root, 'add', '-A');
      git(p.root, 'commit', '-qm', 'change');
    }
    await p.sync(store);
    const forced = await p.forced();
    expect(dumpAll(store)).toEqual(dumpAll(forced));
    expect(npmAttribution(forced)).toContain(expected);
  }, 120000);

  // Review of M5-20-R1: an unreadable lock is recorded as such, so removing it is a change.
  it.each(['a folder', 'a file it cannot read'])('a nested package-lock.json that is %s is removed: the root lock answers, as scan --force', async (name) => {
    if (name !== 'a folder' && process.getuid?.() === 0) return;
    const lock = 'packages/app/package-lock.json';
    const nested = { 'package.json': JSON.stringify({ name: 'root', private: true }), 'package-lock.json': PACKAGE_LOCK, 'packages/app/package.json': NPM_MANIFEST, 'packages/app/src/a.ts': NPM_SOURCE };
    p.create({ ...nested, ...(name === 'a folder' ? { [`${lock}/x.txt`]: 'x' } : { [lock]: PACKAGE_LOCK }) });
    if (name !== 'a folder') chmodSync(join(p.root, lock), 0o000);
    const store = new Store(':memory:');
    try {
      await (await p.scanner(store)).scanFull();
      expect(npmAttribution(store)).toEqual(attributed('packages/app/src/a.ts', 'manifest'));
      // Left as it is, the unreadable lock is no change.
      expect(changedInputFiles(p.root, parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY))!)).toEqual([]);
    } finally {
      if (name !== 'a folder') chmodSync(join(p.root, lock), 0o644);
    }
    rmSync(join(p.root, lock), { recursive: true, force: true });
    if (withGit) {
      git(p.root, 'add', '-A');
      git(p.root, 'commit', '-qm', 'remove');
    }
    await p.sync(store);
    expect(npmAttribution(store)).toEqual(attributed('packages/app/src/a.ts', 'lock'));
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
  }, 120000);

  it('fills the attribution of an index M5-19 built (null columns), without --force', async () => {
    p.create({ 'package.json': NPM_MANIFEST, 'package-lock.json': PACKAGE_LOCK, 'src/a.ts': NPM_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    store.raw.exec('UPDATE external_ref_candidates SET package = NULL, origin = NULL, direct = NULL, dev = NULL, attribution = NULL');
    await p.sync(store);
    expect(npmAttribution(store)).toEqual(attributed('src/a.ts', 'lock'));
  }, 120000);
});

// ─── Review of M5-20 ────────────────────────────────────────────────────────────────────────

/** The npm import rows of a CLI-scanned index, with their attribution. */
const cliAttribution = (root: string) => query<{ file_path: string; specifier: string; package: string; origin: string; direct: number | null; dev: number | null; attribution: string | null }>(
  root, "SELECT file_path, specifier, package, origin, direct, dev, attribution FROM external_refs WHERE ecosystem = 'npm' AND kind = 'import'")
  .map((r) => `${r.file_path} ${r.specifier} → ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`).sort();

describe('npm attribution of a sibling repo (review of M5-20, P1)', () => {
  it('reads only its own repo\'s manifests and lockfile: never the primary repo\'s or a parent folder\'s', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mapx-extrefs-repos-'));
    try {
      write(parent, {
        // The folder above both repos lists `fromparent`; the primary repo W lists `pg` as dev and
        // locks `pg` and `fromparent`; the sibling R lists `express`, has no lockfile, and imports all three.
        'package.json': JSON.stringify({ name: 'parent', dependencies: { fromparent: '^1.0.0' } }),
        'W/package.json': JSON.stringify({ name: 'w', devDependencies: { pg: '^8.0.0' } }),
        'W/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
          '': { name: 'w' }, 'node_modules/pg': { version: '8.11.3', dev: true }, 'node_modules/fromparent': { version: '1.0.0' },
        } }),
        'W/src/w.ts': "import { Pool } from 'pg';\nexport const w = () => new Pool();\n",
        'R/package.json': JSON.stringify({ name: 'r', dependencies: { express: '^4.0.0' } }),
        'R/src/x.ts': "import { Pool } from 'pg';\nimport express from 'express';\nimport fromparent from 'fromparent';\nexport const x = () => [Pool, express, fromparent];\n",
      });
      const w = join(parent, 'W');
      execFileSync('git', ['init', '-q', w]);
      execFileSync('git', ['init', '-q', join(parent, 'R')]);
      init(w);
      mapx(w, 'workspaces', 'add', '../R');
      mapx(w, 'scan');
      expect(cliAttribution(w)).toEqual([
        '../R/src/x.ts express → express package 1 0 manifest',
        '../R/src/x.ts fromparent → fromparent package 0 null manifest',
        '../R/src/x.ts pg → pg package 0 null manifest',
        'src/w.ts pg → pg package 1 1 lock',
      ]);
    } finally {
      cleanup(parent);
    }
  }, 180000);
});

describe('a manifest or lockfile change makes the index stale (review of M5-20, P2)', () => {
  it('mapx status reports it, check refuses it, check --sync re-attributes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mapx-extrefs-stale-'));
    try {
      write(root, { 'package.json': NPM_MANIFEST, 'package-lock.json': PACKAGE_LOCK, 'src/a.ts': NPM_SOURCE });
      init(root);
      write(root, { '.mapx/architecture.jsonc': JSON.stringify({ layers: [{ name: 'App', selectors: [{ path: 'src/**' }] }], rules: { App: [] } }) });
      mapx(root, 'scan');
      expect(mapx(root, 'status')).toContain('Index is up to date');
      expect(cliAttribution(root)).toContain('src/a.ts debug → debug package 0 0 lock');
      // Only the lockfile changes: debug becomes dev-only.
      write(root, { 'package-lock.json': PACKAGE_LOCK.replace('"node_modules/debug":{"version":"2.6.9"}', '"node_modules/debug":{"version":"2.6.9","dev":true}') });
      const status = mapx(root, 'status');
      expect(status).toContain('Index is stale');
      expect(status).toContain('package-lock.json');
      const refused = mapxResult(root, 'check');
      expect(refused.status).toBe(4);
      expect(refused.stderr).toContain('package-lock.json');
      expect(mapxResult(root, 'check', '--sync').status).toBe(0);
      expect(cliAttribution(root)).toContain('src/a.ts debug → debug package 0 1 lock');
      expect(mapx(root, 'status')).toContain('Index is up to date');
      // A manifest that appears nearer the file counts too.
      write(root, { 'src/package.json': JSON.stringify({ name: 'inner', dependencies: { debug: '^2.0.0' } }) });
      expect(mapx(root, 'status')).toContain('src/package.json');
      mapx(root, 'sync');
      expect(cliAttribution(root)).toContain('src/a.ts debug → debug package 1 0 lock');
      expect(mapx(root, 'status')).toContain('Index is up to date');
    } finally {
      cleanup(root);
    }
  }, 180000);
});

describe('a sync that changes nothing attribution reads (review of M5-20, P2)', () => {
  const p = project(false);
  afterEach(() => p.remove());

  it('keeps the stored attribution without reading a lockfile; attributes only new rows', async () => {
    p.create({ 'package.json': NPM_MANIFEST, 'package-lock.json': PACKAGE_LOCK, 'src/a.ts': NPM_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    // A marker in the stored attribution survives a sync that changes no manifest or lockfile.
    store.raw.exec("UPDATE external_ref_candidates SET attribution = 'kept' WHERE specifier = 'debug'");
    write(p.root, { 'src/b.ts': "import { Pool } from 'pg';\nexport const b = () => new Pool();\n" });
    await p.sync(store);
    const rows = npmAttribution(store);
    expect(rows).toContain('src/a.ts:3 debug default import → debug package 0 0 kept');
    expect(rows).toContain('src/b.ts:1 pg Pool import → pg package 1 0 lock');
    // A changed input (here only whitespace: its content hash differs) re-attributes all.
    write(p.root, { 'package.json': `${NPM_MANIFEST}\n` });
    await p.sync(store);
    expect(npmAttribution(store)).toEqual(npmAttribution(await p.forced()));
    expect(npmAttribution(store)).toContain('src/a.ts:3 debug default import → debug package 0 0 lock');
  }, 120000);

  it('re-attributes when a newly indexed folder adds a yarn lock\'s root, though no file it read changed', async () => {
    const lock = ['# yarn lockfile v1', '', 'pg@^8.0.0:', '  version "8.11.3"', 'vitest@^1.0.0:', '  version "1.0.0"', '  dependencies:', '    semver "^7.6.0"', 'semver@^7.6.0:', '  version "7.6.3"'].join('\n');
    p.create({ 'package.json': JSON.stringify({ name: 'app', dependencies: { pg: '^8.0.0' } }), 'yarn.lock': lock, 'src/a.ts': "import { satisfies } from 'semver';\nexport const s = () => satisfies('1.0.0', '^1');\n" });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    expect(npmAttribution(store)).toContain('src/a.ts:1 semver satisfies import → semver package 0 null lock');
    // packages/tool's manifest becomes a root once one of its files is indexed: semver is then dev-only.
    write(p.root, { 'packages/tool/package.json': JSON.stringify({ name: 'tool', devDependencies: { vitest: '^1.0.0' } }), 'packages/tool/index.ts': 'export const t = 1;\n' });
    await p.sync(store);
    expect(npmAttribution(store)).toEqual(npmAttribution(await p.forced()));
    expect(npmAttribution(store)).toContain('src/a.ts:1 semver satisfies import → semver package 0 1 lock');
  }, 120000);
});

// ─── M5-21: Composer package attribution and PHP built-ins ──────────────────────────────────

describe('PHP built-ins and Composer names', () => {
  it('maps built-in classes, functions and constants to their extension; PECL and user names are none', () => {
    expect(PHP_BUILTINS_SOURCE).toMatch(/reflection of PHP 8\.1\.\d+, 8\.2\.\d+, 8\.4\.\d+; php-src stubs of php-8\.3\.0, php-8\.4\.14, php-8\.5\.0/);
    expect(phpBuiltin('DateTime')).toBe('ext-date');
    expect(phpBuiltin('\\datetime', 'class')).toBe('ext-date');
    expect(phpBuiltin('PDO')).toBe('ext-pdo');
    expect(phpBuiltin('Exception')).toBe('ext-core');
    expect(phpBuiltin('ArrayObject')).toBe('ext-spl');
    expect(phpBuiltin('Random\\Randomizer')).toBe('ext-random');
    expect(phpBuiltin('str_contains', 'function')).toBe('ext-standard');
    expect(phpBuiltin('STRLEN', 'function')).toBe('ext-core');
    expect(phpBuiltin('json_encode', 'function')).toBe('ext-json');
    expect(phpBuiltin('array_find', 'function')).toBe('ext-standard');
    // Constants are case-sensitive (review of M5-21: `use const PHP_EOL`).
    expect(phpBuiltin('PHP_EOL', 'const')).toBe('ext-core');
    expect(phpBuiltin('JSON_THROW_ON_ERROR', 'const')).toBe('ext-json');
    expect(phpBuiltin('php_eol', 'const')).toBeNull();
    // A class is not a function or constant of the same name; PECL extensions and packages are not PHP's.
    expect(phpBuiltin('strlen', 'class')).toBeNull();
    expect(phpBuiltin('DateTime', 'function')).toBeNull();
    expect(phpBuiltin('PHP_EOL', 'class')).toBeNull();
    expect(phpBuiltin('Redis')).toBeNull();
    expect(phpBuiltin('xdebug_info', 'function')).toBeNull();
    expect(phpBuiltin('GuzzleHttp\\Client')).toBeNull();
    expect(phpBuiltin('collect', 'function')).toBeNull();
  });

  // Review of M5-21: bundled extensions no local build loads come from php-src's stubs.
  it('covers bundled extensions no reflected build loaded: gmp, pgsql, bz2, odbc, 8.4 Dom\\ and mbstring, 8.5 uri', () => {
    expect([
      phpBuiltin('mb_str_pad', 'function'), phpBuiltin('gmp_add', 'function'), phpBuiltin('GMP'), phpBuiltin('pg_connect', 'function'),
      phpBuiltin('PgSql\\Connection'), phpBuiltin('bzopen', 'function'), phpBuiltin('odbc_connect', 'function'), phpBuiltin('Dom\\HTMLDocument'),
      phpBuiltin('imap_open', 'function'), phpBuiltin('Pdo\\Mysql'), phpBuiltin('array_first', 'function'), phpBuiltin('Uri\\Rfc3986\\Uri'),
    ]).toEqual(['ext-mbstring', 'ext-gmp', 'ext-gmp', 'ext-pgsql', 'ext-pgsql', 'ext-bz2', 'ext-odbc', 'ext-dom', 'ext-imap', 'ext-pdo_mysql', 'ext-standard', 'ext-uri']);
  });

  // The list is static; when a PHP runs here, its bundled extensions' names must all be in it.
  const php = (() => { try { execFileSync('php', ['-v'], { stdio: 'pipe' }); return true; } catch { return false; } })();
  it.skipIf(!php)('lists every class, function and constant of the running PHP\'s bundled extensions', () => {
    const dump = JSON.parse(execFileSync('php', [resolve(__dirname, '../scripts/gen-php-builtins.php'), 'dump'], { encoding: 'utf8' })) as
      { extensions: Record<string, { classes?: string[]; functions?: string[]; constants?: string[] }> };
    const missing: string[] = [];
    for (const [ext, { classes = [], functions = [], constants = [] }] of Object.entries(dump.extensions)) {
      for (const c of classes) if (phpBuiltin(c, 'class') !== ext) missing.push(`${ext} class ${c}`);
      for (const f of functions) if (phpBuiltin(f, 'function') !== ext) missing.push(`${ext} function ${f}`);
      for (const k of constants) if (!phpBuiltin(k, 'const')) missing.push(`${ext} constant ${k}`);
    }
    expect(missing).toEqual([]);
  });

  // The generator reads php-src stubs with PHP's tokenizer: namespaces (braced or not), top-level
  // declarations only.
  it.skipIf(!php)('reads stub declarations: namespaced and braced blocks, never methods or ::class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mapx-php-stubs-'));
    try {
      write(dir, {
        'ext/dom/php_dom.stub.php': '<?php\nnamespace {\n  /** @var int */\n  const XML_ELEMENT_NODE = UNKNOWN;\n  class DOMNode { public function appendChild() {} const X = 1; }\n  function dom_import_simplexml(object $node): DOMElement {}\n  $x = DOMNode::class;\n}\nnamespace Dom {\n  final class HTMLDocument {}\n  enum AdjacentPosition: string {}\n  function import_simplexml(object $node): Element {}\n}\n',
        'ext/bz2/bz2.stub.php': '<?php\n/** @generate-class-entries */\nfunction bzopen($file, string $mode) {}\nfunction &byref() {}\n',
        'ext/zend_test/test.stub.php': '<?php\nfunction zend_test_func() {}\n',
      });
      const out = JSON.parse(execFileSync('php', [resolve(__dirname, '../scripts/gen-php-builtins.php'), 'stubs', 'php-9.9.9', dir], { encoding: 'utf8' }));
      expect(out.version).toBe('9.9.9');
      expect(out.extensions).toEqual({
        'ext-bz2': { functions: ['bzopen', 'byref'] },
        'ext-dom': { constants: ['XML_ELEMENT_NODE'], classes: ['DOMNode', 'Dom\\HTMLDocument', 'Dom\\AdjacentPosition'], functions: ['dom_import_simplexml', 'Dom\\import_simplexml'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('platform requirements are not packages; a name in require and require-dev is production', () => {
    const roots = composerRoots({
      require: { php: '^8.2', 'php-64bit': '*', hhvm: '*', 'ext-pdo': '*', 'ext-zend-opcache': '*', 'lib-icu': '*', composer: '^2', 'composer-plugin-api': '^2', 'composer-runtime-api': '^2', 'PSR/Log': '^3', 'php-http/client-common': '^2' },
      'require-dev': { 'phpunit/phpunit': '^10', 'php-http/client-common': '^2', 'ext-xdebug': '*' },
    });
    expect([...roots.prod].sort()).toEqual(['php-http/client-common', 'psr/log']);
    expect([...roots.dev]).toEqual(['phpunit/phpunit', 'php-http/client-common']);
  });

  it('names a package by Composer convention only when one requirement clearly matches', () => {
    const req = ['psr/log', 'nesbot/carbon', 'symfony/console', 'laravel/framework', 'guzzlehttp/guzzle', 'phpunit/phpunit'];
    expect(packageByConvention('Psr\\Log\\LoggerInterface', req)).toBe('psr/log');
    expect(packageByConvention('\\Carbon\\Carbon', req)).toBe('nesbot/carbon');
    expect(packageByConvention('Symfony\\Component\\Console\\Command\\Command', req)).toBe('symfony/console');
    expect(packageByConvention('PHPUnit\\Framework\\TestCase', req)).toBe('phpunit/phpunit');
    // No convention: Illuminate is laravel/framework's, GuzzleHttp names no package; a global name none.
    expect(packageByConvention('Illuminate\\Support\\Collection', req)).toBeNull();
    expect(packageByConvention('GuzzleHttp\\Client', req)).toBeNull();
    expect(packageByConvention('Carbon', req)).toBeNull();
    // A tie names none.
    expect(packageByConvention('Carbon\\Carbon', ['nesbot/carbon', 'other/carbon'])).toBeNull();
  });
});

const COMPOSER_LOCK = JSON.stringify({
  packages: [
    { name: 'guzzlehttp/guzzle', version: '7.8.1', autoload: { 'psr-4': { 'GuzzleHttp\\': 'src/' } } },
    { name: 'guzzlehttp/psr7', version: '2.6.2', autoload: { 'psr-4': { 'GuzzleHttp\\Psr7\\': 'src/' } } },
    { name: 'psr/log', version: '3.0.0', autoload: { 'psr-4': { 'Psr\\Log\\': 'src' } } },
    { name: 'nesbot/carbon', version: '2.72.3', autoload: { 'psr-4': { 'Carbon\\': 'src/Carbon/' } } },
    { name: 'mustache/mustache', version: 'v2.14.2', autoload: { 'psr-0': { Mustache: 'src/' } } },
  ],
  'packages-dev': [
    { name: 'fakerphp/faker', version: 'v1.23.1', autoload: { 'psr-4': { 'Faker\\': 'src/Faker/' } } },
    { name: 'doctrine/instantiator', version: '2.0.0', autoload: { 'psr-4': { 'Doctrine\\Instantiator\\': 'src/Doctrine/Instantiator/' } } },
  ],
});

describe('composer.lock', () => {
  it('reads production and dev packages, PSR-4 and PSR-0 prefixes (longest first), and opaque packages', () => {
    const lock = parseComposerLock(JSON.stringify({
      packages: [
        { name: 'Acme/Both', autoload: { 'psr-4': { 'Acme\\Both\\': 'src/' } } },
        { name: 'acme/opaque', autoload: { classmap: ['src/'], files: ['f.php'] } },
        { name: 'acme/fallback', autoload: { 'psr-4': { '': 'src/' } } },
        { name: 'acme/meta', type: 'metapackage' },
      ],
      'packages-dev': [{ name: 'acme/both', autoload: {} }, { name: 'acme/tool', autoload: { 'psr-0': { Tool_: 'lib/' } } }],
    }));
    expect([...lock.dev]).toEqual([['acme/both', false], ['acme/opaque', false], ['acme/fallback', false], ['acme/meta', false], ['acme/tool', true]]);
    expect(lock.opaque).toEqual(['acme/fallback', 'acme/opaque']);
    expect(lock.prefixes.map((p) => p.prefix)).toEqual(['acme\\both\\', 'tool_']);
    const full = parseComposerLock(COMPOSER_LOCK);
    expect(lockPackagesOf(full, 'GuzzleHttp\\Psr7\\Utils', false)).toEqual(['guzzlehttp/psr7']);
    expect(lockPackagesOf(full, 'guzzlehttp\\client', false)).toEqual(['guzzlehttp/guzzle']);
    expect(lockPackagesOf(full, 'Mustache_Engine', false)).toEqual(['mustache/mustache']);
    expect(lockPackagesOf(full, 'GuzzleHttp\\Psr7\\str', true)).toEqual(['guzzlehttp/psr7']);
    // A global function shows no package, though a PSR-0 prefix spells its start.
    expect(lockPackagesOf(full, 'Mustache_render', true)).toEqual([]);
    expect(lockPackagesOf(full, 'Acme\\Widget', false)).toEqual([]);
  });

  // Review of M5-21 (P1): sibling packages that register one prefix; `replace` and `provide`.
  it('keeps every package of a shared prefix, and what each package replaces or provides', () => {
    const lock = parseComposerLock(JSON.stringify({
      packages: [
        { name: 'illuminate/support', autoload: { 'psr-4': { 'Illuminate\\Support\\': '' } } },
        { name: 'illuminate/collections', autoload: { 'psr-4': { 'Illuminate\\Support\\': '' } } },
        { name: 'illuminate/macroable', autoload: { 'psr-4': { 'Illuminate\\Support\\': '' } } },
        { name: 'laravel/framework', autoload: { 'psr-4': { 'Illuminate\\': 'src/Illuminate/' } }, replace: { 'illuminate/bus': 'self.version' }, provide: { 'psr/container-implementation': '1.1' } },
      ],
    }));
    expect(lockPackagesOf(lock, 'Illuminate\\Support\\Str', false)).toEqual(['illuminate/collections', 'illuminate/macroable', 'illuminate/support']);
    expect(lockPackagesOf(lock, 'Illuminate\\Bus\\Dispatcher', false)).toEqual(['laravel/framework']);
    expect([...lock.provides.get('laravel/framework')!]).toEqual(['laravel/framework', 'illuminate/bus', 'psr/container-implementation']);
    expect(lock.satisfied.has('illuminate/bus')).toBe(true);
  });

  it('throws on text that is no Composer lock (read as unreadable)', () => {
    for (const text of ['{ broken', '{}', '[]', JSON.stringify({ lockfileVersion: 3, packages: {} })]) expect(() => parseComposerLock(text), text).toThrow();
  });

  it('attributes a facade as the class the file names; its target only when that class shows no package', () => {
    const files: Record<string, string> = {
      // illuminate/support repeated for dev: production wins.
      'composer.json': JSON.stringify({ require: { 'illuminate/support': '^11.0', 'illuminate/database': '^11.0' }, 'require-dev': { 'illuminate/support': '^11.0' } }),
      'composer.lock': JSON.stringify({ packages: [
        { name: 'illuminate/support', autoload: { 'psr-4': { 'Illuminate\\Support\\': '' } } },
        { name: 'illuminate/database', autoload: { 'psr-4': { 'Illuminate\\Database\\': '' } } },
      ] }),
    };
    const a = new ComposerAttributor({ readText: (p) => files[p] ?? null, repoRootOf: () => '' });
    const target = 'Illuminate\\Database\\DatabaseManager';
    expect(a.attribute('Illuminate\\Support\\Facades\\DB', 'routes/web.php', { facadeTarget: target })).toEqual({ package: 'illuminate/support', origin: 'package', direct: true, dev: false, attribution: 'lock' });
    expect(a.attribute('DB', 'routes/web.php', { facadeTarget: target })).toEqual({ package: 'illuminate/database', origin: 'package', direct: true, dev: false, attribution: 'lock' });
    expect(a.attribute('DB', 'routes/web.php')).toEqual({ package: null, origin: 'package', direct: false, dev: null, attribution: 'lock' });
    expect([...a.reads.keys()].sort()).toEqual(['composer.json', 'composer.lock', 'routes/composer.json', 'routes/composer.lock']);
  });
});

const composerAttribution = (store: Store) => store.getExternalRefs().filter((r) => r.ecosystem === 'composer')
  .map((r) => `${r.file_path}:${r.line} ${r.specifier} ${r.kind} → ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`).sort();

// `guzzlehttp/guzzle` and `psr/log` required, `fakerphp/faker` for dev; `nesbot/carbon` locked for
// production, `doctrine/instantiator` for dev; `Acme\Missing\Widget` in no package.
const COMPOSER_MANIFEST = JSON.stringify({
  name: 'acme/app',
  require: { php: '^8.2', 'ext-pdo': '*', 'guzzlehttp/guzzle': '^7.8', 'psr/log': '^3.0' },
  'require-dev': { 'fakerphp/faker': '^1.23' },
  autoload: { 'psr-4': { 'App\\': 'app/' } },
});
const PHP_SOURCE = [
  '<?php',
  'namespace App;',
  '',
  'use GuzzleHttp\\Client;',
  'use Psr\\Log\\LoggerInterface;',
  '',
  'class Gateway',
  '{',
  '    public function run(LoggerInterface $logger)',
  '    {',
  '        new Client();',
  '        \\Carbon\\Carbon::now();',
  '        \\Faker\\Factory::create();',
  '        new \\Doctrine\\Instantiator\\Instantiator();',
  '        new \\Acme\\Missing\\Widget();',
  '        new \\DateTime();',
  "        strlen('x');",
  '    }',
  '}',
  '',
].join('\n');
/** The rows of PHP_SOURCE at `file`, attributed with or without a lock. */
const composerAttributed = (file: string, by: 'lock' | 'manifest') => {
  const lock = by === 'lock';
  return [
    `${file}:11 GuzzleHttp\\Client instantiation → ${lock ? 'guzzlehttp/guzzle package 1 0' : 'null package null null'} ${by}`,
    `${file}:12 Carbon\\Carbon call → ${lock ? 'nesbot/carbon package 0 0' : 'null package null null'} ${by}`,
    `${file}:13 Faker\\Factory call → fakerphp/faker package 1 1 ${by}`,
    `${file}:14 Doctrine\\Instantiator\\Instantiator instantiation → ${lock ? 'doctrine/instantiator package 0 1' : 'null package null null'} ${by}`,
    `${file}:15 Acme\\Missing\\Widget instantiation → null package ${lock ? '0' : 'null'} null ${by}`,
    `${file}:16 DateTime instantiation → ext-date builtin null null null`,
    `${file}:17 strlen call → ext-core builtin null null null`,
    `${file}:4 GuzzleHttp\\Client import → ${lock ? 'guzzlehttp/guzzle package 1 0' : 'null package null null'} ${by}`,
    `${file}:5 Psr\\Log\\LoggerInterface import → psr/log package 1 0 ${by}`,
    `${file}:9 Psr\\Log\\LoggerInterface param_type → psr/log package 1 0 ${by}`,
  ];
};

describe('Composer attribution of a scan', () => {
  const p = project(false);
  afterEach(() => p.remove());
  const scan = async (files: Record<string, string>) => {
    p.create(files);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    return composerAttribution(store);
  };

  it('a composer.lock: direct, transitive, dev-only, not locked and built-in', async () => {
    expect(await scan({ 'composer.json': COMPOSER_MANIFEST, 'composer.lock': COMPOSER_LOCK, 'app/Gateway.php': PHP_SOURCE })).toEqual(composerAttributed('app/Gateway.php', 'lock'));
  }, 120000);

  it('no composer.lock: direct from the manifest by naming convention only, flagged manifest', async () => {
    expect(await scan({ 'composer.json': COMPOSER_MANIFEST, 'app/Gateway.php': PHP_SOURCE })).toEqual(composerAttributed('app/Gateway.php', 'manifest'));
  }, 120000);

  it.each([
    ['a corrupt composer.lock', { 'composer.lock': '{"packages": [' }],
    ['a composer.lock that is JSON but no lock', { 'composer.lock': '{"name": "acme/app"}' }],
    ['a composer.lock that is a folder', { 'composer.lock/x.txt': 'x' }],
  ])('%s: direct from the manifest only, flagged manifest, no crash', async (_name, extra) => {
    expect(await scan({ 'composer.json': COMPOSER_MANIFEST, 'app/Gateway.php': PHP_SOURCE, ...extra })).toEqual(composerAttributed('app/Gateway.php', 'manifest'));
  }, 120000);

  it('a classmap or files package: named by convention, else the package is unknown', async () => {
    const lock = JSON.stringify({
      packages: [{ name: 'laravel/framework', autoload: { files: ['src/Illuminate/Support/helpers.php'], 'psr-4': { 'Illuminate\\': 'src/Illuminate/' } } }],
      'packages-dev': [{ name: 'phpunit/phpunit', autoload: { classmap: ['src/'] } }],
    });
    expect(await scan({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' }, 'require-dev': { 'phpunit/phpunit': '^10.5' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      'composer.lock': lock,
      'app/T.php': '<?php\nnamespace App;\n\nclass T\n{\n    public function t()\n    {\n        \\PHPUnit\\Framework\\Assert::assertTrue(true);\n        collect([]);\n        new \\Acme\\Missing\\Widget();\n        new \\Illuminate\\Support\\Collection();\n    }\n}\n',
    })).toEqual([
      'app/T.php:10 Acme\\Missing\\Widget instantiation → null package null null lock',
      'app/T.php:11 Illuminate\\Support\\Collection instantiation → laravel/framework package 1 0 lock',
      'app/T.php:8 PHPUnit\\Framework\\Assert call → phpunit/phpunit package 1 1 lock',
      'app/T.php:9 collect call → null package null null lock',
    ]);
  }, 120000);

  // ─── Review of M5-21 ───

  it('sibling packages sharing a prefix: the one composer.json requires (prod, then dev), else unknown', async () => {
    const shared = (name: string, prefix: string) => ({ name, autoload: { 'psr-4': { [prefix]: 'src/' } } });
    expect(await scan({
      'composer.json': JSON.stringify({ require: { 'doctrine/event-manager': '^2.0', 'acme/twin-a': '^1', 'acme/twin-b': '^1', 'acme/mix-b': '^1' }, 'require-dev': { 'acme/tool-b': '^1', 'acme/mix-a': '^1' } }),
      'composer.lock': JSON.stringify({
        packages: [
          shared('illuminate/support', 'Illuminate\\Support\\'), shared('illuminate/collections', 'Illuminate\\Support\\'), shared('illuminate/macroable', 'Illuminate\\Support\\'),
          shared('doctrine/common', 'Doctrine\\Common\\'), shared('doctrine/event-manager', 'Doctrine\\Common\\'),
          shared('acme/twin-a', 'Acme\\Twin\\'), shared('acme/twin-b', 'Acme\\Twin\\'),
          shared('acme/mix-a', 'Acme\\Mix\\'), shared('acme/mix-b', 'Acme\\Mix\\'),
        ],
        'packages-dev': [shared('acme/tool-a', 'Acme\\Tool\\'), shared('acme/tool-b', 'Acme\\Tool\\')],
      }),
      'src/a.php': "<?php\n\\Illuminate\\Support\\Str::of('x');\nnew \\Doctrine\\Common\\EventManager();\nnew \\Acme\\Twin\\Thing();\nnew \\Acme\\Tool\\Thing();\nnew \\Acme\\Mix\\Thing();\n",
    })).toEqual([
      // None of the three is required: unknown. Both twins are: unknown. One for production beats one for dev.
      'src/a.php:2 Illuminate\\Support\\Str call → null package null null lock',
      'src/a.php:3 Doctrine\\Common\\EventManager instantiation → doctrine/event-manager package 1 0 lock',
      'src/a.php:4 Acme\\Twin\\Thing instantiation → null package null null lock',
      'src/a.php:5 Acme\\Tool\\Thing instantiation → acme/tool-b package 1 1 lock',
      'src/a.php:6 Acme\\Mix\\Thing instantiation → acme/mix-b package 1 0 lock',
    ]);
  }, 120000);

  it('use function and use const: built-in functions and constants, a namespaced function by its package', async () => {
    expect(await scan({
      'composer.json': COMPOSER_MANIFEST,
      'composer.lock': COMPOSER_LOCK,
      'app/F.php': '<?php\nnamespace App;\n\nuse function sprintf;\nuse function count;\nuse const PHP_EOL;\nuse function GuzzleHttp\\Psr7\\str;\nuse const Acme\\Lib\\VERSION;\n\nclass F {}\n',
    })).toEqual([
      'app/F.php:4 sprintf import → ext-standard builtin null null null',
      'app/F.php:5 count import → ext-standard builtin null null null',
      'app/F.php:6 PHP_EOL import → ext-core builtin null null null',
      'app/F.php:7 GuzzleHttp\\Psr7\\str import → guzzlehttp/psr7 package 0 0 lock',
      'app/F.php:8 Acme\\Lib\\VERSION import → null package 0 null lock',
    ]);
  }, 120000);

  it.each([
    ['a folder', { 'app/composer.lock/x.txt': 'x' }],
    ['a file it cannot read', { 'app/composer.lock': COMPOSER_LOCK }],
  ])('a nested composer.lock that is %s: the manifests alone, flagged manifest, never the parent lock', async (name, extra) => {
    // Root can read a file without permission: the case holds only for another user.
    if (name !== 'a folder' && process.getuid?.() === 0) return;
    p.create({ 'composer.json': COMPOSER_MANIFEST, 'composer.lock': COMPOSER_LOCK, 'app/Gateway.php': PHP_SOURCE, ...extra });
    if (name !== 'a folder') chmodSync(join(p.root, 'app/composer.lock'), 0o000);
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'manifest'));
    } finally {
      if (name !== 'a folder') chmodSync(join(p.root, 'app/composer.lock'), 0o644);
    }
  }, 120000);

  it('a stale lock that lacks a required package: that package from the manifest, flagged manifest', async () => {
    expect(await scan({
      'composer.json': JSON.stringify({ require: { 'acme/widgets': '^1', 'psr/log': '^3' } }),
      'composer.lock': JSON.stringify({ packages: [{ name: 'psr/log', autoload: { 'psr-4': { 'Psr\\Log\\': 'src' } } }] }),
      'src/a.php': "<?php\nnew \\Acme\\Widgets\\Gear();\nnew \\Psr\\Log\\NullLogger();\nnew \\Other\\Thing();\n",
    })).toEqual([
      'src/a.php:2 Acme\\Widgets\\Gear instantiation → acme/widgets package 1 0 manifest',
      'src/a.php:3 Psr\\Log\\NullLogger instantiation → psr/log package 1 0 lock',
      'src/a.php:4 Other\\Thing instantiation → null package null null manifest',
    ]);
  }, 120000);

  it('a locked package that replaces or provides a required name is direct', async () => {
    expect(await scan({
      'composer.json': JSON.stringify({ require: { 'illuminate/support': '^11' }, 'require-dev': { 'psr/log-implementation': '^3' } }),
      'composer.lock': JSON.stringify({
        packages: [{ name: 'laravel/framework', autoload: { 'psr-4': { 'Illuminate\\': 'src/Illuminate/' } }, replace: { 'illuminate/support': 'self.version' } }],
        'packages-dev': [{ name: 'monolog/monolog', autoload: { 'psr-4': { 'Monolog\\': 'src/Monolog' } }, provide: { 'psr/log-implementation': '3.0.0' } }],
      }),
      'src/a.php': "<?php\n\\Illuminate\\Support\\Str::of('x');\nnew \\Monolog\\Logger('x');\n",
    })).toEqual([
      'src/a.php:2 Illuminate\\Support\\Str call → laravel/framework package 1 0 lock',
      'src/a.php:3 Monolog\\Logger instantiation → monolog/monolog package 1 1 lock',
    ]);
  }, 120000);

  it('a facade under a global alias is attributed by its target class', async () => {
    const refs = await scan({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      'composer.lock': JSON.stringify({ packages: [{ name: 'laravel/framework', autoload: { 'psr-4': { 'Illuminate\\': 'src/Illuminate/' } } }] }),
      'routes/web.php': "<?php\n\nuse Illuminate\\Support\\Facades\\Cache;\n\nDB::table('users');\nCache::get('k');\n",
      // M5-19 (found in M5-21): `\Cache` is the global alias in a namespaced file too, never App\Http\Cache.
      'app/Http/C.php': "<?php\nnamespace App\\Http;\n\nclass C\n{\n    public function r()\n    {\n        \\Cache::get('k');\n    }\n}\n",
    });
    expect(refs).toEqual([
      'app/Http/C.php:8 Cache call → laravel/framework package 1 0 lock',
      'routes/web.php:3 Illuminate\\Support\\Facades\\Cache import → laravel/framework package 1 0 lock',
      'routes/web.php:5 DB call → laravel/framework package 1 0 lock',
      'routes/web.php:6 Illuminate\\Support\\Facades\\Cache call → laravel/framework package 1 0 lock',
    ]);
  }, 120000);
});

// Sync = scan --force when composer.json or composer.lock changes.
const LOCKED = JSON.parse(COMPOSER_LOCK) as { packages: Array<{ name: string }>; 'packages-dev': Array<{ name: string }> };
const COMPOSER_CHANGES: Array<{ name: string; change: Record<string, string | null>; expect: string }> = [
  {
    name: 'a dev requirement moves to require',
    change: { 'composer.json': COMPOSER_MANIFEST.replace('"require-dev":{"fakerphp/faker":"^1.23"}', '"require-dev":{}').replace('"psr/log":"^3.0"', '"psr/log":"^3.0","fakerphp/faker":"^1.23"') },
    expect: 'app/Gateway.php:13 Faker\\Factory call → fakerphp/faker package 1 0 lock',
  },
  {
    name: 'composer.lock is deleted',
    change: { 'composer.lock': null },
    expect: 'app/Gateway.php:12 Carbon\\Carbon call → null package null null manifest',
  },
  {
    name: 'composer.lock is edited: a transitive package becomes dev-only',
    change: { 'composer.lock': JSON.stringify({
      packages: LOCKED.packages.filter((x) => x.name !== 'nesbot/carbon'),
      'packages-dev': [...LOCKED['packages-dev'], ...LOCKED.packages.filter((x) => x.name === 'nesbot/carbon')],
    }) },
    expect: 'app/Gateway.php:12 Carbon\\Carbon call → nesbot/carbon package 0 1 lock',
  },
  {
    name: 'composer.lock is corrupted',
    change: { 'composer.lock': '{ corrupt' },
    expect: 'app/Gateway.php:14 Doctrine\\Instantiator\\Instantiator instantiation → null package null null manifest',
  },
  {
    name: 'a nearer composer.json requires a transitive package',
    change: { 'app/composer.json': JSON.stringify({ name: 'acme/inner', 'require-dev': { 'nesbot/carbon': '^2.72' } }) },
    expect: 'app/Gateway.php:12 Carbon\\Carbon call → nesbot/carbon package 1 1 lock',
  },
  {
    name: 'a nearer composer.json requires a dev package for production: the nearest wins',
    change: { 'app/composer.json': JSON.stringify({ name: 'acme/inner', require: { 'fakerphp/faker': '^1.23' } }) },
    expect: 'app/Gateway.php:13 Faker\\Factory call → fakerphp/faker package 1 0 lock',
  },
];

describe.each([['git sync', true], ['hash sync', false]] as const)('a %s, when composer.json or composer.lock changes', (_name, withGit) => {
  const p = project(withGit);
  afterEach(() => p.remove());
  const commit = (message: string) => {
    if (!withGit) return;
    git(p.root, 'add', '-A');
    git(p.root, 'commit', '-qm', message);
  };

  it.each(COMPOSER_CHANGES)('$name: equal to scan --force', async ({ change, expect: expected }) => {
    p.create({ 'composer.json': COMPOSER_MANIFEST, 'composer.lock': COMPOSER_LOCK, 'app/Gateway.php': PHP_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'lock'));
    write(p.root, change);
    commit('change');
    await p.sync(store);
    const forced = await p.forced();
    expect(dumpAll(store)).toEqual(dumpAll(forced));
    expect(composerAttribution(forced)).toContain(expected);
  }, 120000);

  // Review of M5-20-R1: an unreadable lock is recorded as such, so removing it is a change.
  it.each(['a folder', 'a file it cannot read'])('a nested composer.lock that is %s is removed: the root lock answers, as scan --force', async (name) => {
    if (name !== 'a folder' && process.getuid?.() === 0) return;
    const lock = 'app/composer.lock';
    p.create({ 'composer.json': COMPOSER_MANIFEST, 'composer.lock': COMPOSER_LOCK, 'app/Gateway.php': PHP_SOURCE, ...(name === 'a folder' ? { [`${lock}/x.txt`]: 'x' } : { [lock]: COMPOSER_LOCK }) });
    if (name !== 'a folder') chmodSync(join(p.root, lock), 0o000);
    const store = new Store(':memory:');
    try {
      await (await p.scanner(store)).scanFull();
      expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'manifest'));
      expect(changedInputFiles(p.root, parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY))!)).toEqual([]);
    } finally {
      if (name !== 'a folder') chmodSync(join(p.root, lock), 0o644);
    }
    rmSync(join(p.root, lock), { recursive: true, force: true });
    commit('remove');
    await p.sync(store);
    expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'lock'));
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
  }, 120000);

  it('keeps the stored Composer attribution when nothing it read changed; a lock edit re-attributes', async () => {
    p.create({ 'composer.json': COMPOSER_MANIFEST, 'composer.lock': COMPOSER_LOCK, 'app/Gateway.php': PHP_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    store.raw.exec("UPDATE external_ref_candidates SET attribution = 'kept' WHERE specifier = 'Carbon\\Carbon'");
    write(p.root, { 'app/Other.php': '<?php\nnamespace App;\n\nclass Other\n{\n    public function o()\n    {\n        \\Faker\\Factory::create();\n    }\n}\n' });
    commit('add');
    await p.sync(store);
    expect(composerAttribution(store)).toContain('app/Gateway.php:12 Carbon\\Carbon call → nesbot/carbon package 0 0 kept');
    expect(composerAttribution(store)).toContain('app/Other.php:8 Faker\\Factory call → fakerphp/faker package 1 1 lock');
    write(p.root, { 'composer.lock': `${COMPOSER_LOCK}\n` });
    commit('lock');
    await p.sync(store);
    expect(composerAttribution(store)).toEqual(composerAttribution(await p.forced()));
    expect(composerAttribution(store)).toContain('app/Gateway.php:12 Carbon\\Carbon call → nesbot/carbon package 0 0 lock');
  }, 120000);
});

describe('Composer attribution through the CLI', () => {
  it('a sibling repo reads only its own composer.json and lock; a lock-only change makes the index stale', () => {
    const parent = mkdtempSync(join(tmpdir(), 'mapx-extrefs-composer-'));
    try {
      write(parent, {
        // Above both repos: a composer.json requiring nesbot/carbon. W locks psr/log and carbon; R
        // requires psr/log, has no lock, and uses both.
        'composer.json': JSON.stringify({ require: { 'nesbot/carbon': '^2.72' } }),
        'W/composer.json': COMPOSER_MANIFEST,
        'W/composer.lock': COMPOSER_LOCK,
        'W/app/Gateway.php': PHP_SOURCE,
        'R/composer.json': JSON.stringify({ require: { 'psr/log': '^3.0' }, autoload: { 'psr-4': { 'Lib\\': 'src/' } } }),
        'R/src/X.php': '<?php\nnamespace Lib;\n\nuse Psr\\Log\\LoggerInterface;\nuse Carbon\\Carbon;\n\nclass X {}\n',
      });
      const w = join(parent, 'W');
      execFileSync('git', ['init', '-q', w]);
      execFileSync('git', ['init', '-q', join(parent, 'R')]);
      init(w);
      git(w, 'add', '-A');
      git(w, 'commit', '-qm', 'init');
      mapx(w, 'workspaces', 'add', '../R');
      mapx(w, 'scan');
      const imports = () => query<{ file_path: string; specifier: string; package: string | null; direct: number | null; dev: number | null; attribution: string | null }>(
        w, "SELECT file_path, specifier, package, direct, dev, attribution FROM external_refs WHERE ecosystem = 'composer' AND kind = 'import'")
        .map((r) => `${r.file_path} ${r.specifier} → ${r.package} ${r.direct} ${r.dev} ${r.attribution}`).sort();
      expect(imports()).toEqual([
        '../R/src/X.php Carbon\\Carbon → null null null manifest',
        '../R/src/X.php Psr\\Log\\LoggerInterface → psr/log 1 0 manifest',
        'app/Gateway.php GuzzleHttp\\Client → guzzlehttp/guzzle 1 0 lock',
        'app/Gateway.php Psr\\Log\\LoggerInterface → psr/log 1 0 lock',
      ]);
      expect(mapx(w, 'status')).toContain('Index is up to date');
      // Only the lock changes: the package that loads GuzzleHttp\ is now one composer.json does not require.
      write(w, { 'composer.lock': COMPOSER_LOCK.replace('"name":"guzzlehttp/guzzle"', '"name":"guzzlehttp/guzzle-fork"') });
      const status = mapx(w, 'status');
      expect(status).toContain('Index is stale');
      expect(status).toContain('composer.lock');
      mapx(w, 'sync');
      expect(imports()).toContain('app/Gateway.php GuzzleHttp\\Client → guzzlehttp/guzzle-fork 0 0 lock');
      expect(mapx(w, 'status')).toContain('Index is up to date');
    } finally {
      cleanup(parent);
    }
  }, 180000);
});
