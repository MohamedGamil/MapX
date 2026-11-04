import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cleanup, init, mapx, query, useBuiltCli, workspace } from './helpers/e2e.js';
import { isGitRepo } from '../src/core/git-tracker.js';

// M0-02-R13: a package.json edit re-parses only the files it affects. Sync reads what resolution reads
// of a manifest, per field (dependencies by name, `name` and entry fields of workspace packages, the
// store-library gate, alias roots, module roots), so `version`, `scripts` and the like re-parse
// nothing, and a nested package with its own manifest is left alone by its parent's edit.
// Every test also checks that sync gives what `scan --force` gives.
useBuiltCli();

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' });

const PINIA_STORE = `import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useWish = defineStore('wish', () => {
  const items = ref<string[]>([]);
  function add(item: string) { items.value.push(item); }
  return { items, add };
});
`;
// The same store without the import, for a package that must not mention the library.
const BARE_STORE = PINIA_STORE.split('\n').filter((l) => !l.includes("from 'pinia'")).join('\n');
const HOOK_USER = `import { useWish } from '../stores/wish';

export function useWishAdd() {
  const w = useWish();
  function addOne(item: string) {
    w.add(item);
  }
  return { addOne };
}
`;

/** A workspace under test: files, optional git, a scan, then edits followed by syncs. */
class Lab {
  readonly root: string;
  constructor(files: Record<string, string>, private readonly withGit: boolean, cwd = '') {
    this.root = workspace({ '.gitignore': '.mapx/\n', ...files });
    if (withGit) {
      git(this.root, 'init', '-q');
      git(this.root, 'add', '-A');
      git(this.root, 'commit', '-qm', 'init');
    } else {
      // A `.git` folder git does not read: sync takes the hash path, the repository root stays known.
      mkdirSync(join(this.root, '.git'));
    }
    init(this.dir(cwd));
    mapx(this.dir(cwd), 'scan', '.');
    this.cwd = this.dir(cwd);
    expect(isGitRepo(this.cwd)).toBe(withGit);
  }
  readonly cwd: string;
  private dir(cwd: string) { return cwd ? join(this.root, cwd) : this.root; }
  /** Writes files; a file given as null is deleted. */
  write(files: Record<string, string | null>) {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(this.root, path));
        continue;
      }
      mkdirSync(join(this.root, path, '..'), { recursive: true });
      writeFileSync(join(this.root, path), text);
    }
    if (this.withGit) {
      git(this.root, 'add', '-A');
      git(this.root, 'commit', '-qm', 'edit', '--allow-empty');
    }
  }
  scannedAt(): Record<string, string> {
    return Object.fromEntries(query<{ path: string; last_scanned: string }>(this.cwd, 'SELECT path, last_scanned FROM files').map((f) => [f.path, f.last_scanned]));
  }
  /** Edits, syncs, and gives the files the sync parsed again. */
  sync(files: Record<string, string | null>): string[] {
    this.write(files);
    const before = this.scannedAt();
    mapx(this.cwd, 'sync', '.');
    const after = this.scannedAt();
    return Object.keys(after).filter((p) => after[p] !== before[p]).sort();
  }
  /** Everything a parse leaves: edges, symbols, external-reference candidates. */
  state() {
    return {
      edges: query(this.cwd, 'SELECT source_file, source_symbol, edge_type, target_file, target_symbol, verifiability, metadata FROM edges ORDER BY 1, 2, 3, 4, 5, 6, 7'),
      symbols: query(this.cwd, 'SELECT file_path, name, kind, scope, start_line, end_line FROM symbols ORDER BY 1, 2, 3, 4, 5, 6'),
      external: query(this.cwd, 'SELECT file_path, line, specifier, symbol, kind, ecosystem, external, package, origin, direct, dev FROM external_ref_candidates ORDER BY 1, 2, 3, 4, 5, 6'),
    };
  }
  /** What the files give now equals what a forced scan gives. */
  expectForce() {
    const synced = this.state();
    mapx(this.cwd, 'scan', '.', '--force');
    expect(synced).toEqual(this.state());
  }
  edges(file: string, type?: string) {
    return query<{ t: string }>(this.cwd,
      `SELECT edge_type || ' ' || target_file || coalesce('#' || target_symbol, '') AS t FROM edges WHERE source_file = ? ${type ? "AND edge_type = '" + type + "'" : ''} ORDER BY 1`, file).map((e) => e.t);
  }
  done() { cleanup(this.root); }
}

const json = (value: unknown) => JSON.stringify(value);

const SHOP = {
  name: 'shop', version: '1.0.0', description: 'a shop', scripts: { build: 'tsc' },
  dependencies: { vue: '^3.4.0', lodash: '^4.0.0' }, devDependencies: { vitest: '^1.0.0' },
};
const NESTED = { name: 'admin', version: '1.0.0', dependencies: { vue: '^3.4.0', lodash: '^4.0.0' } };

const shop = (extra: Record<string, string> = {}) => ({
  'package.json': json(SHOP),
  'src/a.ts': "import _ from 'lodash';\nexport function a() { return _.map([1], (x) => x); }\n",
  'src/b.ts': "import { a } from './a';\nexport const b = () => a();\n",
  'src/stores/wish.ts': PINIA_STORE,
  'src/composables/useWishAdd.ts': HOOK_USER,
  'src/api/orders.ts': 'export function add(x: string) { return x; }\n',
  'src/App.vue': '<template><div /></template>\n<script setup lang="ts">\nconst x = 1;\n</script>\n',
  'src/schema.ts': "import { z } from 'zod';\nexport const s = z.string();\n",
  'py/x.py': 'def f():\n    pass\n',
  // A nested package with its own manifest: it lists vue and lodash, not pinia or zod.
  'packages/admin/package.json': json(NESTED),
  'packages/admin/src/util.ts': "import _ from 'lodash';\nexport const u = () => _.noop();\n",
  'packages/admin/src/schema.ts': "import { z } from 'zod';\nexport const s = z.number();\n",
  'packages/admin/src/stores/wish.ts': BARE_STORE,
  'packages/admin/src/composables/useWishAdd.ts': HOOK_USER,
  ...extra,
});

const VARIANTS = [['git sync', true], ['hash sync', false]] as const;

describe.each(VARIANTS)('a %s of package.json fields no resolution reads', (_name, withGit) => {
  let lab: Lab;
  beforeAll(() => { lab = new Lab(shop(), withGit); }, 120000);
  afterAll(() => lab.done());

  it('re-parses nothing for version, scripts, description, keywords or a dependency range', () => {
    // Criterion 1: `version` and `scripts` re-parse 0 files, nested package and Python file included.
    expect(lab.sync({ 'package.json': json({ ...SHOP, version: '2.0.0' }) })).toEqual([]);
    expect(lab.sync({ 'package.json': json({ ...SHOP, version: '2.0.0', scripts: { build: 'tsc -b', lint: 'eslint .' } }) })).toEqual([]);
    expect(lab.sync({ 'package.json': json({ ...SHOP, version: '2.0.0', scripts: { build: 'tsc -b', lint: 'eslint .' }, description: 'b', keywords: ['k'], license: 'MIT', engines: { node: '>=20' } }) })).toEqual([]);
    // A range bump keeps lodash a registry dependency; a dependency no file imports is no input either.
    const range = { ...SHOP, version: '2.0.0', scripts: { build: 'tsc -b' }, dependencies: { vue: '^3.4.0', lodash: '^4.17.21' }, devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' } };
    expect(lab.sync({ 'package.json': json(range) })).toEqual([]);
    // The same dependency moved between sections is the same listing.
    expect(lab.sync({ 'package.json': json({ ...range, dependencies: { vue: '^3.4.0' }, devDependencies: { ...range.devDependencies, lodash: '^4.17.21' } }) })).toEqual([]);
    // The nested package's own manifest too.
    expect(lab.sync({ 'packages/admin/package.json': json({ ...NESTED, version: '9.9.9', scripts: { test: 'vitest' } }) })).toEqual([]);
    lab.expectForce();
  }, 180000);
});

describe.each(VARIANTS)('a %s after a dependency is added to or removed from package.json', (_name, withGit) => {
  let lab: Lab;
  beforeAll(() => { lab = new Lab(shop(), withGit); }, 120000);
  afterAll(() => lab.done());

  const manifest = (dependencies: Record<string, string>) => json({ ...SHOP, dependencies });

  it('re-parses the files that import it, not a nested package that lists it itself', () => {
    // Removing lodash: the root's importer; the nested package lists lodash itself, so it keeps its answer.
    expect(lab.sync({ 'package.json': manifest({ vue: '^3.4.0' }) })).toEqual(['src/a.ts']);
    lab.expectForce();
    expect(lab.sync({ 'package.json': manifest({ vue: '^3.4.0', lodash: '^4.0.0' }) })).toEqual(['src/a.ts']);
    lab.expectForce();
  }, 180000);

  it('re-parses a nested file that imports a name only the outer manifest lists', () => {
    // The nested package has no zod of its own: the outer listing is the one its import finds.
    expect(lab.sync({ 'package.json': manifest({ vue: '^3.4.0', lodash: '^4.0.0', zod: '^3.0.0' }) })).toEqual(['packages/admin/src/schema.ts', 'src/schema.ts']);
    lab.expectForce();
    expect(lab.sync({ 'package.json': manifest({ vue: '^3.4.0', lodash: '^4.0.0' }) })).toEqual(['packages/admin/src/schema.ts', 'src/schema.ts']);
    lab.expectForce();
  }, 180000);

  it('re-parses the importers when a registry dependency becomes a workspace link, and back', () => {
    expect(lab.sync({ 'package.json': manifest({ vue: '^3.4.0', lodash: 'workspace:*' }) })).toEqual(['src/a.ts']);
    lab.expectForce();
    expect(lab.sync({ 'package.json': manifest({ vue: '^3.4.0', lodash: '^4.0.0' }) })).toEqual(['src/a.ts']);
    lab.expectForce();
  }, 180000);
});

describe.each(VARIANTS)('a %s after pinia is added to or removed from package.json', (_name, withGit) => {
  const HOOK = 'src/composables/useWishAdd.ts';
  const NESTED_HOOK = 'packages/admin/src/composables/useWishAdd.ts';
  let lab: Lab;
  const withPinia = (extra: Record<string, unknown> = {}) => json({ ...SHOP, dependencies: { vue: '^3.4.0', lodash: '^4.0.0', pinia: '^2.1.0' }, ...extra });
  const without = (extra: Record<string, unknown> = {}) => json({ ...SHOP, ...extra });
  beforeAll(() => { lab = new Lab(shop(), withGit); }, 120000);
  afterAll(() => lab.done());

  it('re-parses the modules the gate governs, and links the hook call as scan --force does', () => {
    expect(lab.edges(HOOK, 'call')).not.toContain('call src/stores/wish.ts#add');
    // The governed modules: the one calling a hook (the gate decides it) and the store importing pinia
    // (its import is now a package). Not the other sources, the nested package or the Python file.
    expect(lab.sync({ 'package.json': withPinia() })).toEqual([HOOK, 'src/stores/wish.ts']);
    lab.expectForce();
    expect(lab.edges(HOOK, 'call')).toContain('call src/stores/wish.ts#add');
    expect(lab.sync({ 'package.json': without() })).toEqual([HOOK, 'src/stores/wish.ts']);
    lab.expectForce();
    expect(lab.edges(HOOK, 'call')).not.toContain('call src/stores/wish.ts#add');
  }, 180000);

  it('leaves a nested package with its own manifest alone, unless the workspace root lists it', () => {
    // Criterion 2: the nested package lists its own dependencies; pinia at the root is not its own.
    expect(lab.sync({ 'package.json': withPinia() })).not.toContain(NESTED_HOOK);
    expect(lab.edges(NESTED_HOOK, 'call')).not.toContain('call packages/admin/src/stores/wish.ts#add');
    lab.expectForce();
    // The root becomes a workspace root listing it: its pinia counts there, and only the hook caller is re-parsed.
    expect(lab.sync({ 'package.json': withPinia({ workspaces: ['packages/*'] }) })).toEqual([NESTED_HOOK]);
    lab.expectForce();
    expect(lab.edges(NESTED_HOOK, 'call')).toContain('call packages/admin/src/stores/wish.ts#add');
    // A workspace list that does not name the package lends nothing again.
    expect(lab.sync({ 'package.json': withPinia({ workspaces: ['apps/*'] }) })).toEqual([NESTED_HOOK]);
    lab.expectForce();
    expect(lab.edges(NESTED_HOOK, 'call')).not.toContain('call packages/admin/src/stores/wish.ts#add');
  }, 180000);
});

describe.each(VARIANTS)('a %s after the build tool or module roots a package.json declares change', (_name, withGit) => {
  let lab: Lab;
  const files = {
    ...shop(),
    'src/lib/helper.js': 'export function help() { return 1; }\n',
    'src/app.js': "import { help } from 'lib/helper';\nexport const go = () => help();\n",
  };
  beforeAll(() => { lab = new Lab(files, withGit); }, 120000);
  afterAll(() => lab.done());

  it('follows a NODE_PATH script, not the other scripts, and leaves a nested package with its own NODE_PATH alone', () => {
    expect(lab.edges('src/app.js', 'import')).toEqual([]);
    // The nested package sets its own NODE_PATH: it no longer sees an enclosing one.
    expect(lab.sync({ 'packages/admin/package.json': json({ ...NESTED, scripts: { start: 'NODE_PATH=lib node src/util.ts' } }) })).toEqual([
      'packages/admin/src/composables/useWishAdd.ts', 'packages/admin/src/schema.ts', 'packages/admin/src/stores/wish.ts', 'packages/admin/src/util.ts',
    ]);
    const withPath = json({ ...SHOP, scripts: { build: 'tsc', start: 'NODE_PATH=src node src/app.js' } });
    const reparsed = lab.sync({ 'package.json': withPath });
    // Its module roots govern the package's sources: not the nested package, nor the Python file.
    expect(reparsed).toContain('src/app.js');
    expect(reparsed.some((p) => p.startsWith('packages/') || p.endsWith('.py'))).toBe(false);
    expect(lab.edges('src/app.js', 'import')).toEqual(['import src/lib/helper.js#lib/helper']);
    lab.expectForce();
    // Another script changes: nothing is re-parsed.
    expect(lab.sync({ 'package.json': json({ ...SHOP, scripts: { build: 'tsc', start: 'NODE_PATH=src node src/app.js', lint: 'eslint' } }) })).toEqual([]);
    // The path leaves: the edge goes.
    expect(lab.sync({ 'package.json': json(SHOP) })).toContain('src/app.js');
    expect(lab.edges('src/app.js', 'import')).toEqual([]);
    lab.expectForce();
  }, 180000);

  it('follows a jest moduleDirectories key', () => {
    const jest = json({ ...SHOP, jest: { moduleDirectories: ['node_modules', 'src'] } });
    expect(lab.sync({ 'package.json': jest })).toContain('src/app.js');
    expect(lab.edges('src/app.js', 'import')).toEqual(['import src/lib/helper.js#lib/helper']);
    lab.expectForce();
    // A jest key that declares no root, with none above to shadow: nothing changes for the files.
    expect(lab.sync({ 'package.json': json({ ...SHOP, jest: { verbose: true } }) })).toContain('src/app.js');
    expect(lab.edges('src/app.js', 'import')).toEqual([]);
    expect(lab.sync({ 'package.json': json({ ...SHOP, jest: { verbose: false } }) })).toEqual([]);
    lab.expectForce();
  }, 180000);

  it('re-parses a package that takes the enclosing app\'s aliases, not a nested app of its own', () => {
    const files2 = {
      'package.json': json({ ...SHOP, devDependencies: {} }),
      'src/main.ts': 'export const m = 1;\n',
      'packages/lib/package.json': json({ name: 'lib', dependencies: { vue: '^3.4.0' } }),
      'packages/lib/src/x.ts': 'export const x = 1;\n',
      'packages/app/package.json': json({ name: 'app', dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      'packages/app/src/y.ts': 'export const y = 1;\n',
    };
    const second = new Lab(files2, withGit);
    try {
      // The root becomes an app: a package without a build of its own takes its aliases.
      expect(second.sync({ 'package.json': json({ ...SHOP, devDependencies: { vite: '^5.0.0' } }) })).toEqual(['packages/lib/src/x.ts', 'src/main.ts']);
      second.expectForce();
    } finally {
      second.done();
    }
  }, 180000);
});

describe.each(VARIANTS)('a %s after the entry of a workspace package changes', (_name, withGit) => {
  let lab: Lab;
  const common = (extra: Record<string, unknown>) => json({ name: '@acme/common', version: '1.0.0', main: 'src/index.ts', ...extra });
  const files = {
    'package.json': json({ name: 'mono', private: true, version: '1.0.0' }),
    'packages/common/package.json': common({}),
    'packages/common/src/index.ts': 'export function fmt(x: string) { return x; }\n',
    'packages/common/src/legacy.ts': 'export function fmt(x: string) { return x + "!"; }\n',
    'packages/common/src/inner.ts': "import { fmt } from './index';\nexport const inner = () => fmt('a');\n",
    'packages/app/package.json': json({ name: 'app', dependencies: { '@acme/common': 'workspace:*' } }),
    'packages/app/src/use.ts': "import { fmt } from '@acme/common';\nexport const run = () => fmt('x');\n",
    'packages/other/package.json': json({ name: 'other', dependencies: { lodash: '^4.0.0' } }),
    'packages/other/src/z.ts': "import _ from 'lodash';\nexport const z = () => _.noop();\n",
  };
  beforeAll(() => { lab = new Lab(files, withGit); }, 120000);
  afterAll(() => lab.done());

  it('re-parses the importers wherever they are, not the package\'s own files', () => {
    expect(lab.edges('packages/app/src/use.ts', 'import')).toEqual(['import packages/common/src/index.ts#@acme/common']);
    // `main` moves: the importer in another package follows it.
    expect(lab.sync({ 'packages/common/package.json': common({ main: 'src/legacy.ts' }) })).toEqual(['packages/app/src/use.ts']);
    expect(lab.edges('packages/app/src/use.ts', 'import')).toEqual(['import packages/common/src/legacy.ts#@acme/common']);
    lab.expectForce();
    // `exports` moves it again; `version` and `scripts` do not.
    expect(lab.sync({ 'packages/common/package.json': common({ main: 'src/legacy.ts', version: '2.0.0', scripts: { build: 'tsc' } }) })).toEqual([]);
    expect(lab.sync({ 'packages/common/package.json': common({ main: 'src/legacy.ts', exports: { '.': './src/index.ts' } }) })).toEqual(['packages/app/src/use.ts']);
    expect(lab.edges('packages/app/src/use.ts', 'import')).toEqual(['import packages/common/src/index.ts#@acme/common']);
    lab.expectForce();
  }, 180000);

  it('re-parses the importers of the old and the new name when the package is renamed', () => {
    expect(lab.sync({ 'packages/common/package.json': common({ name: '@acme/shared' }) })).toEqual(['packages/app/src/use.ts']);
    expect(lab.edges('packages/app/src/use.ts', 'import')).toEqual([]);
    lab.expectForce();
    expect(lab.sync({ 'packages/common/package.json': common({}) })).toEqual(['packages/app/src/use.ts']);
    expect(lab.edges('packages/app/src/use.ts', 'import')).toEqual(['import packages/common/src/index.ts#@acme/common']);
    lab.expectForce();
  }, 180000);
});

describe.each(VARIANTS)('a %s of a package below its monorepo root', (_name, withGit) => {
  const HOOK = 'src/composables/useWishAdd.ts';
  let lab: Lab;
  const rootManifest = (extra: Record<string, unknown>) => json({ private: true, version: '1.0.0', workspaces: ['packages/*'], dependencies: { vue: '^3.4.0', pinia: '^2.1.0' }, ...extra });
  beforeAll(() => {
    lab = new Lab({
      'package.json': rootManifest({}),
      'packages/app/package.json': json({ name: 'app', dependencies: { lodash: '^4.0.0' } }),
      'packages/app/src/stores/wish.ts': BARE_STORE,
      [`packages/app/${HOOK}`]: HOOK_USER,
      'packages/app/src/plain.ts': 'export const p = 1;\n',
    }, withGit, 'packages/app');
  }, 120000);
  afterAll(() => lab.done());

  it('re-parses nothing for the root\'s version or scripts, and the gate\'s callers for its pinia', () => {
    expect(lab.edges(HOOK, 'call')).toContain('call src/stores/wish.ts#add');
    const outer = (files: Record<string, string>) => lab.sync(files);
    expect(outer({ 'package.json': rootManifest({ version: '2.0.0', scripts: { build: 'turbo run build' } }) })).toEqual([]);
    expect(outer({ 'package.json': rootManifest({ dependencies: { vue: '^3.4.0' } }) })).toEqual([HOOK]);
    expect(lab.edges(HOOK, 'call')).not.toContain('call src/stores/wish.ts#add');
    lab.expectForce();
    expect(outer({ 'package.json': rootManifest({}) })).toEqual([HOOK]);
    expect(lab.edges(HOOK, 'call')).toContain('call src/stores/wish.ts#add');
    lab.expectForce();
  }, 180000);
});

describe.each(VARIANTS)('a %s after a nested package.json is removed and added back', (_name, withGit) => {
  const NESTED_HOOK = 'packages/admin/src/composables/useWishAdd.ts';
  let lab: Lab;
  beforeAll(() => {
    lab = new Lab(shop({ 'package.json': json({ ...SHOP, dependencies: { vue: '^3.4.0', lodash: '^4.0.0', pinia: '^2.1.0' } }) }), withGit);
  }, 120000);
  afterAll(() => lab.done());

  it('puts the package under the enclosing manifest, then back, as scan --force does', () => {
    // Its own manifest keeps the root's pinia from it; without one it is a folder of the root package.
    expect(lab.edges(NESTED_HOOK, 'call')).not.toContain('call packages/admin/src/stores/wish.ts#add');
    const removed = lab.sync({ 'packages/admin/package.json': null });
    expect(removed).toContain(NESTED_HOOK);
    expect(removed.some((p) => !p.startsWith('packages/admin/'))).toBe(false);
    lab.expectForce();
    expect(lab.edges(NESTED_HOOK, 'call')).toContain('call packages/admin/src/stores/wish.ts#add');
    const added = lab.sync({ 'packages/admin/package.json': json(NESTED) });
    expect(added).toContain(NESTED_HOOK);
    expect(added.some((p) => !p.startsWith('packages/admin/'))).toBe(false);
    lab.expectForce();
    expect(lab.edges(NESTED_HOOK, 'call')).not.toContain('call packages/admin/src/stores/wish.ts#add');
  }, 180000);
});

describe('a package.json that gains an auto-import tool', () => {
  it('re-parses the JS files below it: their un-imported names become global, as scan --force has it', () => {
    // `unplugin-auto-import` is no build tool, so only the auto-import reader sees it.
    const lab = new Lab({
      'package.json': json({ name: 'app', version: '1.0.0' }),
      'src/lib.js': 'export function create() { return 1; }\n',
      'src/use.js': 'export const c = () => create();\n',
      'py/x.py': 'def f():\n    pass\n',
    }, false);
    try {
      expect(lab.edges('src/use.js', 'call')).toEqual([]);
      const reparsed = lab.sync({ 'package.json': json({ name: 'app', version: '1.0.0', devDependencies: { 'unplugin-auto-import': '^0.17.0' } }) });
      expect(reparsed).toEqual(['src/lib.js', 'src/use.js']);
      expect(lab.edges('src/use.js', 'call')).toEqual(['call src/lib.js#create']);
      lab.expectForce();
      expect(lab.sync({ 'package.json': json({ name: 'app', version: '2.0.0', devDependencies: { 'unplugin-auto-import': '^0.18.0' } }) })).toEqual([]);
    } finally {
      lab.done();
    }
  }, 180000);
});

describe('sync after the config record of an older MapX', () => {
  it('only records the manifest fields once, without re-parsing, then follows a real change', () => {
    const lab = new Lab(shop(), false);
    try {
      const configs = () => query<{ key: string; value: string }>(lab.cwd, "SELECT key, value FROM meta WHERE key LIKE 'js_configs:%'");
      const [row] = configs();
      expect(row).toBeDefined();
      // The record as it was: the folder hashes package.json (and the nested folder's own), the manifest fields absent.
      const record = JSON.parse(row!.value) as Record<string, string>;
      const legacy = Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith('\0pkg:') && !k.startsWith('\0view:') && !k.startsWith('\0ign:') && k !== '#manifests'));
      legacy[''] = createHash('md5').update('package.json\0').update(json(SHOP)).digest('hex');
      legacy['packages/admin'] = createHash('md5').update('package.json\0').update(json(NESTED)).digest('hex');
      const db = new Database(join(lab.cwd, '.mapx', 'mapx.db'));
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(legacy), row!.key);
      db.close();
      expect(lab.sync({})).toEqual([]);
      expect(JSON.parse(configs()[0]!.value)['#manifests']).toBe('1');
      // From here on a real change is followed, and a version bump is not.
      expect(lab.sync({ 'package.json': json({ ...SHOP, version: '3.0.0' }) })).toEqual([]);
      expect(lab.sync({ 'package.json': json({ ...SHOP, version: '3.0.0', dependencies: { vue: '^3.4.0' } }) })).toEqual(['src/a.ts']);
      lab.expectForce();
    } finally {
      lab.done();
    }
  }, 180000);
});

describe('a package.json edit that moves a Vue scope', () => {
  it('re-scopes a nested app that becomes a library through its scripts, as scan --force does', () => {
    const lab = new Lab({
      'package.json': json({ name: 'app', dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      'src/main.js': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport Btn from './Btn.vue';\nconst app = createApp(App);\napp.component('Btn', Btn);\napp.mount('#app');\n",
      'src/App.vue': '<template><div /></template>\n',
      'src/Btn.vue': '<template><b /></template>\n',
      'widgets/package.json': json({ name: 'widgets', scripts: { build: 'vite build' }, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }),
      'widgets/Panel.vue': '<template>\n  <btn />\n</template>\n',
    }, true);
    try {
      const renders = () => lab.edges('widgets/Panel.vue', 'render');
      expect(renders()).toEqual([]);
      lab.sync({ 'widgets/package.json': json({ name: 'widgets', scripts: { build: 'vue-cli-service build --target lib' }, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }) });
      expect(renders()).toEqual(['render src/Btn.vue#Btn']);
      lab.expectForce();
    } finally {
      lab.done();
    }
  }, 180000);
});

describe.each(VARIANTS)('a %s after vue or vue-router is added to or removed from package.json', (_name, withGit) => {
  // A vue or vue-router dependency activates the vue-router detector, whose ignore list (`ref`, `watch`,
  // `t`, `d`, `useStore`, ...) every parse drops calls of, in every language (M0-02-R13, review P1-1, P1-2).
  const PLAIN = { name: 'app', version: '1.0.0', dependencies: { lodash: '^4.0.0' } };
  const withDeps = (dependencies: Record<string, string>) => json({ ...PLAIN, dependencies });
  const files = {
    'package.json': json(PLAIN),
    'src/util.ts': "export const t = (k: string) => k;\nexport function ref(x: number) { return x; }\nexport const n = 5;\n",
    'src/use.ts': "import { ref, t } from './util';\nexport const u = () => ref(1) + t('x');\n",
    'src/plain.ts': 'export const q = 1;\n',
    'api/util.py': 'def t(x):\n    return x\n\n\ndef watch():\n    return t(1)\n',
    'api/use.py': 'from util import t\n\n\ndef g():\n    return t(2)\n',
    'py/x.py': 'def f():\n    pass\n',
    'packages/admin/package.json': json({ name: 'admin', dependencies: { lodash: '^4.0.0' } }),
    'packages/admin/src/i18n.ts': "export const d = (x: string) => x;\nexport const useIt = () => d('a');\n",
  };
  const NAMED = ['api/use.py', 'api/util.py', 'packages/admin/src/i18n.ts', 'src/use.ts', 'src/util.ts'];
  let lab: Lab;
  beforeAll(() => { lab = new Lab(files, withGit); }, 120000);
  afterAll(() => lab.done());

  it('re-parses the files of any language that hold a name the list ignores, as scan --force does', () => {
    expect(lab.edges('src/use.ts', 'call')).toEqual(['call src/util.ts#ref', 'call src/util.ts#t']);
    expect(lab.edges('api/use.py', 'call')).toEqual(['call api/util.py#t']);
    // The files that name none of them (`q`, `f`) parse the same either way.
    expect(lab.sync({ 'package.json': withDeps({ lodash: '^4.0.0', vue: '^3.4.0' }) })).toEqual(NAMED);
    expect(lab.edges('src/use.ts', 'call')).toEqual([]);
    expect(lab.edges('api/use.py', 'call')).toEqual([]);
    lab.expectForce();
    // vue-router joins vue: the activation is the same, so the lists are too.
    expect(lab.sync({ 'package.json': withDeps({ lodash: '^4.0.0', vue: '^3.4.0', 'vue-router': '^4.0.0' }) })).toEqual([]);
    expect(lab.sync({ 'package.json': withDeps({ lodash: '^4.0.0', 'vue-router': '^4.0.0' }) })).toEqual([]);
    // Both leave: the calls link again.
    expect(lab.sync({ 'package.json': withDeps({ lodash: '^4.0.0' }) })).toEqual(NAMED);
    expect(lab.edges('src/use.ts', 'call')).toEqual(['call src/util.ts#ref', 'call src/util.ts#t']);
    expect(lab.edges('api/use.py', 'call')).toEqual(['call api/util.py#t']);
    lab.expectForce();
    // vue-router alone activates it as well.
    expect(lab.sync({ 'package.json': withDeps({ lodash: '^4.0.0', 'vue-router': '^4.0.0' }) })).toEqual(NAMED);
    expect(lab.edges('src/use.ts', 'call')).toEqual([]);
    lab.expectForce();
    expect(lab.sync({ 'package.json': withDeps({ lodash: '^4.0.0' }) })).toEqual(NAMED);
    lab.expectForce();
  }, 240000);

  it('covers only the folders of a nested manifest that lists vue', () => {
    expect(lab.sync({ 'packages/admin/package.json': json({ name: 'admin', dependencies: { lodash: '^4.0.0', vue: '^3.4.0' } }) })).toEqual(['packages/admin/src/i18n.ts']);
    expect(lab.edges('packages/admin/src/i18n.ts', 'call')).toEqual([]);
    lab.expectForce();
    // A dependency range or the nested version moves nothing.
    expect(lab.sync({ 'packages/admin/package.json': json({ name: 'admin', version: '2.0.0', dependencies: { lodash: '^4.0.0', vue: '^3.5.0' } }) })).toEqual([]);
    expect(lab.sync({ 'packages/admin/package.json': json({ name: 'admin', dependencies: { lodash: '^4.0.0' } }) })).toEqual(['packages/admin/src/i18n.ts']);
    lab.expectForce();
  }, 240000);
});

describe.each(VARIANTS)('a %s after a workspace package arrives with its files', (_name, withGit) => {
  it('re-parses the importers elsewhere that name it, as scan --force does (review P2-2)', () => {
    const lab = new Lab({
      'package.json': json({ name: 'mono', private: true, version: '1.0.0' }),
      'packages/old/package.json': json({ name: '@acme/old', main: 'index.ts' }),
      'packages/old/index.ts': 'export const o = 1;\n',
      'other/early.ts': "import { nw } from '@acme/new';\nexport const e = nw;\n",
      'other/loose.ts': "import { o } from '@acme/old';\nexport const l = o;\n",
    }, withGit);
    try {
      expect(lab.edges('other/early.ts', 'import')).toEqual([]);
      // The manifest and its files are new in the same sync: no indexed file is in the folder yet.
      const reparsed = lab.sync({
        'packages/new/package.json': json({ name: '@acme/new', main: 'index.ts' }),
        'packages/new/index.ts': 'export const nw = 1;\n',
      });
      expect(reparsed).toEqual(['other/early.ts', 'packages/new/index.ts']);
      expect(lab.edges('other/early.ts', 'import')).toEqual(['import packages/new/index.ts#@acme/new']);
      lab.expectForce();
    } finally {
      lab.done();
    }
  }, 180000);
});

describe.each(VARIANTS)('a %s after the other entry fields and dependency kinds of a manifest change', (_name, withGit) => {
  let lab: Lab;
  const lib = (extra: Record<string, unknown>) => json({ name: '@acme/lib', version: '1.0.0', ...extra });
  const app = (extra: Record<string, unknown>) => json({ name: 'app', ...extra });
  const files = {
    'package.json': json({ name: 'mono', private: true, version: '1.0.0' }),
    'packages/esm/package.json': lib({ name: '@acme/esm', module: 'src/one.ts' }),
    'packages/esm/src/one.ts': 'export const v = 1;\n',
    'packages/esm/src/two.ts': 'export const v = 2;\n',
    'packages/typed/package.json': lib({ name: '@acme/typed', types: 'src/one.ts' }),
    'packages/typed/src/one.ts': 'export const v = 1;\n',
    'packages/typed/src/two.ts': 'export const v = 2;\n',
    'packages/app/package.json': app({ optionalDependencies: { lodash: '^4.0.0' } }),
    'packages/app/src/use.ts': "import { v as a } from '@acme/esm';\nimport { v as b } from '@acme/typed';\nimport _ from 'lodash';\nexport const r = () => a + b + _.noop();\n",
    'packages/app/src/other.ts': 'export const o = 1;\n',
  };
  const USE = 'packages/app/src/use.ts';
  beforeAll(() => { lab = new Lab(files, withGit); }, 120000);
  afterAll(() => lab.done());

  it('re-parses the importers of a package whose module or types field moves', () => {
    expect(lab.edges(USE, 'import')).toContain('import packages/esm/src/one.ts#@acme/esm');
    expect(lab.edges(USE, 'import')).toContain('import packages/typed/src/one.ts#@acme/typed');
    expect(lab.sync({ 'packages/esm/package.json': lib({ name: '@acme/esm', module: 'src/two.ts' }) })).toEqual([USE]);
    expect(lab.edges(USE, 'import')).toContain('import packages/esm/src/two.ts#@acme/esm');
    lab.expectForce();
    expect(lab.sync({ 'packages/typed/package.json': lib({ name: '@acme/typed', types: 'src/two.ts' }) })).toEqual([USE]);
    expect(lab.edges(USE, 'import')).toContain('import packages/typed/src/two.ts#@acme/typed');
    lab.expectForce();
  }, 180000);

  it('reads optionalDependencies as a listing, the registry or local kind of it included', () => {
    // lodash is listed in optionalDependencies only: becoming a workspace link changes how its import reads.
    const before = lab.edges(USE, 'import');
    expect(lab.sync({ 'packages/app/package.json': app({ optionalDependencies: { lodash: 'workspace:*' } }) })).toEqual([USE]);
    lab.expectForce();
    expect(lab.sync({ 'packages/app/package.json': app({ optionalDependencies: { lodash: '^4.1.0' } }) })).toEqual([USE]);
    expect(lab.edges(USE, 'import')).toEqual(before);
    lab.expectForce();
    // A range bump alone does not.
    expect(lab.sync({ 'packages/app/package.json': app({ optionalDependencies: { lodash: '^4.2.0' } }) })).toEqual([]);
  }, 180000);
});

describe('sync after the config record of an older MapX, with another config edited in the window', () => {
  it('follows a tsconfig edit the record could not tell from a package.json one (review P2-1)', () => {
    const tsconfig = (baseUrl: string) => json({ compilerOptions: { baseUrl } });
    const lab = new Lab({
      'package.json': json(SHOP),
      'tsconfig.json': tsconfig('.'),
      'src/lib/helper.ts': 'export const h = 1;\n',
      'src/b.ts': "import { h } from 'src/lib/helper';\nexport const b = h;\n",
      'src/c.ts': 'export const c = 1;\n',
      'py/x.py': 'def f():\n    pass\n',
    }, false);
    try {
      expect(lab.edges('src/b.ts', 'import')).toEqual(['import src/lib/helper.ts#src/lib/helper']);
      const [row] = query<{ key: string; value: string }>(lab.cwd, "SELECT key, value FROM meta WHERE key LIKE 'js_configs:%'");
      // The record as the code before this task wrote it: the root folder hashes package.json, then the tsconfig.
      const hash = createHash('md5').update('package.json\0').update(json(SHOP));
      hash.update(join(lab.root, 'tsconfig.json')).update('\0').update(tsconfig('.'));
      const record = JSON.parse(row!.value) as Record<string, string>;
      const legacy: Record<string, string> = { '': hash.digest('hex'), '#families': record['#families']! };
      const db = new Database(join(lab.cwd, '.mapx', 'mapx.db'));
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(legacy), row!.key);
      db.close();
      // Only the tsconfig changes: the sync follows it as the older code did, everything below the folder.
      const reparsed = lab.sync({ 'tsconfig.json': tsconfig('src') });
      expect(reparsed).toContain('src/b.ts');
      expect(lab.edges('src/b.ts', 'import')).toEqual([]);
      lab.expectForce();
      expect(JSON.parse(query<{ value: string }>(lab.cwd, "SELECT value FROM meta WHERE key LIKE 'js_configs:%'")[0]!.value)['#manifests']).toBe('1');
      // From here on the narrow tracking applies.
      expect(lab.sync({ 'package.json': json({ ...SHOP, version: '9.0.0' }) })).toEqual([]);
    } finally {
      lab.done();
    }
  }, 180000);
});

describe('a folder whose name starts with #', () => {
  it('has its config edits followed like any other folder (review P2-5)', () => {
    const tsconfig = (baseUrl: string) => json({ compilerOptions: { baseUrl } });
    const lab = new Lab({
      'package.json': json(SHOP),
      '#app/tsconfig.json': tsconfig('.'),
      '#app/src/lib/helper.ts': 'export const h = 1;\n',
      '#app/src/b.ts': "import { h } from 'src/lib/helper';\nexport const b = h;\n",
    }, false);
    try {
      expect(lab.edges('#app/src/b.ts', 'import')).toEqual(['import #app/src/lib/helper.ts#src/lib/helper']);
      expect(lab.sync({ '#app/tsconfig.json': tsconfig('src') })).toContain('#app/src/b.ts');
      expect(lab.edges('#app/src/b.ts', 'import')).toEqual([]);
      lab.expectForce();
    } finally {
      lab.done();
    }
  }, 180000);
});
