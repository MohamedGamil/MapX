import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Scanner } from '../src/core/scanner.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import { extractorVersionKey } from '../src/core/extractor-version.js';
import { jsImports } from '../src/core/external-refs.js';
import { cleanup, init, mapx, query } from './helpers/e2e';

// M5-19: references to modules, packages, classes and functions outside the workspace are kept apart
// from edges; whether a candidate is external is decided again at the end of every scan and sync, so
// sync keeps external_refs equal to scan --force (docs/baton/iterations/M5-19.md and its review).

const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');

interface Label { app: string; file: string; line: number; sourceSymbol: string | null; specifier: string; symbol: string | null; kind: string; ecosystem: string }
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
    const rows = query<{ file_path: string; line: number; source_symbol: string | null; specifier: string; symbol: string | null; kind: string; ecosystem: string }>(
      root, 'SELECT file_path, line, source_symbol, specifier, symbol, kind, ecosystem FROM external_refs')
      .map((r) => ({ file: r.file_path, line: r.line, sourceSymbol: r.source_symbol, specifier: r.specifier, symbol: r.symbol, kind: r.kind, ecosystem: r.ecosystem }));
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
    expect(dumpRefs(store)).toEqual(dumpRefs(fresh));
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
    expect(dumpRefs(store)).toEqual(dumpRefs(await p.forced()));
  }, 120000);

  it('fills external_refs of an index an older extractor built, without --force', async () => {
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    // As an index built before M5-19 (extractor version 8, M5-10): no external references.
    store.raw.exec('DELETE FROM external_ref_candidates');
    store.setMeta(extractorVersionKey(store.getRepoNames()[0]!), '8');
    await p.sync(store, full);
    expect(dumpRefs(store)).toEqual(dumpRefs(await p.forced()));
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
    expect(dumpRefs(store)).toEqual(dumpRefs(await p.forced()));
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
    const forced = dumpRefs(await p.forced());
    expect(dumpRefs(store)).toEqual(forced);
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
