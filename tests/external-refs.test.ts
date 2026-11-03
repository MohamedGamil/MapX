import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { Scanner } from '../src/core/scanner.js';
import { Store, type ExternalDecision } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import { ATTRIBUTION_VERSION, extractorVersionKey } from '../src/core/extractor-version.js';
import { jsImports } from '../src/core/external-refs.js';
import { builtinModules } from 'node:module';
import { NODE_BUILTINS, NODE_PREFIX_ONLY_BUILTINS, nodeBuiltin, npmPackageName, parsePackageLock, parsePnpmLock, parseYarnLock } from '../src/core/manifests/npm.js';
import { COMPOSER_VENDOR_MAX_BYTES, ComposerAttributor, composerRoots, lockPackagesOf, packageByConvention, parseAutoloadMap, parseComposerLock, parseInstalledJson, phpBuiltin, phpPecl, type PhpKind } from '../src/core/manifests/composer.js';
import { PHP_PECL, PHP_PECL_SOURCE } from '../src/core/manifests/php-pecl.js';
import { PHP_BUILTINS_SOURCE } from '../src/core/manifests/php-builtins.js';
import { EXTERNAL_INPUTS_KEY, changedInputFiles, matchGlob, parseExternalInputs } from '../src/core/manifests/inputs.js';
import { IMPORT_DISTRIBUTIONS, normalizeDist, parsePoetryLock, parseRequirement, parseRequirementsTxt, parseUvLock, pyprojectRoots, pythonBuiltin, PYTHON_STDLIB, requirementsFileIsDev } from '../src/core/manifests/pypi.js';
import { PYTHON_STDLIB_SOURCE } from '../src/core/manifests/python-stdlib.js';
import { parseToml } from '../src/core/manifests/toml.js';
import { GoAttributor, goBuiltin, goImportPaths, goIndirectComment, goModuleByLayout, goModuleOf, goReplacement, goTestOnlyModules, parseGoMod, parseGoSum, parseGoWork } from '../src/core/manifests/go.js';
import { GO_STDLIB, GO_STDLIB_SOURCE } from '../src/core/manifests/go-stdlib.js';
import { cleanup, init, mapx, mapxResult, query } from './helpers/e2e';
import { buildElementView, type Element } from '../src/arch/elements.js';
import { computeMembership } from '../src/arch/membership.js';
import type { Layer } from '../src/arch/schema.js';
import { runArchitecture } from '../src/arch/report.js';
import { isAllowed, openArchitecture } from '../src/arch/introspect.js';
import { ruleSmells } from '../src/arch/smells.js';
import { namePattern } from '../src/arch/selectors/external.js';

// M5-19: references to modules, packages, classes and functions outside the workspace are kept apart
// from edges; whether a candidate is external is decided again at the end of every scan and sync, so
// sync keeps external_refs equal to scan --force (docs/baton/iterations/M5-19.md and its review).

const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');

interface Attribution { package?: string | null; origin?: string | null; direct?: boolean | null; dev?: boolean | null; attribution?: string | null }
interface Label extends Attribution { app: string; file: string; line: number; sourceSymbol: string | null; specifier: string; symbol: string | null; kind: string; ecosystem: string }
const labels = JSON.parse(readFileSync(join(FIXTURE, 'expected-externals.json'), 'utf8')) as { apps: string[]; rows: Label[] };
const REPOS: Record<string, string[]> = { workspace: ['frontend', 'backend'] };

const key = (r: Omit<Label, 'app'>) => [r.file, r.line, r.sourceSymbol, r.specifier, r.symbol, r.kind, r.ecosystem].join(' | ');

// M4-09-R3: every temp workspace of this file is named for this run and removed after its test, once
// every path a test made unreadable is readable again; the run fails if it leaves one in tmpdir().
const RUN = `mapx-extrefs-${process.pid}-`;
const runEntries = () => readdirSync(tmpdir()).filter((name) => name.startsWith(RUN)).sort();
const temps: string[] = [];
const locked = new Map<string, number>();
const tempDir = (kind = ''): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RUN}${kind}`));
  temps.push(dir);
  return dir;
};
/** Takes every permission off a file or folder; `restore` or the afterEach gives them back. */
const unreadable = (path: string) => {
  if (!locked.has(path)) locked.set(path, statSync(path).mode & 0o7777);
  chmodSync(path, 0o000);
};
const restore = (path: string) => {
  const mode = locked.get(path);
  if (mode !== undefined && existsSync(path)) chmodSync(path, mode);
};
let before: string[] = [];
beforeAll(() => { before = runEntries(); });
afterEach(() => {
  for (const path of locked.keys()) restore(path);
  const still = [...locked.keys()].filter((path) => existsSync(path) && (statSync(path).mode & 0o777) === 0);
  locked.clear();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(still, 'still unreadable before removal').toEqual([]);
});
afterAll(() => {
  const left = runEntries().filter((name) => !before.includes(name));
  for (const name of left) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  expect(left, 'temp workspaces this run left in tmpdir()').toEqual([]);
});

describe('the external_refs store', () => {
  it('is added by migration 10 to an index at schema 9: the candidates table and the external_refs view', () => {
    const dir = tempDir();
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
  const root = join(tempDir(), app);
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

  // M5-20 (npm), M5-21 (Composer), M5-22 (pypi), M5-23 (Go): every row carries the labelled package, origin, direct, dev and attribution.
  it.each(labels.apps)('attributes every npm, Composer, pypi and Go row of %s as labelled: package or built-in, direct or transitive, dev or production', (app) => {
    const attributed = (r: Omit<Label, 'app'>) => `${key(r)} | ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`;
    const ecosystems = new Set(['npm', 'composer', 'pypi', 'go']);
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
      root = tempDir('sync-');
      write(root, files);
      if (withGit) {
        git(root, 'init', '-q');
        git(root, 'add', '-A');
        git(root, 'commit', '-qm', 'init');
      }
    },
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
    if (name !== 'a folder') unreadable(join(p.root, 'packages/app/package-lock.json'));
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      expect(npmAttribution(store)).toEqual(attributed('packages/app/src/a.ts', 'manifest'));
    } finally {
      if (name !== 'a folder') restore(join(p.root, 'packages/app/package-lock.json'));
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
    if (name !== 'a folder') unreadable(join(p.root, lock));
    const store = new Store(':memory:');
    try {
      await (await p.scanner(store)).scanFull();
      expect(npmAttribution(store)).toEqual(attributed('packages/app/src/a.ts', 'manifest'));
      // Left as it is, the unreadable lock is no change.
      expect(changedInputFiles(p.root, parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY))!)).toEqual([]);
    } finally {
      if (name !== 'a folder') restore(join(p.root, lock));
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
    const parent = tempDir('repos-');
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
    const root = tempDir('stale-');
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
    const dir = tempDir('php-stubs-');
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
    // The Composer root's classmap is probed for a class (absent here: recorded so its creation is a change, M5-21-R1).
    expect([...a.reads.keys()].sort()).toEqual(['composer.json', 'composer.lock', 'routes/composer.json', 'routes/composer.lock', 'vendor/composer/autoload_classmap.php']);
  });

  // ─── M5-21-R1 ───

  it('reads Composer\'s generated autoload maps as data: escapes, $vendorDir and $baseDir; throws on other text', () => {
    expect(parseAutoloadMap(VENDOR_APP['vendor/composer/autoload_classmap.php']!)).toEqual([
      { key: 'App\\U', path: 'app/U.php' },
      { key: 'Composer\\InstalledVersions', path: 'vendor/composer/InstalledVersions.php' },
      { key: 'Illuminate\\Support\\Collection', path: 'vendor/illuminate/collections/Collection.php' },
      { key: 'Illuminate\\Support\\Str', path: 'vendor/illuminate/support/Str.php' },
      { key: 'LegacyMailer', path: 'lib/legacy/Mailer.php' },
      { key: 'SebastianBergmann\\Diff\\Differ', path: 'vendor/sebastian/diff/src/Differ.php' },
    ]);
    // Short array syntax, a quote in a path, a path above vendor/ (a custom vendor-dir layout).
    expect(parseAutoloadMap("<?php\nreturn [\n  'A\\\\B' => $vendorDir . '/x/y/it\\'s.php',\n  'C' => $vendorDir . '/../lib/C.php',\n];\n")).toEqual([
      { key: 'A\\B', path: "vendor/x/y/it's.php" },
      { key: 'C', path: 'lib/C.php' },
    ]);
    for (const text of ['', '{"packages": []}', "<?php\necho 'x';\n"]) expect(() => parseAutoloadMap(text), text).toThrow();
    // Review of M5-21-R1: double quotes, __DIR__ and joined literals (autoload_static's form), a plain
    // absolute path (kept: it maps to no package), comments; an entry of another form is skipped.
    expect(parseAutoloadMap('<?php\n// \'X\' => $vendorDir . \'/no.php\',\nreturn array(\n  "D\\\\E" => $vendorDir . "/d/e/\\$x.php",\n  \'F\' => __DIR__ . \'/..\' . \'/f/g/F.php\',\n  \'G\' => \'/abs/g.php\',\n  \'H\' => dirname(__FILE__),\n);\n')).toEqual([
      { key: 'D\\E', path: 'vendor/d/e/$x.php' },
      { key: 'F', path: 'vendor/f/g/F.php' },
      { key: 'G', path: '/abs/g.php' },
    ]);
  });

  it('parses a pathological autoload map in linear time (review of M5-21-R1: no backtracking regex)', () => {
    const started = performance.now();
    expect(parseAutoloadMap(`return [${"\\'".repeat(512 * 1024)}`)).toEqual([]);
    expect(parseAutoloadMap(`return [${"'a' => ".repeat(150_000)}`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('skips a vendor/composer file over the size cap, with one warning, and records it as an input', () => {
    const warnings: string[] = [];
    const a = new ComposerAttributor({
      readText: (p) => VENDOR_APP[p] ?? null, repoRootOf: () => '',
      size: (p) => (p === 'vendor/composer/autoload_classmap.php' ? COMPOSER_VENDOR_MAX_BYTES + 1 : VENDOR_APP[p]?.length ?? null),
      warn: (m) => warnings.push(m),
    });
    // The lock alone answers, as without vendor/.
    expect(a.attribute('SebastianBergmann\\Diff\\Differ', 'app/U.php').package).toBeNull();
    expect(a.attribute('Illuminate\\Support\\Str', 'app/U.php').package).toBeNull();
    expect(warnings).toEqual([`[mapx] Skipped vendor/composer/autoload_classmap.php (${COMPOSER_VENDOR_MAX_BYTES + 1} bytes, over ${COMPOSER_VENDOR_MAX_BYTES}): its Composer classmap or files autoload is not read for attribution.`]);
    expect(a.reads.get('vendor/composer/autoload_classmap.php')).toMatch(/too-large/);
  });

  it('one package loading `files` never claims a global function: unknown, as before (review of M5-21-R1)', () => {
    const a = new ComposerAttributor({ readText: (p) => VENDOR_APP[p] ?? null, repoRootOf: () => '' });
    for (const fn of ['add_action', 'acme_helper']) {
      expect(a.attribute(fn, 'app/U.php', { kind: 'function' }), fn).toEqual({ package: null, origin: 'package', direct: null, dev: null, attribution: 'lock' });
    }
    // A namespaced one still follows the naming convention among the files packages.
    expect(a.attribute('Acme\\Helpers\\slug', 'app/U.php', { kind: 'function' }).package).toBe('acme/helpers');
  });

  it('a file under a nested composer.json (a path package) reads the vendor/ beside the project\'s lock', () => {
    const files: Record<string, string> = {
      ...VENDOR_APP,
      'pkgs/helpers/composer.json': JSON.stringify({ name: 'acme/helpers', autoload: { files: ['helpers.php'] } }),
    };
    const a = new ComposerAttributor({ readText: (p) => files[p] ?? null, repoRootOf: () => '' });
    expect(a.attribute('SebastianBergmann\\Diff\\Differ', 'pkgs/helpers/x.php').package).toBe('sebastian/diff');
    expect([...a.reads.keys()].filter((k) => k.includes('vendor/'))).not.toContain('pkgs/helpers/vendor/composer/autoload_classmap.php');
  });

  it('reads installed.json of Composer 2 (install-path, dev-package-names) and Composer 1 (a list, vendor/<name>)', () => {
    expect(parseInstalledJson(VENDOR_APP['vendor/composer/installed.json']!)).toEqual({
      packages: [
        { name: 'acme/helpers', path: 'vendor/acme/helpers' },
        { name: 'acme/legacy', path: 'lib/legacy' },
        { name: 'illuminate/collections', path: 'vendor/illuminate/collections' },
        { name: 'illuminate/support', path: 'vendor/illuminate/support' },
        { name: 'sebastian/diff', path: 'vendor/sebastian/diff' },
      ],
      dev: new Set(['sebastian/diff']),
    });
    expect(parseInstalledJson(JSON.stringify([{ name: 'Psr/Log' }, { name: 'acme/meta', 'install-path': null }]))).toEqual({
      packages: [{ name: 'psr/log', path: 'vendor/psr/log' }, { name: 'acme/meta', path: null }],
      dev: null,
    });
    // An absolute install path (outside the project, another drive) holds no root-relative file (review of M5-21-R1).
    expect(parseInstalledJson(JSON.stringify({ packages: [
      { name: 'c/d', 'install-path': '/abs/c/d' }, { name: 'e/f', 'install-path': 'D:\\pkgs\\e' }, { name: 'g/h', 'install-path': '../../packages/g' },
    ] })).packages).toEqual([{ name: 'c/d', path: null }, { name: 'e/f', path: null }, { name: 'g/h', path: 'packages/g' }]);
    for (const text of ['{ broken', '{}', '"x"']) expect(() => parseInstalledJson(text), text).toThrow();
  });

  it('PECL extensions: their classes, functions and constants, ambient; never a bundled extension\'s', () => {
    expect(PHP_PECL_SOURCE).toMatch(/^reflection of PHP 8\.\d+\.\d+ with apcu .*redis/);
    expect(phpPecl('Redis')).toBe('ext-redis');
    expect(phpPecl('\\imagick')).toBe('ext-imagick');
    expect(phpPecl('apcu_fetch', 'function')).toBe('ext-apcu');
    expect(phpPecl('igbinary_serialize', 'function')).toBe('ext-igbinary');
    expect(phpPecl('Memcached')).toBe('ext-memcached');
    expect(phpPecl('DateTime')).toBeNull();
    expect(phpPecl('strlen', 'function')).toBeNull();
    expect(phpPecl('apcu_fetch')).toBeNull();
    // No name is both: a bundled extension's name is a built-in only.
    for (const ext of Object.values(PHP_PECL)) for (const c of ext.classes.split(' ').filter(Boolean)) expect(phpBuiltin(c), c).toBeNull();
    const a = new ComposerAttributor({ readText: () => null, repoRootOf: () => '' });
    expect(a.attribute('Redis', 'app/x.php')).toEqual({ package: 'ext-redis', origin: 'ambient', direct: null, dev: null, attribution: null });
    expect(a.attribute('apcu_fetch', 'app/x.php', { kind: 'function' })).toEqual({ package: 'ext-apcu', origin: 'ambient', direct: null, dev: null, attribution: null });
  });

  it('reads vendor/composer files only when a name reaches them, once per pass, and never a package\'s sources', () => {
    const read: string[] = [];
    const a = new ComposerAttributor({ readText: (p) => { read.push(p); return VENDOR_APP[p] ?? null; }, repoRootOf: () => '' });
    expect(a.attribute('DateTime', 'app/U.php')).toMatchObject({ origin: 'builtin' });
    expect(read.filter((p) => p.startsWith('vendor/'))).toEqual([]);
    expect(a.attribute('SebastianBergmann\\Diff\\Differ', 'app/U.php')).toMatchObject({ package: 'sebastian/diff', dev: true });
    expect(a.attribute('Illuminate\\Support\\Str', 'app/U.php')).toMatchObject({ package: 'illuminate/support' });
    expect(a.attribute('Acme\\Helpers\\slug', 'app/U.php', { kind: 'function' })).toMatchObject({ package: 'acme/helpers' });
    expect(read.filter((p) => p.startsWith('vendor/'))).toEqual(['vendor/composer/autoload_classmap.php', 'vendor/composer/installed.json', 'vendor/composer/autoload_files.php']);
    // No composer.lock: installed.json answers dev-ness, and its reading flags the answer `lock`.
    const unlocked = new ComposerAttributor({ readText: (p) => (p === 'composer.lock' ? null : VENDOR_APP[p] ?? null), repoRootOf: () => '' });
    expect(unlocked.attribute('SebastianBergmann\\Diff\\Differ', 'app/U.php')).toEqual({ package: 'sebastian/diff', origin: 'package', direct: false, dev: true, attribution: 'lock' });
    expect(unlocked.attribute('Illuminate\\Support\\Str', 'app/U.php')).toEqual({ package: 'illuminate/support', origin: 'package', direct: false, dev: false, attribution: 'lock' });
  });

  it('vendor/composer of the nearest Composer root; the longest install path; several files packages: by convention, else unknown', () => {
    const map = (entries: string[]) => `<?php\n\n$vendorDir = dirname(__DIR__);\n$baseDir = dirname($vendorDir);\n\nreturn array(\n${entries.map((e) => `    ${e},\n`).join('')});\n`;
    const files: Record<string, string> = {
      'composer.json': JSON.stringify({ require: {} }),
      'svc/composer.json': JSON.stringify({ require: {} }),
      'svc/vendor/composer/autoload_classmap.php': map([
        "'Acme\\\\Mono\\\\A' => $vendorDir . '/acme/monorepo/src/A.php'",
        "'Acme\\\\Sub\\\\B' => $vendorDir . '/acme/monorepo/packages/sub/src/B.php'",
      ]),
      'svc/vendor/composer/autoload_files.php': map([
        "'aaaa' => $vendorDir . '/acme/helpers/src/helpers.php'",
        "'bbbb' => $vendorDir . '/acme/strings/src/functions.php'",
      ]),
      'svc/vendor/composer/installed.json': JSON.stringify({ packages: [
        { name: 'acme/monorepo', 'install-path': '../acme/monorepo' },
        // A package inside another's folder (a path repository): the longest install path holds the file.
        { name: 'acme/sub', 'install-path': '../acme/monorepo/packages/sub' },
        { name: 'acme/helpers', 'install-path': '../acme/helpers' },
        { name: 'acme/strings', 'install-path': '../acme/strings' },
      ] }),
    };
    const a = new ComposerAttributor({ readText: (p) => files[p] ?? null, repoRootOf: () => '' });
    const pkg = (name: string, kind?: PhpKind) => a.attribute(name, 'svc/src/X.php', { kind }).package;
    expect(pkg('Acme\\Mono\\A')).toBe('acme/monorepo');
    expect(pkg('Acme\\Sub\\B')).toBe('acme/sub');
    expect(pkg('Acme\\Strings\\slug', 'function')).toBe('acme/strings');
    expect(pkg('helper', 'function')).toBeNull();
    // The repo root's composer.json has no vendor/: a file there reads none.
    expect(a.attribute('Acme\\Mono\\A', 'src/Y.php').package).toBeNull();
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

// M5-21-R1: Composer's generated autoload metadata, synthetic, as `composer install -o` writes it.
// illuminate/support and illuminate/collections share Illuminate\Support\ (real siblings); acme/legacy
// is installed by a custom installer at lib/legacy; sebastian/diff (real) loads by classmap.
const VENDOR_APP: Record<string, string> = {
  'composer.json': JSON.stringify({ require: { 'acme/legacy': '^1.0' }, 'require-dev': {}, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
  'composer.lock': JSON.stringify({
    packages: [
      { name: 'acme/helpers', autoload: { files: ['src/helpers.php'] } },
      { name: 'acme/legacy', type: 'legacy-plugin', autoload: { classmap: ['./'] } },
      { name: 'illuminate/collections', autoload: { 'psr-4': { 'Illuminate\\Support\\': '' } } },
      { name: 'illuminate/support', autoload: { 'psr-4': { 'Illuminate\\Support\\': '' } } },
    ],
    'packages-dev': [{ name: 'sebastian/diff', autoload: { classmap: ['src/'] } }],
  }),
  'vendor/composer/autoload_classmap.php': [
    '<?php', '', '// autoload_classmap.php @generated by Composer', '', '$vendorDir = dirname(__DIR__);', '$baseDir = dirname($vendorDir);', '', 'return array(',
    "    'App\\\\U' => $baseDir . '/app/U.php',",
    "    'Composer\\\\InstalledVersions' => $vendorDir . '/composer/InstalledVersions.php',",
    "    'Illuminate\\\\Support\\\\Collection' => $vendorDir . '/illuminate/collections/Collection.php',",
    "    'Illuminate\\\\Support\\\\Str' => $vendorDir . '/illuminate/support/Str.php',",
    "    'LegacyMailer' => $baseDir . '/lib/legacy/Mailer.php',",
    "    'SebastianBergmann\\\\Diff\\\\Differ' => $vendorDir . '/sebastian/diff/src/Differ.php',",
    ');', '',
  ].join('\n'),
  'vendor/composer/autoload_files.php': [
    '<?php', '', '// autoload_files.php @generated by Composer', '', '$vendorDir = dirname(__DIR__);', '$baseDir = dirname($vendorDir);', '', 'return array(',
    "    '0e6d7bf4a5811bfa5cf40c5ccd6fae6a' => $vendorDir . '/acme/helpers/src/helpers.php',",
    ');', '',
  ].join('\n'),
  'vendor/composer/installed.json': JSON.stringify({
    packages: [
      { name: 'acme/helpers', 'install-path': '../acme/helpers' },
      { name: 'acme/legacy', 'install-path': '../../lib/legacy' },
      { name: 'illuminate/collections', 'install-path': '../illuminate/collections' },
      { name: 'illuminate/support', 'install-path': '../illuminate/support' },
      { name: 'sebastian/diff', 'install-path': '../sebastian/diff' },
    ],
    dev: true,
    'dev-package-names': ['sebastian/diff'],
  }),
  'app/U.php': [
    '<?php', 'namespace App;', '', 'use Illuminate\\Support\\Collection;', '', 'class U', '{', '    public function u()', '    {',
    '        new Collection();',
    "        \\Illuminate\\Support\\Str::of('x');",
    '        new \\LegacyMailer();',
    '        new \\SebastianBergmann\\Diff\\Differ();',
    '        acme_helper();',
    '        new \\Redis();',
    "        apcu_fetch('k');",
    "        \\Composer\\InstalledVersions::isInstalled('x');",
    '    }', '}', '',
  ].join('\n'),
};

describe('Composer attribution of a scan', () => {
  const p = project(false);
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
    if (name !== 'a folder') unreadable(join(p.root, 'app/composer.lock'));
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'manifest'));
    } finally {
      if (name !== 'a folder') restore(join(p.root, 'app/composer.lock'));
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

  // ─── M5-21-R1: classmap and files from vendor/composer, PECL extensions ───

  it('vendor/composer: a classmap class is its installed package, a files function the one files package; PECL names are ambient; without vendor/ as before', async () => {
    expect(await scan(VENDOR_APP)).toEqual([
      // Optimised classmap: the sibling packages sharing Illuminate\Support\ are told apart by the file.
      'app/U.php:10 Illuminate\\Support\\Collection instantiation → illuminate/collections package 0 0 lock',
      'app/U.php:11 Illuminate\\Support\\Str call → illuminate/support package 0 0 lock',
      // Installed outside vendor/ (a custom installer): installed.json's install-path, from $baseDir.
      'app/U.php:12 LegacyMailer instantiation → acme/legacy package 1 0 lock',
      // No naming convention ties SebastianBergmann\ to sebastian/diff; the classmap does. Dev from the lock.
      'app/U.php:13 SebastianBergmann\\Diff\\Differ instantiation → sebastian/diff package 0 1 lock',
      // acme/helpers is the only package whose files autoload loads, yet nothing shows it defines the
      // global function: unknown (review of M5-21-R1).
      'app/U.php:14 acme_helper call → null package null null lock',
      'app/U.php:15 Redis instantiation → ext-redis ambient null null null',
      'app/U.php:16 apcu_fetch call → ext-apcu ambient null null null',
      // Composer's own runtime class is in no installed package: unknown, as before.
      'app/U.php:17 Composer\\InstalledVersions call → null package null null lock',
      'app/U.php:4 Illuminate\\Support\\Collection import → illuminate/collections package 0 0 lock',
    ]);
    // Without vendor/: the lock alone, as M5-21 attributes (PECL names stay ambient).
    expect(await scan(present({ ...VENDOR_APP, 'vendor/composer/autoload_classmap.php': null, 'vendor/composer/autoload_files.php': null, 'vendor/composer/installed.json': null }))).toEqual([
      'app/U.php:10 Illuminate\\Support\\Collection instantiation → null package null null lock',
      'app/U.php:11 Illuminate\\Support\\Str call → null package null null lock',
      'app/U.php:12 LegacyMailer instantiation → null package null null lock',
      'app/U.php:13 SebastianBergmann\\Diff\\Differ instantiation → null package null null lock',
      'app/U.php:14 acme_helper call → null package null null lock',
      'app/U.php:15 Redis instantiation → ext-redis ambient null null null',
      'app/U.php:16 apcu_fetch call → ext-apcu ambient null null null',
      'app/U.php:17 Composer\\InstalledVersions call → null package null null lock',
      'app/U.php:4 Illuminate\\Support\\Collection import → null package null null lock',
    ]);
  }, 120000);

  it('vendor/composer without installed.json: a classmap file under vendor/ is the package of its two folders; without a lock, flagged manifest', async () => {
    expect(await scan(present({ ...VENDOR_APP, 'composer.lock': null, 'vendor/composer/installed.json': null }))).toEqual(expect.arrayContaining([
      'app/U.php:10 Illuminate\\Support\\Collection instantiation → illuminate/collections package 0 null manifest',
      'app/U.php:12 LegacyMailer instantiation → null package null null manifest',
      'app/U.php:13 SebastianBergmann\\Diff\\Differ instantiation → sebastian/diff package 0 null manifest',
    ]));
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
    if (name !== 'a folder') unreadable(join(p.root, lock));
    const store = new Store(':memory:');
    try {
      await (await p.scanner(store)).scanFull();
      expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'manifest'));
      expect(changedInputFiles(p.root, parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY))!)).toEqual([]);
    } finally {
      if (name !== 'a folder') restore(join(p.root, lock));
    }
    rmSync(join(p.root, lock), { recursive: true, force: true });
    commit('remove');
    await p.sync(store);
    expect(composerAttribution(store)).toEqual(composerAttributed('app/Gateway.php', 'lock'));
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
  }, 120000);

  // M5-21-R1: Composer's vendor metadata is an input; vendor/ is no indexed file, so no git change shows it.
  it.each([
    ['the classmap drops a class', { 'vendor/composer/autoload_classmap.php': VENDOR_APP['vendor/composer/autoload_classmap.php']!.replace(/^.*Collection.*\n/m, '') },
      'app/U.php:10 Illuminate\\Support\\Collection instantiation → null package null null lock'],
    ['installed.json moves a package', { 'vendor/composer/installed.json': VENDOR_APP['vendor/composer/installed.json']!.replace('"../sebastian/diff"', '"../acme/helpers/diff"') },
      'app/U.php:13 SebastianBergmann\\Diff\\Differ instantiation → null package null null lock'],
    // autoload_files.php is read for no name here (acme_helper is global): no input, so its removal is no change.
    ['vendor/ is removed', { 'vendor/composer/autoload_classmap.php': null, 'vendor/composer/autoload_files.php': null, 'vendor/composer/installed.json': null },
      'app/U.php:13 SebastianBergmann\\Diff\\Differ instantiation → null package null null lock'],
  ] as const)('vendor/composer: %s: the stale check sees it, sync equals scan --force', async (_name, change, expected) => {
    p.create(VENDOR_APP);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    for (const [path, text] of Object.entries(change)) {
      if (text === null) rmSync(join(p.root, path));
      else writeFileSync(join(p.root, path), text);
    }
    expect(changedInputFiles(p.root, parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY))!).sort()).toEqual(Object.keys(change).filter((k) => !k.endsWith('autoload_files.php')).sort());
    await p.sync(store);
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
    expect(composerAttribution(store)).toContain(expected);
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
    const parent = tempDir('composer-');
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

// ─── pip, Poetry, uv (M5-22) ────────────────────────────────────────────────────────────────

describe('Python standard library and distribution names', () => {
  it('classifies standard-library modules of 3.10 to 3.15 as built-ins, by their top-level module', () => {
    expect(PYTHON_STDLIB_SOURCE).toContain('v3.15.0');
    expect(pythonBuiltin('os.path')).toBe('python:os');
    expect(pythonBuiltin('tomllib')).toBe('python:tomllib');
    expect(pythonBuiltin('distutils')).toBe('python:distutils');
    expect(pythonBuiltin('annotationlib')).toBe('python:annotationlib');
    expect(pythonBuiltin('_thread')).toBe('python:_thread');
    for (const name of ['yaml', 'requests', 'typing_extensions', 'test', 'setuptools']) expect(pythonBuiltin(name)).toBeNull();
  });

  // The generated list against the running Python (3.10+), as M5-21 does for PHP.
  const py = (() => {
    try { return JSON.parse(execFileSync('python3', ['-c', 'import sys, json; print(json.dumps(sorted(sys.stdlib_module_names)))'], { stdio: 'pipe' }).toString()) as string[]; } catch { return null; }
  })();
  it.skipIf(!py)('lists every module of the running Python\'s sys.stdlib_module_names', () => {
    expect(py!.filter((m) => !PYTHON_STDLIB.has(m))).toEqual([]);
  });

  it('normalises names per PEP 503 and reads PEP 508 requirements', () => {
    expect(normalizeDist('Ruamel.YAML__Clib')).toBe('ruamel-yaml-clib');
    expect(parseRequirement('Flask[async, dotenv]>=2.0; python_version > "3.8"')).toEqual({ name: 'flask', extras: ['async', 'dotenv'] });
    expect(parseRequirement('pip @ https://github.com/pypa/pip/archive/1.3.1.zip')).toEqual({ name: 'pip', extras: [] });
    expect(parseRequirement('https://example.com/x.whl')).toBeNull();
    // Every well-known distribution is written normalised.
    for (const dists of Object.values(IMPORT_DISTRIBUTIONS)) for (const d of dists) expect(d).toBe(normalizeDist(d));
  });

  it('reads requirements files: includes, editables, options, paths and URLs; dev-only by the file name', () => {
    expect(parseRequirementsTxt([
      '# tools',
      'requests>=2.31  # http',
      'PyYAML==6.0.1 \\',
      '    --hash=sha256:abc',
      '-r base.txt',
      '--requirement=more.txt',
      '-c constraints.txt',
      '-e git+https://github.com/pallets/click.git#egg=click',
      '-e ./local',
      './wheels/thing-1.0-py3-none-any.whl',
      'https://example.com/pkg.tar.gz',
      '--index-url https://pypi.org/simple',
      'attrs[tests] @ git+https://github.com/python-attrs/attrs',
      // Review of M5-22 (P1-2): a VCS or URL line names a distribution by #egg= only, never its scheme.
      'git+https://github.com/acme/tool.git#egg=acme-tool',
      'hg+https://hg.example.org/repo',
      'svn+https://svn.example.org/repo',
      'file:///tmp/pkg',
      'C:\\pkgs\\x.whl',
      'local/dir',
    ].join('\n'))).toEqual({
      requirements: [{ name: 'requests', extras: [] }, { name: 'pyyaml', extras: [] }, { name: 'click', extras: [] }, { name: 'attrs', extras: ['tests'] }, { name: 'acme-tool', extras: [] }],
      includes: ['base.txt', 'more.txt'],
    });
    for (const spec of ['git+https://x/y.git', 'hg+https://x', 'local/dir', 'name+x']) expect(parseRequirement(spec)).toBeNull();
    expect(parseRequirement('numpy;sys_platform=="linux"')).toEqual({ name: 'numpy', extras: [] });
    for (const f of ['requirements-dev.txt', 'dev-requirements.txt', 'requirements_test.txt', 'requirements.docs.txt', 'test-requirements.txt']) expect(requirementsFileIsDev(f)).toBe(true);
    for (const f of ['requirements.txt', 'requirements-prod.txt', 'requirements-base.txt', 'requirements-py311.txt']) expect(requirementsFileIsDev(f)).toBe(false);
    expect(matchGlob(['requirements.txt', 'dev-requirements.txt', 'README.md', 'requirements-dev.txt', 'requirements.in'], '*requirements*.txt'))
      .toEqual(['dev-requirements.txt', 'requirements-dev.txt', 'requirements.txt']);
  });

  it('reads TOML: tables, arrays of tables, dotted and quoted keys, strings, arrays and inline tables; throws on text that is no TOML', () => {
    expect(parseToml([
      'title = "a \\"b\\" \\u00e9" # comment',
      "lit = 'C:\\path'",
      'multi = """',
      'one \\',
      '   two"""',
      "raw = '''x'y'''",
      'n = 1_000',
      'f = 1.5',
      'd = 1979-05-27T07:32:00Z',
      'b = true',
      'a.b."c.d" = 1',
      'arr = [',
      '  1, # one',
      '  [2, "x"],',
      ']',
      '[t]',
      'inline = { x = 1, y = { z = "w" } }',
      '[[pkg]]',
      'name = "p"',
      '[pkg.sub]',
      'k = 1',
      '[[pkg]]',
      'name = "q"',
    ].join('\n'))).toEqual({
      title: 'a "b" é', lit: 'C:\\path', multi: 'one two', raw: "x'y", n: 1000, f: 1.5, d: '1979-05-27T07:32:00Z', b: true,
      a: { b: { 'c.d': 1 } }, arr: [1, [2, 'x']],
      t: { inline: { x: 1, y: { z: 'w' } } },
      pkg: [{ name: 'p', sub: { k: 1 } }, { name: 'q' }],
    });
    for (const bad of ['x = ', 'x = "open', '[t', 'x = 1 2', 'x = 1\nx = 2', '{ "lockfileVersion": 3 }', 'a = """x""""""']) expect(() => parseToml(bad)).toThrow();
    // Review of M5-22: keys named like Object members are keys (P1-1); 1 or 2 quotes may end a multi-line string (P2-7).
    expect(parseToml('[tool.x]\nconstructor = 1\ntoString = "t"\n__proto__ = 2\nhasOwnProperty = 3\n[tool.constructor]\na = 1\n')).toEqual({
      tool: { x: { constructor: 1, toString: 't', ['__proto__']: 2, hasOwnProperty: 3 }, constructor: { a: 1 } },
    });
    expect(JSON.parse(JSON.stringify(parseToml('a = """x""""\nb = """x"""""\nc = \'\'\'y\'\'\'\'\'\nd = """""x"""\n')))).toEqual({ a: 'x"', b: 'x""', c: "y''", d: '""x' });
  });

  it('reads pyproject.toml: PEP 621, extras, dependency groups, Poetry and uv; production wins', () => {
    const roots = pyprojectRoots(parseToml([
      '[project]',
      'dependencies = ["Flask>=3", "requests[socks]"]',
      '[project.optional-dependencies]',
      'imaging = ["Pillow"]',
      // Review of M5-22 (P2-4): extras named for development tooling are dev.
      'test = ["coverage"]',
      'docs = ["sphinx"]',
      '[dependency-groups]',
      'test = ["pytest", { include-group = "lint" }]',
      'lint = ["ruff", "flask"]',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'celery = { version = "^5", extras = ["redis"] }',
      '[tool.poetry.dev-dependencies]',
      'black = "*"',
      '[tool.poetry.group.main.dependencies]',
      'kombu = "*"',
      '[tool.poetry.group.docs.dependencies]',
      'Sphinx = "*"',
      '[tool.uv]',
      'dev-dependencies = ["mypy"]',
    ].join('\n')));
    expect([...roots.prod]).toEqual([['flask', []], ['requests', ['socks']], ['pillow', []], ['celery', ['redis']], ['kombu', []]]);
    expect([...roots.dev.keys()]).toEqual(['coverage', 'sphinx', 'pytest', 'ruff', 'flask', 'black', 'mypy']);
    expect(roots.poetry).toBe(true);
  });

  it('uv.lock: the members are the roots; dev-ness by reachability through requested extras, production wins', () => {
    const lock = parseUvLock([
      'version = 1',
      '[[package]]',
      'name = "app"',
      'source = { editable = "." }',
      'dependencies = [{ name = "requests", extra = ["socks"] }, { name = "click" }]',
      '[package.dev-dependencies]',
      'dev = [{ name = "pytest" }]',
      '[package.optional-dependencies]',
      'test = [{ name = "coverage" }]',
      '[[package]]',
      'name = "requests"',
      'source = { registry = "https://pypi.org/simple" }',
      'dependencies = [{ name = "urllib3" }]',
      '[package.optional-dependencies]',
      'socks = [{ name = "PySocks" }]',
      'use-chardet-on-py3 = [{ name = "chardet" }]',
      '[[package]]',
      'name = "pytest"',
      'dependencies = [{ name = "colorama" }, { name = "pluggy" }]',
      '[[package]]',
      'name = "click"',
      'dependencies = [{ name = "colorama" }]',
      ...['urllib3', 'pysocks', 'chardet', 'colorama', 'pluggy', 'orphan', 'coverage'].flatMap((n) => ['[[package]]', `name = "${n}"`]),
    ].join('\n'));
    expect(Object.fromEntries(lock.dev)).toEqual({
      app: null, requests: false, urllib3: false, pysocks: false, chardet: null, click: false, colorama: false, pytest: true, pluggy: true, orphan: null, coverage: true,
    });
    expect(() => parseUvLock('[tool.uv]\nx = 1\n')).toThrow();
  });

  it('poetry.lock: groups (2.1), category (1.x), else reachability from the pyproject', () => {
    const roots = [pyprojectRoots(parseToml('[tool.poetry.dependencies]\nrequests = "*"\n[tool.poetry.group.dev.dependencies]\npytest = "*"\n'))];
    const pkg = (name: string, extra: string[] = []) => ['[[package]]', `name = "${name}"`, 'version = "1.0"', ...extra];
    expect(Object.fromEntries(parsePoetryLock([
      ...pkg('requests', ['groups = ["main"]']), ...pkg('pytest', ['groups = ["dev"]']), ...pkg('colorama', ['groups = ["main", "dev"]']),
      '[metadata]', 'lock-version = "2.1"',
    ].join('\n'), roots).dev)).toEqual({ requests: false, pytest: true, colorama: false });
    expect(Object.fromEntries(parsePoetryLock([
      ...pkg('requests', ['category = "main"']), ...pkg('pytest', ['category = "dev"']), '[metadata]', 'lock-version = "1.1"',
    ].join('\n'), roots).dev)).toEqual({ requests: false, pytest: true });
    expect(Object.fromEntries(parsePoetryLock([
      ...pkg('requests', ['[package.dependencies]', 'urllib3 = ">=1"', 'PySocks = { version = "*", optional = true }', '[package.extras]', 'socks = ["PySocks (>=1.5.6,!=1.5.7)"]']),
      ...pkg('pytest', ['[package.dependencies]', 'pluggy = ">=1"', 'urllib3 = "*"']),
      ...pkg('urllib3'), ...pkg('pluggy'), ...pkg('pysocks'),
      '[metadata]', 'lock-version = "2.0"',
    ].join('\n'), roots).dev)).toEqual({ requests: false, urllib3: false, pytest: true, pluggy: true, pysocks: null });
    expect(() => parsePoetryLock('version = 1\n', roots)).toThrow();
  });
});

const pypiAttribution = (store: Store) => store.getExternalRefs().filter((r) => r.ecosystem === 'pypi')
  .map((r) => `${r.file_path}:${r.line} ${r.specifier} ${r.symbol} ${r.kind} → ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`).sort();

// `requests` and `PyYAML` dependencies, `pytest` a dev group; `urllib3` reached through requests
// (production), `pluggy` through pytest (dev); `acme_missing` in nothing.
const PY_SOURCE = ['import requests', 'import yaml', 'import pytest', 'import urllib3', 'import pluggy', 'import acme_missing', 'import os.path', ''].join('\n');
const PYPROJECT = '[project]\nname = "app"\nversion = "0.1.0"\ndependencies = ["requests>=2.31", "PyYAML>=6"]\n\n[dependency-groups]\ndev = ["pytest>=8"]\n';
const UV_LOCK = [
  'version = 1',
  'requires-python = ">=3.11"',
  '',
  '[[package]]',
  'name = "app"',
  'version = "0.1.0"',
  'source = { virtual = "." }',
  'dependencies = [',
  '    { name = "pyyaml" },',
  '    { name = "requests" },',
  ']',
  '',
  '[package.dev-dependencies]',
  'dev = [',
  '    { name = "pytest" },',
  ']',
  ...([['requests', ['urllib3']], ['pyyaml', []], ['urllib3', []], ['pytest', ['pluggy']], ['pluggy', []]] as Array<[string, string[]]>).flatMap(([name, deps]) => [
    '', '[[package]]', `name = "${name}"`, 'version = "1.0.0"', 'source = { registry = "https://pypi.org/simple" }',
    ...(deps.length ? [`dependencies = [${deps.map((d) => `{ name = "${d}" }`).join(', ')}]`] : []),
  ]),
  '',
].join('\n');
/** The rows of PY_SOURCE at `file`, attributed with or without a lockfile. */
const pyAttributed = (file: string, by: 'lock' | 'manifest') => [
  `${file}:1 requests null import → requests package 1 0 ${by}`,
  `${file}:2 yaml null import → pyyaml package 1 0 ${by}`,
  `${file}:3 pytest null import → pytest package 1 1 ${by}`,
  `${file}:4 urllib3 null import → ${by === 'lock' ? 'urllib3 package 0 0' : 'null package null null'} ${by}`,
  `${file}:5 pluggy null import → ${by === 'lock' ? 'pluggy package 0 1' : 'null package null null'} ${by}`,
  `${file}:6 acme_missing null import → null package null null ${by}`,
  `${file}:7 os.path null import → python:os builtin null null null`,
];

describe('pypi attribution of a scan', () => {
  const p = project(false);
  const scan = async (files: Record<string, string>) => {
    p.create(files);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    return pypiAttribution(store);
  };

  it('a uv.lock: direct, transitive, dev-only, unknown and built-in', async () => {
    expect(await scan({ 'pyproject.toml': PYPROJECT, 'uv.lock': UV_LOCK, 'src/a.py': PY_SOURCE })).toEqual(pyAttributed('src/a.py', 'lock'));
  }, 120000);

  // Poetry 2.x (groups), 1.x (category) and lock 2.0 (neither: reachability from the pyproject).
  const POETRY_PYPROJECT = '[tool.poetry]\nname = "app"\n\n[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\nPyYAML = "^6"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n';
  const poetryLock = (field: (group: string) => string, version: string) => [
    ...([['requests', 'main', ['urllib3']], ['pyyaml', 'main', []], ['urllib3', 'main', []], ['pytest', 'dev', ['pluggy']], ['pluggy', 'dev', []]] as Array<[string, string, string[]]>)
      .flatMap(([name, group, deps]) => [
        '[[package]]', `name = "${name}"`, 'version = "1.0.0"', field(group),
        ...(deps.length ? ['', '[package.dependencies]', ...deps.map((d) => `${d} = ">=1"`)] : []), '',
      ]),
    '[metadata]', `lock-version = "${version}"`, 'python-versions = "^3.11"', 'content-hash = "0"', '',
  ].join('\n');
  it.each([
    ['groups', poetryLock((g) => `groups = ["${g}"]`, '2.1')],
    ['category', poetryLock((g) => `category = "${g}"`, '1.1')],
    ['neither', poetryLock(() => '', '2.0')],
  ])('a poetry.lock (%s): direct, transitive, dev-only, unknown and built-in', async (_name, lock) => {
    expect(await scan({ 'pyproject.toml': POETRY_PYPROJECT, 'poetry.lock': lock, 'src/a.py': PY_SOURCE })).toEqual(pyAttributed('src/a.py', 'lock'));
  }, 120000);

  it('requirements files, no lockfile: direct from the manifests, includes followed, dev by the file name, flagged manifest', async () => {
    expect(await scan({
      'requirements.txt': '-r requirements/base.txt\n',
      'requirements/base.txt': 'requests>=2.31\nPyYAML==6.0.1 --hash=sha256:abc\n',
      'requirements-dev.txt': '-r requirements.txt\npytest\n',
      'src/a.py': PY_SOURCE,
    })).toEqual(pyAttributed('src/a.py', 'manifest'));
  }, 120000);

  it('no lockfile: direct from the pyproject only, flagged manifest', async () => {
    expect(await scan({ 'pyproject.toml': PYPROJECT, 'src/a.py': PY_SOURCE })).toEqual(pyAttributed('src/a.py', 'manifest'));
  }, 120000);

  it.each([
    ['a corrupt uv.lock', { 'uv.lock': 'version = 1\n[[package]\nname = "x' }],
    ['a uv.lock that is TOML but no lock', { 'uv.lock': '[tool.uv]\ndev = true\n' }],
    ['a uv.lock that is a folder', { 'uv.lock/x.txt': 'x' }],
    ['a poetry.lock that is no lock', { 'poetry.lock': '{"packages": []}' }],
  ])('%s: direct from the manifest only, flagged manifest, no crash', async (_name, extra) => {
    expect(await scan({ 'pyproject.toml': PYPROJECT, 'src/a.py': PY_SOURCE, ...extra })).toEqual(pyAttributed('src/a.py', 'manifest'));
  }, 120000);

  // As M5-20-R1 and the review of M5-21: an unreadable nested lock ends the walk.
  const PY_NESTED = { 'pyproject.toml': '[project]\nname = "root"\nversion = "0"\n', 'uv.lock': UV_LOCK, 'svc/pyproject.toml': PYPROJECT, 'svc/a.py': PY_SOURCE };
  it.each([
    ['a folder', { 'svc/uv.lock/x.txt': 'x' }],
    ['a file it cannot read', { 'svc/uv.lock': UV_LOCK }],
  ])('a nested uv.lock that is %s: the nested pyproject alone, flagged manifest, never the root lock', async (name, extra) => {
    // Root can read a file without permission: the case holds only for another user.
    if (name !== 'a folder' && process.getuid?.() === 0) return;
    p.create({ ...PY_NESTED, ...extra });
    if (name !== 'a folder') unreadable(join(p.root, 'svc/uv.lock'));
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      expect(pypiAttribution(store)).toEqual(pyAttributed('svc/a.py', 'manifest'));
    } finally {
      if (name !== 'a folder') restore(join(p.root, 'svc/uv.lock'));
    }
  }, 120000);

  it('a nested pyproject without a lockfile: the root folder\'s lockfile answers', async () => {
    expect(await scan(PY_NESTED)).toEqual(pyAttributed('svc/a.py', 'lock'));
  }, 120000);

  it('a stale lock that lacks a required distribution: that one from the manifest, flagged manifest', async () => {
    expect(await scan({
      'pyproject.toml': PYPROJECT.replace('"PyYAML>=6"', '"PyYAML>=6", "httpx"'),
      'uv.lock': UV_LOCK,
      'src/a.py': 'import httpx\nimport requests\nimport acme_missing\n',
    })).toEqual([
      'src/a.py:1 httpx null import → httpx package 1 0 manifest',
      'src/a.py:2 requests null import → requests package 1 0 lock',
      'src/a.py:3 acme_missing null import → null package null null manifest',
    ]);
  }, 120000);

  // Review of M5-21 (P1-1): distributions sharing an import name are told apart by the manifests, never picked arbitrarily.
  it('an import name two distributions provide: the one the manifests list (production first), else unknown', async () => {
    expect(await scan({
      'a/pyproject.toml': '[project]\nname = "a"\nversion = "0"\ndependencies = ["psycopg2-binary"]\n[dependency-groups]\ndev = ["psycopg2", "opencv-python"]\n',
      'a/x.py': 'import psycopg2\nimport cv2\n',
      'b/pyproject.toml': '[project]\nname = "b"\nversion = "0"\ndependencies = ["psycopg2-binary", "psycopg2"]\n',
      'b/x.py': 'import psycopg2\nimport cv2\n',
    })).toEqual([
      'a/x.py:1 psycopg2 null import → psycopg2-binary package 1 0 manifest',
      'a/x.py:2 cv2 null import → opencv-python package 1 1 manifest',
      'b/x.py:1 psycopg2 null import → null package null null manifest',
      // cv2 has four well-known distributions and b lists none: unknown, never a guess.
      'b/x.py:2 cv2 null import → null package null null manifest',
    ]);
  }, 120000);

  it('a namespace package or a submodule imported by name: the longest dotted name a manifest lists', async () => {
    expect(await scan({
      'pyproject.toml': '[project]\nname = "app"\nversion = "0"\ndependencies = ["google-cloud-storage", "protobuf", "zope.interface", "PyYAML"]\n',
      'src/a.py': [
        'from google.cloud import storage',
        'import google.cloud.storage',
        'from google.protobuf import message',
        'from google import protobuf',
        'import zope.interface',
        'import google.auth',
        'from yaml import safe_load',
        'import sklearn',
        '',
      ].join('\n'),
    })).toEqual([
      'src/a.py:1 google.cloud storage import → google-cloud-storage package 1 0 manifest',
      'src/a.py:2 google.cloud.storage null import → google-cloud-storage package 1 0 manifest',
      'src/a.py:3 google.protobuf message import → protobuf package 1 0 manifest',
      'src/a.py:4 google protobuf import → protobuf package 1 0 manifest',
      'src/a.py:5 zope.interface null import → zope-interface package 1 0 manifest',
      // google-auth is in no manifest: an import name is no distribution name.
      'src/a.py:6 google.auth null import → null package null null manifest',
      'src/a.py:7 yaml safe_load import → pyyaml package 1 0 manifest',
      // A well-known import name with one distribution, in no manifest: unlisted.
      'src/a.py:8 sklearn null import → scikit-learn package 0 null manifest',
    ]);
  }, 120000);

  it('a namespace whose parent is a distribution too: the longest listed name wins', async () => {
    expect(await scan({
      'pyproject.toml': '[project]\nname = "app"\nversion = "0"\ndependencies = ["azure", "azure-storage-blob"]\n',
      'src/a.py': 'from azure.storage.blob import BlobClient\nimport azure\n',
    })).toEqual([
      'src/a.py:1 azure.storage.blob BlobClient import → azure-storage-blob package 1 0 manifest',
      'src/a.py:2 azure null import → azure package 1 0 manifest',
    ]);
  }, 120000);

  it('the nearest manifest that lists a distribution decides whether it is dev-only', async () => {
    expect(await scan({
      'pyproject.toml': '[project]\nname = "app"\nversion = "0"\ndependencies = ["requests"]\n[dependency-groups]\ndev = ["pytest"]\n',
      'svc/requirements.txt': 'pytest\n',
      'svc/requirements-dev.txt': 'requests\n',
      'svc/a.py': 'import requests\nimport pytest\n',
    })).toEqual([
      'svc/a.py:1 requests null import → requests package 1 1 manifest',
      'svc/a.py:2 pytest null import → pytest package 1 0 manifest',
    ]);
  }, 120000);

  // ─── Review of M5-22 ──────────────────────────────────────────────────────────────────────

  // P1-1: a key named like an Object member is a key; a pyproject that cannot be parsed leaves what it
  // lists unknown, so the lock alone never makes a package transitive.
  it('a pyproject with a constructor key reads as any other; one that cannot be parsed gives no lock-only answer', async () => {
    expect(await scan({
      'a/pyproject.toml': '[project]\nname = "a"\nversion = "0"\ndependencies = ["requests>=2"]\n[tool.x]\nconstructor = 1\ntoString = 2\n',
      'a/uv.lock': UV_LOCK,
      'a/x.py': 'import requests\nimport urllib3\n',
      'b/pyproject.toml': '[project]\nname = "b"\nversion = "0"\ndependencies = ["requests>=2"\n',
      'b/uv.lock': UV_LOCK,
      'b/x.py': 'import requests\nimport urllib3\nimport acme_missing\n',
    })).toEqual([
      'a/x.py:1 requests null import → requests package 1 0 lock',
      'a/x.py:2 urllib3 null import → urllib3 package 0 0 lock',
      'b/x.py:1 requests null import → requests package null 0 manifest',
      'b/x.py:2 urllib3 null import → urllib3 package null 0 manifest',
      'b/x.py:3 acme_missing null import → null package null null manifest',
    ]);
  }, 120000);

  // P1-2: a VCS line names its distribution by #egg= only.
  it('a VCS requirement: its #egg= name, never the VCS scheme', async () => {
    expect(await scan({
      'requirements.txt': 'git+https://github.com/acme/tool.git#egg=acme-tool\nhg+https://hg.example.org/x\nrequests\n',
      'src/a.py': 'import git\nimport acme_tool\nimport requests\n',
    })).toEqual([
      // git is GitPython's import name; nothing lists it.
      'src/a.py:1 git null import → gitpython package 0 null manifest',
      'src/a.py:2 acme_tool null import → acme-tool package 1 0 manifest',
      'src/a.py:3 requests null import → requests package 1 0 manifest',
    ]);
  }, 120000);

  // P2-1: the imported name is a submodule only when the module itself names no distribution.
  it('from flask import json is flask, though flask-json is listed', async () => {
    expect(await scan({ 'requirements.txt': 'flask\nflask-json\n', 'src/a.py': 'from flask import json\nimport flask_json\n' })).toEqual([
      'src/a.py:1 flask json import → flask package 1 0 manifest',
      'src/a.py:2 flask_json null import → flask-json package 1 0 manifest',
    ]);
  }, 120000);

  // P2-2: a complete lock that lacks a well-known name's distribution: unknown; without a lock, unlisted.
  it('a well-known import name a complete lock lacks is unknown; with no lock it is unlisted', async () => {
    expect(await scan({
      'a/pyproject.toml': PYPROJECT, 'a/uv.lock': UV_LOCK, 'a/x.py': 'import dateutil\n',
      'b/pyproject.toml': PYPROJECT, 'b/x.py': 'import dateutil\n',
    })).toEqual([
      'a/x.py:1 dateutil null import → null package null null lock',
      'b/x.py:1 dateutil null import → python-dateutil package 0 null manifest',
    ]);
  }, 120000);

  // P2-3: a removed standard-library module whose backport a manifest lists is that package.
  it('a standard-library module whose backport a manifest lists is the backport; else the built-in', async () => {
    expect(await scan({
      'requirements.txt': 'legacy-cgi\naudioop-lts\nsetuptools\nstandard-telnetlib\n',
      'src/a.py': 'import cgi\nimport audioop\nimport distutils.core\nimport telnetlib\nimport os\n',
      'lib/b.py': 'import cgi\n',
      'lib/requirements.txt': '',
    })).toEqual([
      'lib/b.py:1 cgi null import → legacy-cgi package 1 0 manifest',
      'src/a.py:1 cgi null import → legacy-cgi package 1 0 manifest',
      'src/a.py:2 audioop null import → audioop-lts package 1 0 manifest',
      'src/a.py:3 distutils.core null import → setuptools package 1 0 manifest',
      'src/a.py:4 telnetlib null import → standard-telnetlib package 1 0 manifest',
      'src/a.py:5 os null import → python:os builtin null null null',
    ]);
    expect(await scan({ 'requirements.txt': 'requests\n', 'src/a.py': 'import cgi\n' })).toEqual(['src/a.py:1 cgi null import → python:cgi builtin null null null']);
  }, 120000);

  // P2-4: an extra named for development tooling is dev.
  it('an optional-dependencies extra named test, dev, lint, docs or typing is dev; another is production', async () => {
    expect(await scan({
      'pyproject.toml': '[project]\nname = "app"\nversion = "0"\ndependencies = []\n[project.optional-dependencies]\ntest = ["pytest"]\nimaging = ["pillow"]\n',
      'tests/test_a.py': 'import pytest\nfrom PIL import Image\n',
    })).toEqual([
      'tests/test_a.py:1 pytest null import → pytest package 1 1 manifest',
      'tests/test_a.py:2 PIL Image import → pillow package 1 0 manifest',
    ]);
  }, 120000);

  // P2-5: both lockfiles: the one of the project's tool.
  it('uv.lock and poetry.lock in one folder: poetry.lock for a Poetry project, else uv.lock', async () => {
    const poetry = '[[package]]\nname = "requests"\nversion = "2"\ngroups = ["main"]\n[package.dependencies]\nurllib3 = "*"\n[[package]]\nname = "urllib3"\nversion = "2"\ngroups = ["main"]\n[metadata]\nlock-version = "2.1"\n';
    const uv = 'version = 1\n[[package]]\nname = "app"\nversion = "0"\nsource = { virtual = "." }\ndependencies = [{ name = "requests" }]\n[[package]]\nname = "requests"\nversion = "2"\n';
    expect(await scan({
      'p/pyproject.toml': '[tool.poetry]\nname = "p"\n[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2"\n',
      'p/uv.lock': uv, 'p/poetry.lock': poetry, 'p/x.py': 'import urllib3\n',
      'u/pyproject.toml': '[project]\nname = "u"\nversion = "0"\ndependencies = ["requests"]\n',
      'u/uv.lock': uv, 'u/poetry.lock': poetry, 'u/x.py': 'import urllib3\n',
    })).toEqual([
      'p/x.py:1 urllib3 null import → urllib3 package 0 0 lock',
      'u/x.py:1 urllib3 null import → null package null null lock',
    ]);
  }, 120000);

  // P2-6: requirements/*.txt, dev by the file name.
  it('a requirements/ folder: each file read, dev by its name', async () => {
    expect(await scan({
      'requirements/base.txt': 'requests\n',
      'requirements/dev.txt': '-r base.txt\npytest\n',
      'requirements/lint.txt': 'ruff\n',
      'src/a.py': 'import requests\nimport pytest\nimport ruff\n',
    })).toEqual([
      'src/a.py:1 requests null import → requests package 1 0 manifest',
      'src/a.py:2 pytest null import → pytest package 1 1 manifest',
      'src/a.py:3 ruff null import → ruff package 1 1 manifest',
    ]);
  }, 120000);
});

// Sync = scan --force when pyproject.toml, a requirements file or the lock changes.
const PY_CHANGES: Array<{ name: string; change: Record<string, string | null>; expect: string }> = [
  {
    name: 'a dev dependency moves to the dependencies',
    change: { 'pyproject.toml': PYPROJECT.replace('"PyYAML>=6"]', '"PyYAML>=6", "pytest>=8"]').replace('dev = ["pytest>=8"]', 'dev = []') },
    expect: 'src/a.py:3 pytest null import → pytest package 1 0 lock',
  },
  { name: 'uv.lock is deleted', change: { 'uv.lock': null }, expect: 'src/a.py:4 urllib3 null import → null package null null manifest' },
  { name: 'uv.lock is corrupted', change: { 'uv.lock': 'version = [' }, expect: 'src/a.py:5 pluggy null import → null package null null manifest' },
  {
    name: 'uv.lock is edited: a transitive package becomes dev-only',
    change: { 'uv.lock': UV_LOCK.replace('dependencies = [{ name = "urllib3" }]', '').replace('dependencies = [{ name = "pluggy" }]', 'dependencies = [{ name = "pluggy" }, { name = "urllib3" }]') },
    expect: 'src/a.py:4 urllib3 null import → urllib3 package 0 1 lock',
  },
  { name: 'a requirements file appears', change: { 'requirements-dev.txt': 'urllib3\n' }, expect: 'src/a.py:4 urllib3 null import → urllib3 package 1 1 lock' },
];

describe.each([['git sync', true], ['hash sync', false]] as const)('a %s, when a Python manifest or lockfile changes', (_name, withGit) => {
  const p = project(withGit);
  const commit = (message: string) => {
    if (!withGit) return;
    git(p.root, 'add', '-A');
    git(p.root, 'commit', '-qm', message);
  };

  it.each(PY_CHANGES)('$name: equal to scan --force', async ({ change, expect: expected }) => {
    p.create({ 'pyproject.toml': PYPROJECT, 'uv.lock': UV_LOCK, 'src/a.py': PY_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    expect(pypiAttribution(store)).toEqual(pyAttributed('src/a.py', 'lock'));
    write(p.root, change);
    commit('change');
    await p.sync(store);
    const forced = await p.forced();
    expect(dumpAll(store)).toEqual(dumpAll(forced));
    expect(pypiAttribution(forced)).toContain(expected);
  }, 120000);

  it('keeps the stored pypi attribution when nothing it read changed; a new requirements file re-attributes', async () => {
    p.create({ 'pyproject.toml': PYPROJECT, 'uv.lock': UV_LOCK, 'src/a.py': PY_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    store.raw.exec("UPDATE external_ref_candidates SET attribution = 'kept' WHERE specifier = 'urllib3'");
    write(p.root, { 'src/b.py': 'import pluggy\n' });
    commit('add');
    await p.sync(store);
    expect(pypiAttribution(store)).toContain('src/a.py:4 urllib3 null import → urllib3 package 0 0 kept');
    expect(pypiAttribution(store)).toContain('src/b.py:1 pluggy null import → pluggy package 0 1 lock');
    write(p.root, { 'requirements-test.txt': 'pluggy\n' });
    commit('requirements');
    await p.sync(store);
    expect(pypiAttribution(store)).toEqual(pypiAttribution(await p.forced()));
    expect(pypiAttribution(store)).toContain('src/a.py:4 urllib3 null import → urllib3 package 0 0 lock');
    expect(pypiAttribution(store)).toContain('src/b.py:1 pluggy null import → pluggy package 1 1 lock');
  }, 120000);

  // Review of M5-20-R1 (same mechanism): an unreadable lock is recorded as such, so removing it is a change.
  it.each(['a folder', 'a file it cannot read'])('a nested uv.lock that is %s is removed: the root lock answers, as scan --force', async (name) => {
    if (name !== 'a folder' && process.getuid?.() === 0) return;
    const lock = 'svc/uv.lock';
    p.create({ 'pyproject.toml': '[project]\nname = "root"\nversion = "0"\n', 'uv.lock': UV_LOCK, 'svc/pyproject.toml': PYPROJECT, 'svc/a.py': PY_SOURCE, ...(name === 'a folder' ? { [`${lock}/x.txt`]: 'x' } : { [lock]: UV_LOCK }) });
    if (name !== 'a folder') unreadable(join(p.root, lock));
    const store = new Store(':memory:');
    try {
      await (await p.scanner(store)).scanFull();
      expect(pypiAttribution(store)).toEqual(pyAttributed('svc/a.py', 'manifest'));
      expect(changedInputFiles(p.root, parseExternalInputs(store.getMeta(EXTERNAL_INPUTS_KEY))!)).toEqual([]);
    } finally {
      if (name !== 'a folder') restore(join(p.root, lock));
    }
    rmSync(join(p.root, lock), { recursive: true, force: true });
    commit('remove');
    await p.sync(store);
    expect(pypiAttribution(store)).toEqual(pyAttributed('svc/a.py', 'lock'));
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
  }, 120000);

  it('fills the pypi attribution of an index an earlier MapX built (null columns), without --force', async () => {
    p.create({ 'pyproject.toml': PYPROJECT, 'uv.lock': UV_LOCK, 'src/a.py': PY_SOURCE });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    store.raw.exec("UPDATE external_ref_candidates SET package = NULL, origin = NULL, direct = NULL, dev = NULL, attribution = NULL WHERE ecosystem = 'pypi'");
    await p.sync(store);
    expect(pypiAttribution(store)).toEqual(pyAttributed('src/a.py', 'lock'));
  }, 120000);
});

describe('pypi attribution through the CLI', () => {
  it('a lock-only change or a new requirements file makes the index stale; sync re-attributes', () => {
    const root = tempDir('pypi-');
    try {
      write(root, { 'pyproject.toml': PYPROJECT, 'uv.lock': UV_LOCK, 'src/a.py': PY_SOURCE });
      init(root);
      mapx(root, 'scan');
      const rows = () => query<{ specifier: string; package: string | null; direct: number | null; dev: number | null; attribution: string | null }>(
        root, "SELECT specifier, package, direct, dev, attribution FROM external_refs WHERE ecosystem = 'pypi'")
        .map((r) => `${r.specifier} → ${r.package} ${r.direct} ${r.dev} ${r.attribution}`).sort();
      expect(rows()).toContain('urllib3 → urllib3 0 0 lock');
      expect(mapx(root, 'status')).toContain('Index is up to date');
      write(root, { 'uv.lock': UV_LOCK.replace('dependencies = [{ name = "urllib3" }]', '') });
      let status = mapx(root, 'status');
      expect(status).toContain('Index is stale');
      expect(status).toContain('uv.lock');
      mapx(root, 'sync');
      expect(rows()).toContain('urllib3 → urllib3 0 null lock');
      expect(mapx(root, 'status')).toContain('Index is up to date');
      write(root, { 'requirements-dev.txt': 'urllib3\n' });
      status = mapx(root, 'status');
      expect(status).toContain('Index is stale');
      expect(status).toContain('requirements');
      mapx(root, 'sync');
      expect(rows()).toContain('urllib3 → urllib3 1 1 lock');
      expect(mapx(root, 'status')).toContain('Index is up to date');
    } finally {
      cleanup(root);
    }
  }, 180000);
});

// ─── Go modules (M5-23) ─────────────────────────────────────────────────────────────────────
// go.mod and go.sum attribution: the module of the build list whose path is the longest prefix of
// the import, direct unless `// indirect`, dev when only `_test.go` files use it, and the standard
// library as built-ins (docs/baton/iterations/M5-23.md).

describe('Go standard library and go.mod, go.sum, go.work', () => {
  it('lists the importable standard library of Go 1.22 to 1.27: builtin; cgo\'s C is ambient; modules and internal packages are not', () => {
    expect(GO_STDLIB_SOURCE).toMatch(/^go1\.22\.\d+, go1\.23\.\d+, go1\.24\.\d+, go1\.25\.\d+, go1\.26\.\d+, go1\.27\.\d+$/);
    expect(['fmt', 'net/http', 'testing', 'unsafe', 'log/slog', 'iter', 'encoding/json/v2'].map(goBuiltin)).toEqual(Array(7).fill('builtin'));
    expect(goBuiltin('C')).toBe('ambient');
    // Packages that build only for one target or with cgo (review of M5-23): syscall/js (js/wasm), runtime/cgo.
    expect(['syscall/js', 'runtime/cgo'].map(goBuiltin)).toEqual(['builtin', 'builtin']);
    expect(['github.com/google/uuid', 'internal/abi', 'net/http/internal', 'vendor/golang.org/x/net/idna', 'cmd/go', 'mylib', 'fmt/x'].map(goBuiltin)).toEqual(Array(7).fill(null));
    // Every entry is a dotless path, without vendored or internal packages.
    expect(GO_STDLIB.filter((p) => p.split('/')[0]!.includes('.') || p.startsWith('vendor/') || /(^|\/)internal(\/|$)/.test(p))).toEqual([]);
    expect([...GO_STDLIB].sort()).toEqual(GO_STDLIB);
  });

  // The list is static; when a Go toolchain runs here, its importable standard library must all be in it.
  const go = (() => { try { execFileSync('go', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
  it.skipIf(!go)('lists every importable package of the running Go\'s standard library', () => {
    const std = execFileSync('go', ['list', 'std'], { encoding: 'utf8' }).split('\n')
      .filter((p) => p && !p.startsWith('vendor/') && !/(^|\/)internal(\/|$)/.test(p));
    expect(std.filter((p) => goBuiltin(p) !== 'builtin')).toEqual([]);
  });

  it('go.mod: require blocks and lines with // indirect, replace (module or local), tool; exclude and retract change nothing', () => {
    const mod = parseGoMod([
      'module "example.com/app"', '', 'go 1.24', 'toolchain go1.24.1', '',
      'require github.com/google/uuid v1.6.0', 'require (',
      '\tgithub.com/go-chi/chi/v5 v5.0.12 // a comment', '\tgolang.org/x/sys v0.20.0 // indirect', '\t"gopkg.in/yaml.v3" v3.0.1 //indirect; used by testify', ')',
      'exclude github.com/google/uuid v1.5.0', 'retract v0.1.0',
      'replace github.com/a/b v1.0.0 => github.com/me/b v1.0.1', 'replace (', '\texample.com/lib => ../lib', ')',
      'tool golang.org/x/tools/cmd/stringer', '',
    ].join('\n'));
    expect(mod.module).toBe('example.com/app');
    expect(mod.go).toBe('1.24');
    expect([...mod.requires].map(([m, r]) => `${m} ${r.version} ${r.indirect}`)).toEqual([
      'github.com/google/uuid v1.6.0 false', 'github.com/go-chi/chi/v5 v5.0.12 false', 'golang.org/x/sys v0.20.0 true', 'gopkg.in/yaml.v3 v3.0.1 true',
    ]);
    expect(mod.replaces).toEqual([
      { module: 'github.com/a/b', version: 'v1.0.0', path: 'github.com/me/b', local: false },
      { module: 'example.com/lib', version: null, path: '../lib', local: true },
    ]);
    expect(mod.tools).toEqual(['golang.org/x/tools/cmd/stringer']);
    expect(parseGoMod('module m\n').go).toBeNull();
    expect(() => parseGoMod('go 1.22\nrequire x v1\n')).toThrow();
  });

  // Review of M5-23 (X5): Go's own rule, modfile.isIndirect.
  it('// indirect: the comment is exactly `indirect`, or starts with `indirect;`', () => {
    expect(['// indirect', '//indirect', '//  indirect  ', '// indirect; used by testify'].map(goIndirectComment)).toEqual([true, true, true, true]);
    expect(['// not indirect', '// indirect dependency', '// indirect;', '// direct', '// indirectly', ''].map(goIndirectComment)).toEqual([false, false, false, false, false, false]);
    const mod = parseGoMod('module m\n\nrequire (\n\ta v1.0.0 // not indirect\n\tb v1.0.0 // indirect dependency\n\tc v1.0.0 // indirect\n)\n');
    expect([...mod.requires].map(([m, r]) => `${m} ${r.indirect}`)).toEqual(['a false', 'b false', 'c true']);
  });

  // Review of M5-23 (P2): a versioned replace applies to that version only.
  it('replace: the directive of the required version, else the one of all versions', () => {
    const replaces = parseGoMod([
      'module m', 'replace example.com/y v0.9.0 => ../outside/y', 'replace example.com/y v1.0.0 => example.com/fork/y v1.0.1',
      'replace example.com/z => example.com/fork/z v2.0.0', 'replace example.com/z v1.2.0 => example.com/pin/z v1.2.1',
    ].join('\n')).replaces;
    expect(goReplacement(replaces, 'example.com/y', 'v1.0.0')?.path).toBe('example.com/fork/y');
    expect(goReplacement(replaces, 'example.com/y', 'v0.9.0')?.path).toBe('../outside/y');
    expect(goReplacement(replaces, 'example.com/y', 'v1.1.0')).toBeNull();
    expect(goReplacement(replaces, 'example.com/z', 'v1.2.0')?.path).toBe('example.com/pin/z');
    expect(goReplacement(replaces, 'example.com/z', 'v1.3.0')?.path).toBe('example.com/fork/z');
    expect(goReplacement(replaces, 'example.com/w', 'v1.0.0')).toBeNull();
  });

  it('go.sum: the modules it holds hashes for, of content or go.mod only; throws on text that is no go.sum', () => {
    expect([...parseGoSum('github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=\ngithub.com/stretchr/objx v0.1.0/go.mod h1:HFkY916IF+rwdDfMAkV7OtwuqBVzrE8GR6GFx+wExME=\n\n')])
      .toEqual(['github.com/google/uuid', 'github.com/stretchr/objx']);
    expect(parseGoSum('').size).toBe(0);
    expect(() => parseGoSum('module example.com/app\n')).toThrow();
    expect(() => parseGoSum('{"packages": []}')).toThrow();
  });

  it('go.work: use directories (block or line) and replace directives', () => {
    expect(parseGoWork('go 1.22\n\nuse (\n\t./app\n\t"./lib" // the library\n)\nuse ./tools\nreplace example.com/x => example.com/y v1.0.0\n'))
      .toEqual({ uses: ['./app', './lib', './tools'], replaces: [{ module: 'example.com/x', version: null, path: 'example.com/y', local: false }] });
  });

  it('the module of an import: the longest module path prefix, at a / boundary; /vN names another module', () => {
    const modules = ['cloud.google.com/go', 'cloud.google.com/go/storage', 'github.com/a/b', 'github.com/go-chi/chi', 'github.com/go-chi/chi/v5', 'gopkg.in/yaml.v3'];
    expect(goModuleOf('cloud.google.com/go/storage', modules)).toBe('cloud.google.com/go/storage');
    expect(goModuleOf('cloud.google.com/go/storage/internal/x', modules)).toBe('cloud.google.com/go/storage');
    expect(goModuleOf('cloud.google.com/go/pubsub', modules)).toBe('cloud.google.com/go');
    expect(goModuleOf('github.com/a/bc', modules)).toBeNull();
    expect(goModuleOf('github.com/a/b/c', modules)).toBe('github.com/a/b');
    expect(goModuleOf('github.com/go-chi/chi/v5/middleware', modules)).toBe('github.com/go-chi/chi/v5');
    expect(goModuleOf('github.com/go-chi/chi/middleware', modules)).toBe('github.com/go-chi/chi');
    // A major version the build list lacks is not a folder of v1.
    expect(goModuleOf('github.com/go-chi/chi/v4', modules)).toBeNull();
    expect(goModuleOf('github.com/a/b/v2/x', modules)).toBeNull();
    expect(goModuleOf('github.com/a/b/v1/x', modules)).toBe('github.com/a/b');
    expect(goModuleOf('gopkg.in/yaml.v3', modules)).toBe('gopkg.in/yaml.v3');
    expect(goModuleOf('gopkg.in/yaml.v2', modules)).toBeNull();
  });

  it('dev-only: a module only _test.go files of a Go module use, per go.mod scope', () => {
    expect([...goTestOnlyModules([
      { file: 'a/x_test.go', scope: '', module: 'testify' },
      { file: 'a/y_test.go', scope: '', module: 'testify' },
      { file: 'a/x_test.go', scope: '', module: 'uuid' },
      { file: 'a/x.go', scope: '', module: 'uuid' },
      { file: 'svc/x.go', scope: 'svc', module: 'testify' },
      { file: 'svc/x_test.go', scope: 'svc', module: 'uuid' },
    ])].sort()).toEqual(['\0testify', 'svc\0uuid']);
  });

  it('reads go.mod, go.sum and go.work only between the file and its repo\'s root', () => {
    const files: Record<string, string> = {
      'go.mod': 'module example.com/outer\n\nrequire github.com/outer/x v1.0.0\n',
      'R/go.mod': 'module example.com/r\n\nrequire github.com/google/uuid v1.6.0\n',
    };
    const a = new GoAttributor({ readText: (p) => files[p] ?? null, repoRootOf: (p) => (p.startsWith('R/') ? 'R' : '') });
    expect(a.attribute('github.com/outer/x', 'R/cmd/main.go')).toEqual({ package: null, origin: 'package', direct: null, dev: null, attribution: 'manifest' });
    expect(a.attribute('github.com/google/uuid', 'R/cmd/main.go')).toEqual({ package: 'github.com/google/uuid', origin: 'package', direct: true, dev: false, attribution: 'manifest' });
    expect([...a.reads.keys()].sort()).toEqual(['R/cmd/go.mod', 'R/go.mod', 'R/go.sum', 'R/go.work']);
  });

  it('the module path of an unreadable go.mod, from the folder layout (M5-23-R1)', () => {
    expect(goImportPaths('package x\n\nimport "fmt"\nimport u "github.com/google/uuid"\n// import "no/comment"\nimport (\n\t"example.com/app/a"\n\t. "example.com/app/b/c" // trailing\n\t_ "embed"\n)\n'))
      .toEqual(['fmt', 'github.com/google/uuid', 'example.com/app/a', 'example.com/app/b/c', 'embed']);
    // A tokenizer, not lines: strings and comments that look like imports are none (review of M5-23-R1).
    expect(goImportPaths('package x\nimport (\n\t"a/b"\n\t"c)d"\n\t"e/f"\n)\n')).toEqual(['a/b', 'c)d', 'e/f']);
    expect(goImportPaths('package x\nimport "real/x"\nvar s = "/* "\nvar t = "*/"\n')).toEqual(['real/x']);
    expect(goImportPaths('package x\n\nimport (\n\t"x/a"\n)\nvar s = `\nimport "fake/z"\n`\n')).toEqual(['x/a']);
    expect(goImportPaths('package x\n/* import "no/block" */ import ( "p/q"; m "r/s" )\n')).toEqual(['p/q', 'r/s']);
    // A raw-string path, and a comment holding a quote.
    expect(goImportPaths('package x\nimport (\n\t`x/raw` // it\'s "fake"\n\t"y/b"\n)\n')).toEqual(['x/raw', 'y/b']);
    // Strong evidence only: one candidate, voted for by imports of two folders or more.
    expect(goModuleByLayout(['example.com/app/a', 'example.com/app/b/c'], ['a', 'b/c'])).toBe('example.com/app');
    // A dotless module path is a module too; a standard-library path never votes.
    expect(goModuleByLayout(['app/store', 'app/log', 'net/http'], ['store', 'log', 'http'])).toBe('app');
    // One folder is no evidence: a lone third-party prefix never wins (review P1), nor one own folder.
    expect(goModuleByLayout(['github.com/google/uuid', 'github.com/google/go-cmp/cmp'], ['uuid'])).toBeNull();
    expect(goModuleByLayout(['k8s.io/api', 'k8s.io/client-go/kubernetes'], ['api'])).toBeNull();
    expect(goModuleByLayout(['example.com/app/a'], ['a'])).toBeNull();
    // A competing candidate, however strong either is: unknown.
    expect(goModuleByLayout(['example.com/app/a', 'github.com/acme/foo', 'github.com/acme/bar'], ['a', 'foo', 'bar'])).toBeNull();
    expect(goModuleByLayout(['example.com/app/a', 'example.com/app/b/c', 'github.com/google/uuid'], ['a', 'b/c', 'uuid'])).toBeNull();
    expect(goModuleByLayout(['github.com/google/uuid'], ['a'])).toBeNull();
  });
});

const goAttribution = (store: Store, kind = 'import') => store.getExternalRefs().filter((r) => r.ecosystem === 'go' && r.kind === kind)
  .map((r) => `${r.file_path}:${r.line} ${r.specifier} → ${r.package} ${r.origin} ${r.direct} ${r.dev} ${r.attribution}`).sort();

// Real module paths; go.sum hashes are placeholders in go.sum's format.
const GO_MOD = [
  'module example.com/app', '', 'go 1.22', '',
  'require (', '\tgithub.com/go-chi/chi/v5 v5.0.12', '\tgithub.com/google/uuid v1.6.0', '\tgithub.com/stretchr/testify v1.9.0', ')', '',
  'require golang.org/x/sys v0.0.0-20220715151400-c0bba94af5f8 // indirect', 'require gopkg.in/yaml.v3 v3.0.1 // indirect', '',
].join('\n');
const sumLines = (...modules: string[]) => modules.map((m) => `${m} h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n${m}/go.mod h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=\n`).join('');
const GO_SUM = sumLines('github.com/go-chi/chi v1.5.5', 'github.com/go-chi/chi/v5 v5.0.12', 'github.com/google/uuid v1.6.0', 'github.com/stretchr/testify v1.9.0',
  'golang.org/x/sys v0.0.0-20220715151400-c0bba94af5f8', 'gopkg.in/yaml.v3 v3.0.1');
const GO_MAIN = [
  'package main', '', 'import (', '\t"fmt"', '',
  '\t"github.com/go-chi/chi/v5"', '\t"github.com/google/uuid"', '\t"github.com/pkg/errors"', '\t"golang.org/x/sys/unix"', ')', '',
  'func main() {', '\tfmt.Println(uuid.New(), unix.Getpid(), errors.New("x"))', '\tchi.NewRouter()', '}', '',
].join('\n');
const GO_TEST = 'package main\n\nimport (\n\t"testing"\n\n\t"github.com/stretchr/testify/require"\n\t"gopkg.in/yaml.v3"\n)\n\nfunc TestMain(t *testing.T) { require.NotNil(t, yaml.Node{}) }\n';
const GO_FILES: Record<string, string> = { 'go.mod': GO_MOD, 'go.sum': GO_SUM, 'cmd/main.go': GO_MAIN, 'cmd/main_test.go': GO_TEST };
/** The import rows of GO_MAIN and GO_TEST under `dir`, attributed with or without a readable go.sum. */
const goAttributed = (dir: string, by: 'lock' | 'manifest') => {
  const lock = by === 'lock';
  return [
    `${dir}/main.go:4 fmt → fmt builtin null null null`,
    `${dir}/main.go:6 github.com/go-chi/chi/v5 → github.com/go-chi/chi/v5 package 1 0 ${by}`,
    `${dir}/main.go:7 github.com/google/uuid → github.com/google/uuid package 1 0 ${by}`,
    `${dir}/main.go:8 github.com/pkg/errors → null package ${lock ? '0' : 'null'} null ${by}`,
    `${dir}/main.go:9 golang.org/x/sys/unix → golang.org/x/sys package 0 0 ${by}`,
    `${dir}/main_test.go:4 testing → testing builtin null null null`,
    `${dir}/main_test.go:6 github.com/stretchr/testify/require → github.com/stretchr/testify package 1 1 ${by}`,
    `${dir}/main_test.go:7 gopkg.in/yaml.v3 → gopkg.in/yaml.v3 package 0 1 ${by}`,
  ];
};
/** Files without the entries set to null (a null entry removes a file another entry would add). */
const present = (files: Record<string, string | null>) =>
  Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)) as Record<string, string>;

describe('Go modules attribution of a scan', () => {
  const p = project(false);
  const scan = async (files: Record<string, string>, kind?: string) => {
    p.create(files);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    return goAttribution(store, kind);
  };

  it('go.mod and go.sum: direct, // indirect, test-only, a major version, not in the build list, built-in', async () => {
    expect(await scan(GO_FILES)).toEqual(goAttributed('cmd', 'lock'));
  }, 120000);

  it('calls and literals are attributed as their import', async () => {
    expect(await scan(GO_FILES, 'call')).toEqual([
      'cmd/main.go:13 fmt → fmt builtin null null null',
      'cmd/main.go:13 github.com/google/uuid → github.com/google/uuid package 1 0 lock',
      'cmd/main.go:13 github.com/pkg/errors → null package 0 null lock',
      'cmd/main.go:13 golang.org/x/sys/unix → golang.org/x/sys package 0 0 lock',
      'cmd/main.go:14 github.com/go-chi/chi/v5 → github.com/go-chi/chi/v5 package 1 0 lock',
      'cmd/main_test.go:10 github.com/stretchr/testify/require → github.com/stretchr/testify package 1 1 lock',
    ]);
  }, 120000);

  it('no go.sum: direct and // indirect from go.mod only, flagged manifest', async () => {
    expect(await scan(present({ ...GO_FILES, 'go.sum': null }))).toEqual(goAttributed('cmd', 'manifest'));
  }, 120000);

  it.each([
    ['a corrupt go.sum', { 'go.sum': '{"packages": [' }],
    ['a go.sum that is a go.mod', { 'go.sum': GO_MOD }],
    ['a go.sum that is a folder', { 'go.sum': null, 'go.sum/x.txt': 'x' }],
  ])('%s: direct from go.mod only, flagged manifest, no crash', async (_name, extra) => {
    expect(await scan(present({ ...GO_FILES, ...extra }))).toEqual(goAttributed('cmd', 'manifest'));
  }, 120000);

  it.each([
    ['go.sum is a folder', { 'svc/go.sum/x.txt': 'x' }, null, 'manifest'],
    ['go.sum cannot be read', { 'svc/go.sum': GO_SUM }, 'go.sum', 'manifest'],
    ['go.mod is a folder', { 'svc/go.mod': null, 'svc/go.mod/x.txt': 'x', 'svc/go.sum': GO_SUM }, null, 'unknown'],
    ['go.mod cannot be read', { 'svc/go.sum': GO_SUM }, 'go.mod', 'unknown'],
  ] as const)('a nested module whose %s: never the parent module\'s go.mod or go.sum', async (_name, extra, chmod, expected) => {
    // Root can read a file without permission: the case holds only for another user.
    if (chmod && process.getuid?.() === 0) return;
    p.create(present({
      'go.mod': GO_MOD, 'go.sum': GO_SUM, 'svc/go.mod': GO_MOD.replace('example.com/app', 'example.com/svc'),
      'svc/cmd/main.go': GO_MAIN, 'svc/cmd/main_test.go': GO_TEST, ...extra,
    }));
    if (chmod) unreadable(join(p.root, 'svc', chmod));
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      const rows = goAttribution(store);
      if (expected === 'manifest') expect(rows).toEqual(goAttributed('svc/cmd', 'manifest'));
      // No readable go.mod: no build list, every module unknown; built-ins stand.
      else expect(rows).toEqual(goAttributed('svc/cmd', 'manifest').map((r) => (r.includes('builtin') ? r : r.replace(/→ .*$/, '→ null package null null manifest'))));
    } finally {
      if (chmod) restore(join(p.root, 'svc', chmod));
    }
  }, 120000);

  it('a stale go.sum that lacks a module go.mod requires: that module from go.mod, flagged manifest', async () => {
    expect(await scan({ ...GO_FILES, 'go.sum': GO_SUM.split('\n').filter((l) => !l.startsWith('github.com/google/uuid')).join('\n') })).toEqual([
      'cmd/main.go:4 fmt → fmt builtin null null null',
      'cmd/main.go:6 github.com/go-chi/chi/v5 → github.com/go-chi/chi/v5 package 1 0 lock',
      'cmd/main.go:7 github.com/google/uuid → github.com/google/uuid package 1 0 manifest',
      // The build list is incomplete: not "not in the build list".
      'cmd/main.go:8 github.com/pkg/errors → null package null null manifest',
      'cmd/main.go:9 golang.org/x/sys/unix → golang.org/x/sys package 0 0 lock',
      'cmd/main_test.go:4 testing → testing builtin null null null',
      'cmd/main_test.go:6 github.com/stretchr/testify/require → github.com/stretchr/testify package 1 1 lock',
      'cmd/main_test.go:7 gopkg.in/yaml.v3 → gopkg.in/yaml.v3 package 0 1 lock',
    ]);
  }, 120000);

  it('replace: the required path is the package; go.sum holds the replacement; a local replacement needs no hash', async () => {
    expect(await scan({
      'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n\texample.com/lib v0.0.0\n)\n\nreplace github.com/google/uuid => github.com/acme/uuid v1.6.1\nreplace example.com/lib => ./lib\n',
      'go.sum': sumLines('github.com/acme/uuid v1.6.1'),
      'lib/lib.go': 'package lib\n\nfunc Lib() {}\n',
      'cmd/main.go': 'package main\n\nimport (\n\t"example.com/lib"\n\t"github.com/acme/uuid"\n\t"github.com/google/uuid"\n\t"github.com/pkg/errors"\n)\n\nfunc main() { lib.Lib(); uuid.New(); errors.New("x") }\n',
    })).toEqual([
      // A replacement is no import path of the build list.
      'cmd/main.go:5 github.com/acme/uuid → null package 0 null lock',
      'cmd/main.go:6 github.com/google/uuid → github.com/google/uuid package 1 0 lock',
      // example.com/lib, replaced by ./lib, is the workspace's (no row); go.sum is complete.
      'cmd/main.go:7 github.com/pkg/errors → null package 0 null lock',
    ]);
  }, 120000);

  it('a dotless module path a go.mod requires is that module; another dotless path no standard package has is unknown', async () => {
    expect(await scan({
      // A local replacement would make mylib the workspace's (M5-25-R1): replaced by a module here.
      'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire mylib v0.0.0\n\nreplace mylib => github.com/acme/mylib v1.0.0\n',
      'go.sum': sumLines('github.com/acme/mylib v1.0.0'),
      'cmd/main.go': 'package main\n\nimport (\n\t"mylib/x"\n\t"otherlib"\n\t"strings"\n)\n\nfunc main() { x.X(); otherlib.Y(); strings.ToUpper("") }\n',
    })).toEqual([
      'cmd/main.go:4 mylib/x → mylib package 1 0 lock',
      'cmd/main.go:5 otherlib → null package null null lock',
      'cmd/main.go:6 strings → strings builtin null null null',
    ]);
  }, 120000);

  it('a go.work: the other modules\' requirements and sums join the build list, transitive for this module', async () => {
    expect(await scan({
      'go.work': 'go 1.22\n\nuse (\n\t./app\n\t./lib\n)\n',
      'app/go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n',
      'app/go.sum': sumLines('github.com/google/uuid v1.6.0'),
      'lib/go.mod': 'module example.com/lib\n\ngo 1.22\n\nrequire github.com/sirupsen/logrus v1.9.3\n',
      'lib/go.sum': sumLines('github.com/sirupsen/logrus v1.9.3'),
      'go.work.sum': sumLines('golang.org/x/sys v0.0.0-20220715151400-c0bba94af5f8'),
      'app/main.go': 'package main\n\nimport (\n\t"github.com/google/uuid"\n\t"github.com/sirupsen/logrus"\n\t"golang.org/x/sys/unix"\n)\n\nfunc main() { uuid.New(); logrus.Info(); unix.Getpid() }\n',
    })).toEqual([
      'app/main.go:4 github.com/google/uuid → github.com/google/uuid package 1 0 lock',
      'app/main.go:5 github.com/sirupsen/logrus → github.com/sirupsen/logrus package 0 0 lock',
      // Only go.work.sum holds x/sys: no go.mod requires it, so it is not listed (go 1.22).
      'app/main.go:6 golang.org/x/sys/unix → golang.org/x/sys package null null lock',
    ]);
  }, 120000);

  // ─── Review of M5-23 ───

  it.each([
    ['a folder', { 'go.mod': null, 'go.mod/x.txt': 'x' }, false],
    ['a file it cannot read', {}, true],
  ] as const)('the only go.mod is %s: module imports are unknown, flagged manifest, never dropped', async (_name, extra, chmod) => {
    // Root can read a file without permission: the case holds only for another user.
    if (chmod && process.getuid?.() === 0) return;
    p.create(present({ ...GO_FILES, ...extra }));
    if (chmod) unreadable(join(p.root, 'go.mod'));
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      expect(goAttribution(store)).toEqual(goAttributed('cmd', 'manifest').map((r) => (r.includes('builtin') ? r : r.replace(/→ .*$/, '→ null package null null manifest'))));
    } finally {
      if (chmod) restore(join(p.root, 'go.mod'));
    }
  }, 120000);

  it.each([
    ['1.17', 'github.com/stretchr/objx package null null lock'],
    ['1.21', 'github.com/stretchr/objx package null null lock'],
    ['1.16', 'github.com/stretchr/objx package 0 0 lock'],
  ])('a module only go.sum holds, with go %s: not listed from 1.17 (graph pruning), transitive before', async (go, expected) => {
    expect(await scan({
      'go.mod': `module example.com/app\n\ngo ${go}\n\nrequire github.com/stretchr/testify v1.9.0\n`,
      'go.sum': sumLines('github.com/stretchr/testify v1.9.0') + 'github.com/stretchr/objx v0.1.0/go.mod h1:HFkY916IF+rwdDfMAkV7OtwuqBVzrE8GR6GFx+wExME=\n',
      'cmd/main.go': 'package main\n\nimport (\n\t"github.com/stretchr/objx"\n\t"github.com/stretchr/testify/assert"\n)\n\nfunc main() { objx.New(nil); assert.True(nil, true) }\n',
    })).toEqual([
      `cmd/main.go:4 github.com/stretchr/objx → ${expected}`,
      'cmd/main.go:5 github.com/stretchr/testify/assert → github.com/stretchr/testify package 1 0 lock',
    ]);
  }, 120000);

  it('a versioned replace applies to its version only; a local one of another version leaves the module external', async () => {
    expect(await scan({
      'go.mod': [
        'module example.com/app', '', 'go 1.22', '', 'require (', '\tgithub.com/x/y v1.0.0', '\tgithub.com/x/z v1.2.0', ')', '',
        'replace github.com/x/y v1.0.0 => github.com/fork/y v1.0.1', 'replace github.com/x/y v0.9.0 => ../../outside/y',
        'replace github.com/x/z v1.1.0 => github.com/fork/z v1.1.1', '',
      ].join('\n'),
      'go.sum': sumLines('github.com/fork/y v1.0.1', 'github.com/x/z v1.2.0', 'github.com/fork/z v1.1.1'),
      'cmd/main.go': 'package main\n\nimport (\n\t"github.com/x/y"\n\t"github.com/x/z"\n)\n\nfunc main() { y.Y(); z.Z() }\n',
    })).toEqual([
      // y v1.0.0 is the fork, whose hash go.sum holds; the v0.9.0 directory does not make y the workspace's (M5-25-R1).
      'cmd/main.go:4 github.com/x/y → github.com/x/y package 1 0 lock',
      // z v1.2.0 is not replaced: go.sum holds its own hash.
      'cmd/main.go:5 github.com/x/z → github.com/x/z package 1 0 lock',
    ]);
  }, 120000);

  // M5-25-R3: a local replacement folder outside the MapX workspace is no package of the workspace.
  // Synthetic, labelled: svc/go.mod replaces out (unversioned) and pinned (v1.2.0, the required
  // version) by folders outside the workspace, lib by ../lib (outside the module, inside the
  // workspace) and inlib v0.1.0 by ./inlib; the root go.work replaces wk by a folder outside.
  it('a local replace outside the workspace makes the module external; one inside stays internal', async () => {
    p.create({
      'go.work': 'go 1.22\n\nuse ./svc\n\nreplace github.com/x/wk => ../outside/wk\n',
      'svc/go.mod': [
        'module example.com/svc', '', 'go 1.22', '', 'require (', '\tgithub.com/google/uuid v1.6.0', '\tgithub.com/x/out v1.0.0',
        '\tgithub.com/x/pinned v1.2.0', '\tgithub.com/x/wk v1.0.0', '\texample.com/lib v0.0.0', '\texample.com/inlib v0.1.0', ')', '',
        'replace github.com/x/out => ../../outside/out', 'replace github.com/x/pinned v1.2.0 => ../../outside/pinned',
        'replace example.com/lib => ../lib', 'replace example.com/inlib v0.1.0 => ./inlib', '',
      ].join('\n'),
      // go.sum holds no hash of a directory replacement, and complete without one.
      'svc/go.sum': sumLines('github.com/google/uuid v1.6.0'),
      'lib/go.mod': 'module example.com/lib\n\ngo 1.22\n',
      'lib/lib.go': 'package lib\n\nfunc Lib() {}\n',
      'svc/inlib/inlib.go': 'package inlib\n\nfunc In() {}\n',
      'svc/cmd/main.go': [
        'package main', '', 'import (', '\t"example.com/inlib"', '\t"example.com/lib"', '\t"github.com/google/uuid"', '\t"github.com/x/out"',
        '\t"github.com/x/out/sub"', '\t"github.com/x/pinned"', '\t"github.com/x/wk"', ')', '',
        'func main() { inlib.In(); lib.Lib(); uuid.New(); out.F(); sub.G(); pinned.P(); wk.W() }', '',
      ].join('\n'),
    });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    // Attributed to the replaced module, `manifest`: no lock vouches for a directory (review).
    expect(goAttribution(store)).toEqual([
      'svc/cmd/main.go:10 github.com/x/wk → github.com/x/wk package 1 0 manifest',
      'svc/cmd/main.go:6 github.com/google/uuid → github.com/google/uuid package 1 0 lock',
      'svc/cmd/main.go:7 github.com/x/out → github.com/x/out package 1 0 manifest',
      'svc/cmd/main.go:8 github.com/x/out/sub → github.com/x/out package 1 0 manifest',
      'svc/cmd/main.go:9 github.com/x/pinned → github.com/x/pinned package 1 0 manifest',
    ]);
    // ../lib and ./inlib are workspace folders: import edges, no rows.
    expect(store.getAllEdges().filter((e) => e.edge_type === 'import').map((e) => `${e.source_file} → ${e.target_file}`).sort())
      .toEqual(['svc/cmd/main.go → lib/lib.go', 'svc/cmd/main.go → svc/inlib/inlib.go']);
  }, 120000);

  // Review of M5-25-R3 (P2): the attribution of a directory replacement does not depend on go.sum.
  it('a directory replacement is `manifest` with a go.sum, with an unrelated one and with none', async () => {
    const files = (sum: string | null) => present({
      'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire github.com/x/out v1.0.0\n\nreplace github.com/x/out => ../outside/out\n',
      'go.sum': sum,
      'cmd/main.go': 'package main\n\nimport "github.com/x/out"\n\nfunc main() { out.F() }\n',
    });
    for (const sum of [sumLines('github.com/x/out v1.0.0'), sumLines('github.com/google/uuid v1.6.0'), null]) {
      expect(await scan(files(sum)), String(sum)).toEqual(['cmd/main.go:3 github.com/x/out → github.com/x/out package 1 0 manifest']);
    }
  }, 120000);

  // Review of M5-25-R3 (P1, P2): a replace target is judged by its real path and the registered
  // repos. Layout (base/): ws/ is the workspace root, holding app/ (a repo) and lib/; ext/ is a repo
  // registered at ../ext; outside/y is registered nowhere; base/link-to-lib -> ws/lib; ws/link-out ->
  // ../outside/y; ws/link-ext -> ../ext.
  describe('where a replace target lies', () => {
    const layout = (registerExt: boolean) => {
      const base = tempDir('replace-');
      write(base, {
        'ws/app/go.mod': [
          'module example.com/app', '', 'go 1.22', '', 'require (', '\texample.com/ext v0.0.0', '\texample.com/lib v0.0.0', '\texample.com/y v0.0.0',
          '\texample.com/out v0.0.0', '\texample.com/ext2 v0.0.0', ')', '',
          'replace example.com/ext => ../../ext', 'replace example.com/lib => ../../link-to-lib', 'replace example.com/y => ../../outside/y',
          'replace example.com/out => ../link-out', 'replace example.com/ext2 => ../link-ext', '',
        ].join('\n'),
        'ws/app/main.go': [
          'package main', '', 'import (', '\t"example.com/ext/pkg"', '\t"example.com/ext2/pkg"', '\t"example.com/lib"', '\t"example.com/out"', '\t"example.com/y"', ')', '',
          'func main() { pkg.A(); lib.L(); out.O(); y.Y() }', '',
        ].join('\n'),
        'ws/lib/lib.go': 'package lib\n\nfunc L() {}\n',
        'ext/go.mod': 'module example.com/ext\n\ngo 1.22\n',
        'ext/pkg/p.go': 'package pkg\n\nfunc A() {}\n',
        'outside/y/y.go': 'package y\n\nfunc Y() {}\n',
        'outside/o/o.go': 'package o\n\nfunc O() {}\n',
      });
      // The real `init` writes the defaults; the repos are then the layout's.
      init(join(base, 'ws'));
      const configPath = join(base, 'ws/.mapx/config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.repos = [{ name: 'app', path: 'app' }, ...(registerExt ? [{ name: 'ext', path: '../ext' }] : []), { name: 'lib', path: 'lib' }];
      writeFileSync(configPath, JSON.stringify(config));
      symlinkSync(join(base, 'ws/lib'), join(base, 'link-to-lib'));
      symlinkSync('../outside/o', join(base, 'ws/link-out'));
      symlinkSync('../ext', join(base, 'ws/link-ext'));
      return base;
    };
    const scanned = async (base: string) => {
      const config = await Config.load(join(base, 'ws'));
      const store = new Store(':memory:');
      await new Scanner(store, config, new MapxGraph(config.repos[0]!.name)).scanFull();
      return store;
    };
    const imports = (store: Store) => store.getAllEdges().filter((e) => e.edge_type === 'import' && e.source_file === 'app/main.go')
      .map((e) => e.target_file).sort();

    it('a folder in a registered repo above the root is internal; a link to the workspace is internal; a folder or link out of every repo is external', async () => {
      const store = await scanned(layout(true));
      // ext (replace to the registered ../ext), ext2 (a link to it) and lib (a link from outside to ws/lib).
      expect(imports(store)).toEqual(['../ext/pkg/p.go', '../ext/pkg/p.go', 'lib/lib.go']);
      // y and out (a link to a folder no repo holds) are external, attributed to their module.
      expect(goAttribution(store)).toEqual([
        'app/main.go:7 example.com/out → example.com/out package 1 0 manifest',
        'app/main.go:8 example.com/y → example.com/y package 1 0 manifest',
      ]);
    }, 120000);

    it('the same folder is external once no repo holds it', async () => {
      const store = await scanned(layout(false));
      expect(imports(store)).toEqual(['lib/lib.go']);
      expect(goAttribution(store)).toEqual([
        'app/main.go:4 example.com/ext/pkg → example.com/ext package 1 0 manifest',
        'app/main.go:5 example.com/ext2/pkg → example.com/ext2 package 1 0 manifest',
        'app/main.go:7 example.com/out → example.com/out package 1 0 manifest',
        'app/main.go:8 example.com/y → example.com/y package 1 0 manifest',
      ]);
    }, 120000);
  });

  it('a replacement go.sum lacks makes it stale; a go.work replace overrides go.mod\'s; a required replacement target stays a module', async () => {
    expect(await scan({
      'go.work': 'go 1.22\n\nuse ./app\n\nreplace github.com/x/w => github.com/work/w v1.0.0\n',
      'go.work.sum': sumLines('github.com/work/w v1.0.0'),
      'app/go.mod': [
        'module example.com/app', '', 'go 1.22', '', 'require (', '\tgithub.com/x/v v1.0.0', '\tgithub.com/x/w v1.0.0', '\tgithub.com/x/t v1.0.0', '\tgithub.com/x/u v1.0.0', ')', '',
        // v's replacement has no hash: go.sum is stale. w: go.work's directive wins. t => u, which is required too.
        'replace github.com/x/v => github.com/fork/v v1.0.0', 'replace github.com/x/w => github.com/mod/w v1.0.0', 'replace github.com/x/t => github.com/x/u v1.0.0', '',
      ].join('\n'),
      // Only go.work.sum holds w's replacement: go.mod's directive would leave it unhashed.
      'app/go.sum': sumLines('github.com/x/u v1.0.0'),
      'app/main.go': 'package main\n\nimport (\n\t"github.com/x/t"\n\t"github.com/x/u"\n\t"github.com/x/v"\n\t"github.com/x/w"\n\t"github.com/pkg/errors"\n)\n\nfunc main() { t.T(); u.U(); v.V(); w.W(); errors.New("x") }\n',
    })).toEqual([
      'app/main.go:4 github.com/x/t → github.com/x/t package 1 0 lock',
      'app/main.go:5 github.com/x/u → github.com/x/u package 1 0 lock',
      'app/main.go:6 github.com/x/v → github.com/x/v package 1 0 manifest',
      'app/main.go:7 github.com/x/w → github.com/x/w package 1 0 lock',
      // go.sum is stale (v's replacement unhashed): an import no module provides is unknown, never "not in the build list".
      'app/main.go:8 github.com/pkg/errors → null package null null manifest',
    ]);
  }, 120000);

  it('dev-only per Go module: a nested go.mod whose tests alone use a module the parent module uses in production', async () => {
    expect(await scan({
      'go.mod': GO_MOD, 'go.sum': GO_SUM,
      'lib/use.go': 'package lib\n\nimport "github.com/stretchr/testify/assert"\n\nvar _ = assert.True\n',
      'svc/go.mod': GO_MOD.replace('example.com/app', 'example.com/svc'), 'svc/go.sum': GO_SUM,
      'svc/x_test.go': 'package svc\n\nimport (\n\t"testing"\n\n\t"github.com/stretchr/testify/assert"\n)\n\nfunc TestX(t *testing.T) { assert.True(t, true) }\n',
    })).toEqual([
      'lib/use.go:3 github.com/stretchr/testify/assert → github.com/stretchr/testify package 1 0 lock',
      'svc/x_test.go:4 testing → testing builtin null null null',
      'svc/x_test.go:6 github.com/stretchr/testify/assert → github.com/stretchr/testify package 1 1 lock',
    ]);
  }, 120000);

  it('cgo\'s C is ambient; no go.mod: built-ins only', async () => {
    expect(await scan({ 'main.go': 'package main\n\n// #include <stdio.h>\nimport "C"\n\nimport "os"\n\nfunc main() { os.Exit(0) }\n' })).toEqual([
      'main.go:4 C → C ambient null null null',
      'main.go:6 os → os builtin null null null',
    ]);
  }, 120000);

  // ─── M5-23-R1: an unreadable go.mod keeps the module's own imports internal ───

  const OWN = {
    'go.mod': GO_MOD,
    // internal/gone is no package: still the module's own, never a row.
    'cmd/main.go': 'package main\n\nimport (\n\t"example.com/app/internal/gone"\n\t"example.com/app/internal/store"\n\t"example.com/app/pkg/log"\n\t"github.com/google/uuid"\n)\n\nfunc main() { gone.X(); store.Open(); log.Info(); uuid.New() }\n',
    'internal/store/store.go': 'package store\n\nimport "example.com/app/pkg/log"\n\nfunc Open() { log.Info() }\n',
    'pkg/log/log.go': 'package log\n\nfunc Info() {}\n',
    // A nested module's imports never vote for the root module's path as its folders.
    'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n',
    'svc/a/a.go': 'package a\n\nimport (\n\t"example.com/svc/b"\n\t"example.com/svc/c"\n\t"example.com/svc/d"\n)\n\nfunc A() { b.B(); c.C(); d.D() }\n',
    'svc/b/b.go': 'package b\n\nfunc B() {}\n',
    'svc/c/c.go': 'package c\n\nfunc C() {}\n',
    'svc/d/d.go': 'package d\n\nfunc D() {}\n',
  };
  const ownEdges = (store: Store) => store.getAllEdges().filter((e) => e.edge_type === 'import')
    .map((e) => `${e.source_file} → ${e.target_file}`).sort();
  /** Scans `files` with go.mod made unreadable (chmod 000) or given as a folder. */
  const scanUnreadable = async (files: Record<string, string | null>, chmod: boolean) => {
    p.create(present(chmod ? files : { ...files, 'go.mod': null, 'go.mod/x.txt': 'x' }));
    if (chmod) unreadable(join(p.root, 'go.mod'));
    try {
      const store = new Store(':memory:');
      await (await p.scanner(store)).scanFull();
      return store;
    } finally {
      if (chmod) restore(join(p.root, 'go.mod'));
    }
  };
  const HOW = [['cannot be read', true], ['is a folder', false]] as const;
  // Root can read a file without permission: those cases hold only for another user.
  const skip = (chmod: boolean) => chmod && process.getuid?.() === 0;

  it.each(HOW)('go.mod %s: sibling packages of the module stay internal, with their edges; a module import is unknown, flagged manifest', async (_name, chmod) => {
    if (skip(chmod)) return;
    // The same tree with a readable go.mod: the import edges the unreadable one must keep.
    const readable = new Store(':memory:');
    const q = project(false);
    q.create(OWN);
    await (await q.scanner(readable)).scanFull();
    const store = await scanUnreadable(OWN, chmod);
    expect(goAttribution(store)).toEqual(['cmd/main.go:7 github.com/google/uuid → null package null null manifest']);
    expect(ownEdges(store)).toEqual(expect.arrayContaining([
      'cmd/main.go → internal/store/store.go',
      'cmd/main.go → pkg/log/log.go',
      'internal/store/store.go → pkg/log/log.go',
      'svc/a/a.go → svc/b/b.go',
    ]));
    expect(ownEdges(store)).toEqual(ownEdges(readable));
  }, 120000);

  // Review of M5-23-R1 (P1): weak or competing evidence infers nothing; the module's imports stay unknown, as before.
  const UNKNOWN = (r: string) => `${r} → null package null null manifest`;
  it.each(HOW)('go.mod %s: a lone third-party prefix matching one folder is never the module (no false edge)', async (_name, chmod) => {
    if (skip(chmod)) return;
    const store = await scanUnreadable({
      'go.mod': GO_MOD,
      'cmd/main.go': 'package main\n\nimport (\n\t"github.com/google/go-cmp/cmp"\n\t"github.com/google/uuid"\n\t"k8s.io/api"\n)\n\nfunc main() { cmp.Diff(1, 2); uuid.New(); api.X() }\n',
      'uuid/uuid.go': 'package uuid\n\nfunc New() {}\n',
      'api/api.go': 'package api\n\nfunc X() {}\n',
    }, chmod);
    expect(goAttribution(store)).toEqual(['cmd/main.go:4 github.com/google/go-cmp/cmp', 'cmd/main.go:5 github.com/google/uuid', 'cmd/main.go:6 k8s.io/api'].map(UNKNOWN));
    expect(ownEdges(store)).toEqual([]);
  }, 120000);

  it.each(HOW)('go.mod %s: a competing prefix (a uuid/ folder beside own folders, or two folders of a third party) infers nothing', async (_name, chmod) => {
    if (skip(chmod)) return;
    const store = await scanUnreadable({
      'go.mod': GO_MOD,
      'cmd/main.go': 'package main\n\nimport (\n\t"example.com/app/a"\n\t"example.com/app/b"\n\t"github.com/acme/bar"\n\t"github.com/acme/foo"\n\t"github.com/google/uuid"\n)\n\nfunc main() { a.A(); b.B(); bar.X(); foo.X(); uuid.New() }\n',
      'a/a.go': 'package a\n\nfunc A() {}\n',
      'b/b.go': 'package b\n\nfunc B() {}\n',
      'foo/foo.go': 'package foo\n\nfunc X() {}\n',
      'bar/bar.go': 'package bar\n\nfunc X() {}\n',
      'uuid/uuid.go': 'package uuid\n\nfunc New() {}\n',
    }, chmod);
    expect(goAttribution(store)).toEqual([
      'cmd/main.go:4 example.com/app/a', 'cmd/main.go:5 example.com/app/b', 'cmd/main.go:6 github.com/acme/bar', 'cmd/main.go:7 github.com/acme/foo', 'cmd/main.go:8 github.com/google/uuid',
    ].map(UNKNOWN));
    expect(ownEdges(store)).toEqual([]);
  }, 120000);

  it('a go.work member whose go.mod is a folder: its folder layout, voted for by the other members that import it (review P2)', async () => {
    p.create({
      'go.work': 'go 1.22\n\nuse (\n\t./a\n\t./b\n)\n',
      'a/go.mod': 'module example.com/a\n\ngo 1.22\n',
      'a/a.go': 'package a\n\nimport "example.com/b/x"\n\nfunc A() { x.X() }\n',
      'b/go.mod/x.txt': 'x',
      'b/x/x.go': 'package x\n\nimport "example.com/b/y"\n\nfunc X() { y.Y() }\n',
      'b/y/y.go': 'package y\n\nfunc Y() {}\n',
    });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    expect(goAttribution(store)).toEqual([]);
    expect(ownEdges(store)).toEqual(['a/a.go → b/x/x.go', 'b/x/x.go → b/y/y.go']);
  }, 120000);
});

// Sync = scan --force when go.mod, go.sum or the test-only use of a module changes.
const GO_CHANGES: Array<{ name: string; change: Record<string, string | null>; expect: string }> = [
  {
    name: 'a module go.mod marked // indirect becomes direct',
    change: { 'go.mod': GO_MOD.replace(' // indirect', '') },
    expect: 'cmd/main.go:9 golang.org/x/sys/unix → golang.org/x/sys package 1 0 lock',
  },
  { name: 'go.sum is deleted', change: { 'go.sum': null }, expect: 'cmd/main.go:7 github.com/google/uuid → github.com/google/uuid package 1 0 manifest' },
  { name: 'go.sum is corrupted', change: { 'go.sum': 'corrupt' }, expect: 'cmd/main_test.go:7 gopkg.in/yaml.v3 → gopkg.in/yaml.v3 package 0 1 manifest' },
  {
    name: 'go.sum gains a module',
    change: { 'go.sum': GO_SUM + sumLines('github.com/pkg/errors v0.9.1') },
    // go 1.22: a module go.mod does not require is not listed (review of M5-23).
    expect: 'cmd/main.go:8 github.com/pkg/errors → github.com/pkg/errors package null null lock',
  },
  {
    // Nothing attribution reads changes: an edited file of another package of the module decides,
    // and the test file is not re-parsed (its stored rows stand, and their dev changes).
    name: 'a non-test file starts using a test-only module',
    change: { 'tools/check.go': 'package tools\n\nimport "github.com/stretchr/testify/assert"\n\nvar _ = assert.True\n' },
    expect: 'cmd/main_test.go:6 github.com/stretchr/testify/require → github.com/stretchr/testify package 1 0 lock',
  },
  {
    name: 'the only non-test file using a module stops using it',
    change: { 'cmd/main.go': GO_MAIN },
    expect: 'cmd/main_test.go:7 gopkg.in/yaml.v3 → gopkg.in/yaml.v3 package 0 1 lock',
  },
];
// main.go also uses yaml.v3, for the last change.
const GO_MAIN_YAML = GO_MAIN.replace('"golang.org/x/sys/unix"', '"golang.org/x/sys/unix"\n\t"gopkg.in/yaml.v3"').replace('chi.NewRouter()', 'chi.NewRouter()\n\t_ = yaml.Node{}');

describe.each([['git sync', true], ['hash sync', false]] as const)('a %s, when go.mod, go.sum or a module\'s test-only use changes', (_name, withGit) => {
  const p = project(withGit);

  it.each(GO_CHANGES)('$name: equal to scan --force', async ({ name, change, expect: expected }) => {
    const before = name.startsWith('the only') ? GO_MAIN_YAML : GO_MAIN;
    p.create({ ...GO_FILES, 'cmd/main.go': before, 'tools/check.go': 'package tools\n\nvar X = 1\n' });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    if (before === GO_MAIN) expect(goAttribution(store)).toEqual(goAttributed('cmd', 'lock'));
    else expect(goAttribution(store)).toContain('cmd/main_test.go:7 gopkg.in/yaml.v3 → gopkg.in/yaml.v3 package 0 0 lock');
    write(p.root, change);
    if (withGit) {
      git(p.root, 'add', '-A');
      git(p.root, 'commit', '-qm', 'change');
    }
    await p.sync(store);
    const forced = await p.forced();
    expect(dumpAll(store)).toEqual(dumpAll(forced));
    expect(goAttribution(store)).toContain(expected);
  }, 120000);

  // Review of M5-23-R1 (P2): the module path an unreadable go.mod's layout gives is a sync input.
  it.each([
    ['a second own folder imported: the module path is inferred', 'tool/t.go', 'package tool\n\nimport "example.com/app/internal/store"\n\nfunc T() { store.Open() }\n', 'cmd/main.go → pkg/log/log.go'],
    ['a competing third-party prefix imported: the module path is no longer inferred', 'tool/t.go', 'package tool\n\nimport "github.com/google/uuid"\n\nfunc T() { uuid.New() }\n', null],
  ] as const)('go.mod is a folder, %s; unchanged files follow, as scan --force', async (_name, path, text, edge) => {
    // Inferred at first in the second case: pkg/log imports internal/store, a second own folder.
    const second: Record<string, string> = edge ? {} : { 'pkg/log/log2.go': 'package log\n\nimport "example.com/app/internal/store"\n\nfunc L() { store.Open() }\n' };
    p.create({
      'go.mod/x.txt': 'x',
      'cmd/main.go': 'package main\n\nimport "example.com/app/pkg/log"\n\nfunc main() { log.Info() }\n',
      'pkg/log/log.go': 'package log\n\nfunc Info() {}\n',
      'internal/store/store.go': 'package store\n\nfunc Open() {}\n',
      'uuid/uuid.go': 'package uuid\n\nfunc New() {}\n',
      ...second,
    });
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    const linked = () => store.getAllEdges().some((e) => e.edge_type === 'import' && e.source_file === 'cmd/main.go' && e.target_file === 'pkg/log/log.go');
    expect(linked()).toBe(!edge);
    write(p.root, { [path]: text });
    if (withGit) {
      git(p.root, 'add', '-A');
      git(p.root, 'commit', '-qm', 'change');
    }
    await p.sync(store);
    const forced = await p.forced();
    expect(dumpEdges(store)).toEqual(dumpEdges(forced));
    expect(dumpAll(store)).toEqual(dumpAll(forced));
    expect(linked()).toBe(!!edge);
  }, 120000);

  it('fills the Go attribution of an index built before (null columns), without --force', async () => {
    p.create(GO_FILES);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    store.raw.exec("UPDATE external_ref_candidates SET package = NULL, origin = NULL, direct = NULL, dev = NULL, attribution = NULL WHERE ecosystem = 'go'");
    await p.sync(store);
    expect(goAttribution(store)).toEqual(goAttributed('cmd', 'lock'));
  }, 120000);

});

describe('Go modules attribution through the CLI', () => {
  it('a go.sum-only change makes the index stale; sync re-attributes', () => {
    const root = tempDir('go-');
    try {
      write(root, GO_FILES);
      git(root, 'init', '-q');
      init(root);
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      mapx(root, 'scan');
      const errors = () => query<{ file_path: string; specifier: string; package: string | null; direct: number | null; dev: number | null; attribution: string | null }>(
        root, "SELECT file_path, specifier, package, direct, dev, attribution FROM external_refs WHERE ecosystem = 'go' AND kind = 'import' AND specifier = 'github.com/pkg/errors'")
        .map((r) => `${r.file_path} ${r.specifier} → ${r.package} ${r.direct} ${r.dev} ${r.attribution}`);
      expect(errors()).toEqual(['cmd/main.go github.com/pkg/errors → null 0 null lock']);
      expect(mapx(root, 'status')).toContain('Index is up to date');
      write(root, { 'go.sum': GO_SUM + sumLines('github.com/pkg/errors v0.9.1') });
      const status = mapx(root, 'status');
      expect(status).toContain('Index is stale');
      expect(status).toContain('go.sum');
      mapx(root, 'sync');
      expect(errors()).toEqual(['cmd/main.go github.com/pkg/errors → github.com/pkg/errors null null lock']);
      expect(mapx(root, 'status')).toContain('Index is up to date');
    } finally {
      cleanup(root);
    }
  }, 180000);
});

// ─── M5-24: package, builtin and ambient selectors; external dependencies in the rules ─────────

/** A scanned copy of a fixture app (removed after the test), with its configuration replaced when given. */
function scannedApp(app: string, config?: object, extra: Record<string, string> = {}): string {
  const root = join(tempDir('arch-'), app);
  cpSync(join(FIXTURE, app), root, { recursive: true });
  write(root, extra);
  init(root);
  for (const repo of REPOS[app] ?? []) {
    execFileSync('git', ['init', '-q', join(root, repo)]);
    mapx(root, 'workspaces', 'add', repo);
  }
  mapx(root, 'scan');
  if (config) writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify(config));
  return root;
}

/** An external element as the labels name it: ecosystem, origin, name (package, else specifier), direct, dev. */
const externalId = (r: { ecosystem: string; origin?: string | null; package?: string | null; specifier: string; direct?: boolean | null; dev?: boolean | null }) =>
  `${r.ecosystem} ${r.origin} ${r.package ?? r.specifier} direct=${r.direct} dev=${r.dev}`;
const memberId = (e: Element) => externalId({ ...e.external!, specifier: e.external!.name });

describe('the package, builtin and ambient selectors (M5-24)', () => {
  // Each selector, and which labelled rows it must select: its definition, restated on the labels.
  // Every package, one no input provides (package null) by its name as written (review of M5-24:
  // `"*"` must cover it, or nothing could, and `--fail-on-uncovered` would fail on it for good).
  const named = (l: Label) => l.origin === 'package';
  const SELECTORS: Array<[string, Layer['selectors'][number], (l: Label) => boolean]> = [
    ['package *', { package: '*' }, named],
    ['package * dev', { package: '*', dev: true }, (l) => named(l) && l.dev === true],
    ['package * production', { package: '*', dev: false }, (l) => named(l) && l.dev === false],
    ['package * direct', { package: '*', direct: true }, (l) => named(l) && l.direct === true],
    ['package * not direct', { package: '*', direct: false }, (l) => named(l) && l.direct === false],
    ['package guzzlehttp/*', { package: 'guzzlehttp/*' }, (l) => named(l) && /^guzzlehttp\//i.test(l.package ?? l.specifier)],
    ['package PyYAML (pypi: PEP 503)', { package: 'PyYAML' }, (l) => named(l) && l.package === 'pyyaml'],
    ['package golang.org/x/* (a / in the name)', { package: 'golang.org/x/*' }, (l) => named(l) && /^golang\.org\/x\//.test(l.package ?? l.specifier)],
    ['package github.com/pkg/* (an unattributed Go import, by its path)', { package: 'github.com/pkg/*' }, (l) => named(l) && /^github\.com\/pkg\//.test(l.package ?? l.specifier)],
    ['package PG (case-insensitive)', { package: 'PG' }, (l) => named(l) && l.package === 'pg'],
    ['builtin', { builtin: true }, (l) => l.origin === 'builtin'],
    ['builtin node:*', { builtin: 'node:*' }, (l) => l.origin === 'builtin' && /^node:/.test(l.package!)],
    ['builtin /^ext-/', { builtin: '/^ext-/' }, (l) => l.origin === 'builtin' && /^ext-/.test(l.package!)],
    ['ambient', { ambient: true }, (l) => l.origin === 'ambient'],
    ['ambient C', { ambient: 'C' }, (l) => l.origin === 'ambient' && l.package === 'C'],
  ];

  it.each(labels.apps)('select exactly the labelled external elements of %s, and never a file or symbol', (app) => {
    const root = scannedApp(app);
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const view = buildElementView(store, root);
      const layers: Layer[] = [
        ...SELECTORS.map(([name, selector]) => ({ name, selectors: [selector] })),
        // Nothing but an external selector applies to an external, and none applies to anything else.
        { name: 'not package', selectors: [{ not: { package: '*' } }] },
        { name: 'not path', selectors: [{ not: { path: 'nothing/**' } }] },
      ];
      const membership = computeMembership(view, { layers });
      const rows = labels.rows.filter((l) => l.app === app);
      const ids = (els: Element[]) => [...new Set(els.map((e) => (e.kind === 'external' ? memberId(e) : e.id)))].sort();
      const want = (pred: (l: Label) => boolean) => [...new Set(rows.filter(pred).map(externalId))].sort();
      for (const [name, , selects] of SELECTORS) expect(ids(membership.members(name)), `${app}: ${name}`).toEqual(want(selects));
      // `not package`: every external but a package (built-ins, ambient), and no file.
      expect(ids(membership.members('not package'))).toEqual(want((l) => !named(l)));
      // `not path` is no match on an external: every file and symbol, no external.
      expect(membership.members('not path').filter((e) => e.kind === 'external')).toEqual([]);
      expect(membership.members('not path').length).toBe(view.elements.length);
    } finally {
      store.close();
    }
  }, 180000);
});

describe('package names compare as each ecosystem compares them (review of M5-24)', () => {
  it('pypi: PEP 503; npm and Composer: case; Go: exact', () => {
    expect(namePattern('zope.interface', 'pypi')('zope-interface')).toBe(true);
    expect(namePattern('Flask_SQLAlchemy', 'pypi')('flask-sqlalchemy')).toBe(true);
    expect(namePattern('flask-*', 'pypi')('Flask_SQLAlchemy')).toBe(true);
    expect(namePattern('Flask_SQLAlchemy', 'npm')('flask-sqlalchemy')).toBe(false);
    expect(namePattern('@Acme/*', 'npm')('@acme/logging')).toBe(true);
    expect(namePattern('Monolog/Monolog', 'composer')('monolog/monolog')).toBe(true);
    expect(namePattern('github.com/Masterminds/*', 'go')('github.com/masterminds/semver')).toBe(false);
    expect(namePattern('github.com/Masterminds/*', 'go')('github.com/Masterminds/semver')).toBe(true);
  });
});

describe('external dependencies in the rules (M5-24)', () => {
  const shown = (r: ReturnType<typeof runArchitecture>) => r!.findings.filter((f) => f.target?.external)
    .map((f) => `${f.kind} ${f.rule} ${f.source!.element} -> ${f.target!.element} ${f.edgeType} [${f.target!.layer ?? ''}] ${f.target!.external!.origin}`).sort();

  it('decides each external reference like an edge; uncovered packages by default, built-ins only with uncovered.builtins', () => {
    const root = scannedApp('ts-vendor');
    const report = runArchitecture(root)!;
    expect(shown(report)).toEqual([
      'allowed undefined src/infrastructure/Database.ts#Database -> pg import [Database] package',
      'allowed undefined src/infrastructure/Database.ts#Database -> pg instantiation [Database] package',
      'uncovered uncovered src/infrastructure/Server.ts#Server -> express call [] package',
      'uncovered uncovered src/infrastructure/Server.ts#Server -> express import [] package',
      'violation disallowed-layer src/domain/Order.ts#Order -> lodash call [] package',
      'violation disallowed-layer src/domain/Order.ts#Order -> lodash import [] package',
      'violation disallowed-layer src/domain/Order.ts#Order -> pg import [Database] package',
      'violation disallowed-layer src/domain/Order.ts#Order -> pg instantiation [Database] package',
    ]);
    const pg = report.findings.find((f) => f.kind === 'violation' && f.target?.element === 'pg' && f.edgeType === 'import')!;
    expect(pg.target).toEqual({ element: 'pg', file: '', layer: 'Database', layers: ['Database'], external: { ecosystem: 'npm', origin: 'package', package: 'pg', direct: true, dev: false } });
    expect(pg.message).toBe('src/domain/Order.ts#Order must not depend on pg (Domain on Database)');
    // A vendor layer has elements, so no empty-layer warning; it has no files.
    expect(report.layers.find((l) => l.name === 'Database')).toMatchObject({ elements: 1, files: 0 });
    expect(report.findings.filter((f) => f.rule === 'empty-layer' || f.rule === 'unsupported-selector')).toEqual([]);

    const config = JSON.parse(readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8').replace(/^\/\/.*\n/, ''));
    writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({ ...config, policy: { uncovered: { externals: false, builtins: true } } }));
    expect(shown(runArchitecture(root)).filter((f) => f.startsWith('uncovered'))).toEqual([
      'uncovered uncovered src/infrastructure/Server.ts#Server -> node:fs call [] builtin',
      'uncovered uncovered src/infrastructure/Server.ts#Server -> node:fs import [] builtin',
    ]);
  }, 180000);

  it('a private package selector confines a package to its layer: a vendor-leak smell elsewhere', () => {
    const root = scannedApp('ts-vendor', {
      layers: [
        { name: 'Domain', selectors: [{ path: 'src/domain/**' }] },
        { name: 'Infrastructure', selectors: [{ path: 'src/infrastructure/**' }, { package: 'pg' }], private: [{ package: 'pg' }] },
      ],
      rules: { Domain: ['Infrastructure'], Infrastructure: ['Domain'] },
    });
    expect(shown(runArchitecture(root)).filter((f) => f.startsWith('violation'))).toEqual([
      'violation private-layer src/domain/Order.ts#Order -> pg import [Infrastructure] package',
      'violation private-layer src/domain/Order.ts#Order -> pg instantiation [Infrastructure] package',
    ]);
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const ctx = openArchitecture(root, store)!;
      const smells = ruleSmells(ctx, runArchitecture(root, { store })!).filter((s) => s.type === 'vendor-leak' || s.type === 'layer-violation');
      expect(smells.map((s) => `${s.type} ${s.involvedFiles.join(' ')}`)).toEqual(['vendor-leak src/domain/Order.ts']);
    } finally {
      store.close();
    }
  }, 180000);

  it('mapx arch allowed answers for an external by name, or by ecosystem and name', () => {
    const root = scannedApp('ts-vendor');
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const ctx = openArchitecture(root, store)!;
      const a = isAllowed(ctx, 'src/domain/Order.ts', 'npm:pg');
      expect({ allowed: a.allowed, rule: a.rule, to: a.to }).toEqual({
        allowed: false, rule: 'disallowed-layer',
        to: { query: 'npm:pg', kind: 'external', element: 'pg', layers: ['Database'], overlays: [], private: [], inScope: true },
      });
      expect(isAllowed(ctx, 'src/infrastructure/Database.ts', 'pg', { edgeType: 'import' }).allowed).toBe(true);
      expect(isAllowed(ctx, 'Infrastructure', 'lodash').rule).toBe('disallowed-layer'); // the DevOnly overlay
      // Review of M5-24: a built-in in no layer is not reported (uncovered.builtins false), as check decides.
      const fs = isAllowed(ctx, 'src/infrastructure/Server.ts', 'node:fs');
      expect({ allowed: fs.allowed, rule: fs.rule, severity: fs.severity }).toEqual({ allowed: true, rule: 'out-of-scope', severity: 'info' });
      expect(fs.reason).toContain('policy.uncovered.builtins is false');
      expect(isAllowed(ctx, 'src/infrastructure/Server.ts', 'express').rule).toBe('uncovered');
    } finally {
      store.close();
    }
  }, 180000);

  // D039 (M5-24-R4): a package in no layer is uncovered only when the configuration opts in, through
  // `policy.uncovered.externals: true` or a `package` selector in a layer; otherwise it is out of
  // scope, `--fail-on-uncovered` ignores it, and `mapx arch allowed` says so, as check decides.
  it('uncovered packages are opt-in: externals true or a package selector (M5-24-R4)', () => {
    const paths = [
      { name: 'Domain', selectors: [{ path: 'src/domain/**' }] },
      { name: 'Infrastructure', selectors: [{ path: 'src/infrastructure/**' }] },
    ];
    const rules = { Infrastructure: ['Domain', 'Database'], Domain: ['Database'] };
    const root = scannedApp('ts-vendor', { layers: paths, rules: { Infrastructure: ['Domain'] } });
    const decide = (config: { layers: object[]; rules?: object; policy?: object }) => {
      const layers = config.layers.map((l: any) => l.name);
      // Rules name only the layers the configuration has.
      const own = Object.fromEntries(Object.entries(config.rules ?? rules).map(([k, v]) => [k, (v as string[]).filter((t) => layers.includes(t))]).filter(([k]) => layers.includes(k)));
      writeFileSync(join(root, '.mapx/architecture.jsonc'), JSON.stringify({ ...config, rules: own }));
      const r = mapxResult(root, 'check', '--fail-on-uncovered', '--report-uncovered', '--format', 'json');
      const report = JSON.parse(r.stdout) as NonNullable<ReturnType<typeof runArchitecture>>;
      const uncovered = report.findings.filter((f) => f.kind === 'uncovered').map((f) => `${f.source!.element} -> ${f.target!.element} ${f.edgeType}`).sort();
      const store = new Store(join(root, '.mapx/mapx.db'));
      try {
        const a = isAllowed(openArchitecture(root, store)!, 'src/infrastructure/Server.ts', 'express');
        return {
          status: r.status, uncovered, count: report.counts.uncovered, externals: report.policy!.uncovered.externals,
          allowed: { allowed: a.allowed, rule: a.rule }, reason: a.reason, decisions: a.decisions.map((d) => `${d.edgeType} ${d.rule} observed=${d.observed}`),
        };
      } finally {
        store.close();
      }
    };
    const express = ['src/infrastructure/Server.ts#Server -> express call', 'src/infrastructure/Server.ts#Server -> express import'];
    const database = (selector: object, extra: object = {}) => ({ name: 'Database', selectors: [selector], ...extra });

    // No package selector, no `policy.uncovered.externals`: packages are out of scope. `arch allowed`
    // agrees, and still reports the two edge types the index has (import and call) as observed.
    const none = decide({ layers: paths });
    expect({ status: none.status, uncovered: none.uncovered, count: none.count, allowed: none.allowed, externals: none.externals })
      .toEqual({ status: 0, uncovered: [], count: 0, allowed: { allowed: true, rule: 'out-of-scope' }, externals: { value: false, source: 'default' } });
    expect(none.decisions).toEqual(['import out-of-scope observed=true', 'call out-of-scope observed=true']);
    expect(none.reason).toContain('policy.uncovered.externals is unset and no non-overlay layer has a package selector');
    // validate-config says the same.
    const v = mapxResult(root, 'arch', 'validate-config', '--format', 'json');
    expect(JSON.parse(v.stdout).policy).toEqual({ uncovered: { externals: { value: false, source: 'default' }, builtins: false } });
    expect(mapxResult(root, 'arch', 'validate-config').stdout).toContain('Packages in no layer: out of scope (policy.uncovered.externals is unset and no non-overlay layer has a package selector).');

    // `externals: true`: every package in no layer is uncovered (pg, lodash and express).
    const on = decide({ layers: paths, policy: { uncovered: { externals: true } } });
    expect(on.status).toBe(2);
    expect(on.uncovered).toEqual(expect.arrayContaining(express));
    expect(on.uncovered.every((u) => / -> (express|lodash|pg) /.test(u))).toBe(true);
    expect(on.allowed).toEqual({ allowed: true, rule: 'uncovered' });
    expect(on.externals).toEqual({ value: true, source: 'explicit', file: '.mapx/architecture.jsonc' });

    // A positive package selector in a non-overlay layer opts in, with any dev or direct filter, in
    // `selectors` or `private`, and inside `all` or `any` (D039 addendum).
    for (const layer of [
      database({ package: 'pg' }),
      database({ package: 'pg', dev: false }),
      database({ package: 'pg', direct: true }),
      database({ all: [{ package: 'pg' }] }),
      database({ any: [{ path: 'nothing/**' }, { package: 'pg' }] }),
      { name: 'Database', selectors: [{ path: 'nothing/**' }], private: [{ package: 'pg' }] },
    ]) {
      const opted = decide({ layers: [...paths, layer] });
      expect({ status: opted.status, allowed: opted.allowed, externals: opted.externals }, JSON.stringify(layer))
        .toEqual({ status: 2, allowed: { allowed: true, rule: 'uncovered' }, externals: { value: true, source: 'package-selector', layer: 'Database' } });
      expect(opted.uncovered, JSON.stringify(layer)).toEqual(expect.arrayContaining(express));
    }
    expect(decide({ layers: [...paths, database({ package: 'pg' })] }).uncovered.some((u) => / -> pg /.test(u))).toBe(false);

    // Not an opt-in: a package selector only under `not`, or only in an overlay layer (overlays never cover).
    for (const layers of [
      [paths[0]!, { ...paths[1]!, private: [{ not: { package: 'left-pad' } }] }],
      [paths[0]!, { name: 'Infrastructure', selectors: [{ all: [{ path: 'src/infrastructure/**' }, { not: { package: '*' } }] }] }],
      [...paths, { name: 'DevOnly', overlay: true, selectors: [{ package: '*', dev: true }] }],
    ]) {
      const out = decide({ layers });
      expect({ status: out.status, uncovered: out.uncovered, externals: out.externals }, JSON.stringify(layers)).toEqual({ status: 0, uncovered: [], externals: { value: false, source: 'default' } });
    }

    // An explicit `externals: false` wins over a package selector, and the reason names it.
    const off = decide({ layers: [...paths, database({ package: 'pg' })], policy: { uncovered: { externals: false } } });
    expect({ status: off.status, allowed: off.allowed, externals: off.externals })
      .toEqual({ status: 0, allowed: { allowed: true, rule: 'out-of-scope' }, externals: { value: false, source: 'explicit', file: '.mapx/architecture.jsonc' } });
    expect(off.reason).toContain('policy.uncovered.externals is false in .mapx/architecture.jsonc');
    expect(off.reason).not.toContain('package selector');
  }, 300000);

  const smellsOf = (app: string, extra: Record<string, string> = {}) => {
    const root = scannedApp(app, undefined, extra);
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const ctx = openArchitecture(root, store)!;
      return ruleSmells(ctx, runArchitecture(root, { store })!)
        .filter((s) => s.type === 'dev-dependency-in-prod' || s.type === 'undeclared-dependency').map((s) => s.description).sort();
    } finally {
      store.close();
    }
  };
  const dev = (file: string, pkg: string, eco = 'npm') => `Dev dependency in production code: ${file} uses ${pkg} (${eco}), which only the manifest's development dependencies hold`;
  const undeclared = (file: string, pkg: string, eco: string) => `Undeclared dependency: ${file} uses ${pkg} (${eco}), which its manifest does not list as a direct dependency`;

  it('dev-dependency-in-prod: a dev-only package in production code; configuration files are not production code', () => {
    // vitest.config.ts (role config) and .eslintrc.cjs (a conventional name) use dev packages: no smell.
    expect(smellsOf('ts-vendor', {
      'vitest.config.ts': "import get from 'lodash/get';\nexport default get({}, 'a');\n",
      'src/.eslintrc.cjs': "const get = require('lodash/get');\nmodule.exports = get({}, 'a');\n",
    })).toEqual([dev('src/domain/Order.ts', 'lodash')]);
  }, 180000);

  // Review of M5-24: one rule for the four ecosystems. The smell fires only for a named package a
  // readable manifest positively does not list directly (package known, direct false): never for one
  // no input provides, though Go stores direct false for those and pypi and Composer null.
  it.each([
    ['ts', 'npm', [['src/infrastructure/HttpGateway.ts', 'js-yaml'], ['src/infrastructure/Tooling.ts', 'debug'], ['src/infrastructure/Tooling.ts', 'left-pad'], ['src/infrastructure/Tooling.ts', 'semver']]],
    ['php', 'composer', [['app/Infrastructure/HttpGateway.php', 'doctrine/instantiator'], ['app/Infrastructure/HttpGateway.php', 'guzzlehttp/psr7'], ['app/Infrastructure/HttpGateway.php', 'myclabs/deep-copy'], ['app/Infrastructure/HttpGateway.php', 'nesbot/carbon'], ['app/Infrastructure/HttpGateway.php', 'psr/log']]],
    ['python', 'pypi', [['app/infrastructure/http_gateway.py', 'jinja2'], ['app/infrastructure/http_gateway.py', 'markupsafe'], ['app/infrastructure/http_gateway.py', 'pluggy'], ['app/infrastructure/http_gateway.py', 'pysocks'], ['app/infrastructure/http_gateway.py', 'urllib3']]],
    ['go', 'go', [['infrastructure/http_gateway_test.go', 'gopkg.in/yaml.v3'], ['infrastructure/system_probe.go', 'golang.org/x/sys']]],
  ] as const)('undeclared-dependency in %s (%s): the labelled transitive and unlisted packages, never an unattributed one', (app, eco, rows) => {
    const got = smellsOf(app).filter((d) => d.startsWith('Undeclared'));
    expect(got).toEqual(rows.map(([file, pkg]) => undeclared(file, pkg, eco)).sort());
    // The definition, on the labels: a known package, direct false.
    expect(rows.map(([file, pkg]) => `${file} ${pkg}`).sort()).toEqual([...new Set(labels.rows
      .filter((l) => l.app === app && l.origin === 'package' && l.package !== null && l.direct === false).map((l) => `${l.file} ${l.package}`))].sort());
    // Unattributed: Go's github.com/pkg/errors (direct false), pypi's sklearn, Composer's Illuminate\Support\Str (direct null).
    expect(got.some((d) => /pkg\/errors|sklearn|acme_missing|Illuminate|collect|Acme/.test(d))).toBe(false);
  }, 180000);
});

// M5-19-R1: the end-of-run pass records the attribution-rules version beside its inputs. The next
// sync decides the attribution of an index whose record an older version wrote again, from the
// stored candidates. No file is parsed and EXTRACTOR_VERSION is not involved. Synthetic, labelled:
// `\Redis` (a PECL class, ambient since M5-21-R1) and GO_FILES. The rows an older MapX stored are
// simulated: Redis as an unknown class, uuid flagged manifest.
describe.each([
  ['git sync', true],
  ['hash sync', false],
] as const)('an attribution-rules version (M5-19-R1), on a %s', (_name, withGit) => {
  const p = project(withGit);
  const files = {
    ...GO_FILES,
    'composer.json': COMPOSER_MANIFEST,
    'composer.lock': COMPOSER_LOCK,
    'app/Cache.php': '<?php\nnamespace App;\n\nclass Cache { public function open() { return new \\Redis(); } }\n',
  };
  const attribution = (store: Store) => [...composerAttribution(store), ...goAttribution(store)];
  /** Scans, then makes the stored rows and the record what an index built by older rules holds. */
  const olderIndex = async (rules: number | undefined) => {
    p.create(files);
    const store = new Store(':memory:');
    await (await p.scanner(store)).scanFull();
    const current = attribution(store);
    const old = store.getExternalCandidates().flatMap((c): ExternalDecision[] => c.specifier === 'Redis'
      ? [{ id: c.id, external: 1, package: null, origin: 'package', direct: null, dev: null, attribution: 'lock' }]
      : c.specifier === 'github.com/google/uuid' ? [{ id: c.id, external: 1, package: c.package, origin: c.origin, direct: c.direct, dev: c.dev, attribution: 'manifest' }] : []);
    // uuid: its import and its call.
    expect(old.map((d) => d.package ?? 'Redis').sort()).toEqual(['Redis', 'github.com/google/uuid', 'github.com/google/uuid']);
    store.setExternalDecisions(old);
    const record = JSON.parse(store.getMeta(EXTERNAL_INPUTS_KEY)!);
    expect(record.rules).toBe(ATTRIBUTION_VERSION);
    if (rules === undefined) delete record.rules;
    else record.rules = rules;
    store.setMeta(EXTERNAL_INPUTS_KEY, JSON.stringify(record));
    return { store, current };
  };

  it.each([
    ['the previous version', ATTRIBUTION_VERSION - 1],
    ['no version (recorded before M5-19-R1)', undefined],
  ] as const)('an index recorded by %s: the next sync attributes every row by the current rules, parsing no file', async (_label, rules) => {
    const { store, current } = await olderIndex(rules);
    expect(current).toContain('app/Cache.php:4 Redis instantiation → ext-redis ambient null null null');
    expect(current).toContain('cmd/main.go:7 github.com/google/uuid → github.com/google/uuid package 1 0 lock');
    expect(attribution(store)).toContain('app/Cache.php:4 Redis instantiation → null package null null lock');
    const repo = store.getRepoNames()[0]!;
    const extractor = store.getMeta(extractorVersionKey(repo));
    const result = await p.sync(store);
    expect(result.filesScanned).toBe(0);
    expect(store.getMeta(extractorVersionKey(repo))).toBe(extractor);
    expect(attribution(store)).toEqual(current);
    expect(dumpAll(store)).toEqual(dumpAll(await p.forced()));
    expect(JSON.parse(store.getMeta(EXTERNAL_INPUTS_KEY)!).rules).toBe(ATTRIBUTION_VERSION);
  }, 120000);

  it('an index recorded by the current version keeps its stored attribution while its inputs stand', async () => {
    const { store } = await olderIndex(ATTRIBUTION_VERSION);
    const stored = attribution(store);
    expect((await p.sync(store)).filesScanned).toBe(0);
    expect(attribution(store)).toEqual(stored);
  }, 120000);
});
