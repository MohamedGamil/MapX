import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LARAVEL_DEFAULT_EXCLUDES } from '../src/core/config.js';
import { cleanup, init, mapx, mapxWithStderr, query, workspace } from './helpers/e2e.js';

// M0-02-R1: glob filter defects.
const php = (ns: string, cls: string, body = '') => `<?php\nnamespace ${ns};\n${body}\nclass ${cls} {}\n`;
const files = {
  'app/Services/UserService.php': php('App\\Services', 'UserService'),
  'app/Services/MailService.php': php('App\\Services', 'MailService'),
  'app/Models/User.php': php('App\\Models', 'User', 'use App\\Services\\UserService;'),
  'app/Http/Kernel.php': php('App\\Http', 'Kernel'),
  'app/Http/Controllers/UserController.php': [
    '<?php', 'namespace App\\Http\\Controllers;', 'use App\\Services\\UserService;', 'use App\\Services\\MailService;', 'use App\\Models\\User;',
    'class UserController { public function a(UserService $s, MailService $m): User { return new User(); } }',
  ].join('\n'),
  'resources/views/welcome.blade.php': '<h1>{{ $title }}</h1>\n',
  'public/index.php': "<?php\nrequire __DIR__.'/../bootstrap/app.php';\n",
};

// Every test starts from, and leaves behind, the unfiltered index built once here: a scan costs a
// CLI process, so the tests do not rescan to establish it (M0-02-R3).
describe('glob filters', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(files);
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));
  const edgeCount = () => query<{ n: number }>(root, 'SELECT count(*) AS n FROM edges')[0]!.n;

  it('restores inbound edges after an exclude is removed', () => {
    const original = edgeCount();
    expect(original).toBeGreaterThan(0);
    mapx(root, 'scan', root, '--exclude', 'app/Services/**');
    expect(edgeCount()).toBeLessThan(original);
    mapx(root, 'scan', root);
    expect(edgeCount()).toBe(original);
  });

  it('`dir/*` excludes files in dir but keeps its subdirectories', () => {
    mapx(root, 'scan', root, '--exclude', 'app/Http/*');
    const paths = query<{ path: string }>(root, "SELECT path FROM files WHERE path LIKE 'app/Http/%'").map((f) => f.path);
    expect(paths).toEqual(['app/Http/Controllers/UserController.php']);
    mapx(root, 'scan', root);
  });

  // Review 2026-10-31 (post-acceptance defect): directory pruning tested a synthetic file name,
  // so `**/_*` pruned every directory and directory-name patterns stopped pruning.
  it('prunes directories named by a pattern, and only those', () => {
    const paths = () => query<{ path: string }>(root, "SELECT path FROM files WHERE path LIKE 'app/%' ORDER BY path").map((f) => f.path);
    const all = paths();
    mapx(root, 'scan', root, '--exclude', '**/_*');
    expect(paths()).toEqual(all);
    mapx(root, 'scan', root, '--exclude', '**/Controllers');
    expect(paths()).toEqual(all.filter((p) => !p.startsWith('app/Http/Controllers/')));
    mapx(root, 'scan', root, '--exclude', 'app/*/Controllers');
    expect(paths()).toEqual(all.filter((p) => !p.startsWith('app/Http/Controllers/')));
    mapx(root, 'scan', root);
  });

  it('does not list clusters of excluded files in filtered exports', () => {
    const full = mapx(root, 'export', '-d', root, '--format', 'llm', '--tokens', '20000');
    expect(full).toContain('App.Models');
    const filtered = mapx(root, 'export', '-d', root, '--format', 'llm', '--tokens', '20000', '--exclude', 'app/Models/**');
    expect(filtered).not.toContain('App.Models');
  });

  // M0-02-R2: the JSON export kept clusters and memberships of excluded files; TOON was untested.
  it('does not list clusters or memberships of excluded files in JSON and TOON exports', () => {
    type Export = { clusters: { name: string }[]; memberships: { filePath: string; clusterName: string }[] };
    const exportJson = (...args: string[]) => JSON.parse(mapx(root, 'export', '-d', root, '--format', 'json', ...args)) as Export;
    const excluded = (p: string) => p.startsWith('app/Models/');
    const full = exportJson();
    // Clusters whose members are all excluded files (App.Models): the filtered export must drop them.
    const onlyExcluded = full.clusters.map((c) => c.name).filter((name) => {
      const members = full.memberships.filter((m) => m.clusterName === name).map((m) => m.filePath);
      return members.length > 0 && members.every(excluded);
    });
    expect(onlyExcluded).toContain('App.Models');
    expect(full.memberships.some((m) => excluded(m.filePath))).toBe(true);

    const filtered = exportJson('--exclude', 'app/Models/**');
    expect(filtered.memberships.filter((m) => excluded(m.filePath))).toEqual([]);
    expect(filtered.clusters.map((c) => c.name).filter((n) => onlyExcluded.includes(n))).toEqual([]);
    expect(filtered.memberships.length).toBeGreaterThan(0);

    const toon = (...args: string[]) => mapx(root, 'export', '-d', root, '--format', 'toon', '--tokens', '20000', ...args);
    expect(toon()).toContain('App.Models');
    expect(toon('--exclude', 'app/Models/**')).not.toContain('App.Models');
  });

  // M0-02-R2: `./` and Windows-style separators name the same files at scan time.
  it('normalises ./ and backslash patterns at scan time', () => {
    const paths = () => query<{ path: string }>(root, 'SELECT path FROM files ORDER BY path').map((f) => f.path);
    const all = paths();
    expect(all).toContain(USER_SERVICE);
    const expected = all.filter((p) => !p.startsWith('app/Services/'));
    mapx(root, 'scan', root, '--exclude', './app/Services/**');
    expect(paths()).toEqual(expected);
    // Both spellings record the same filters, so the second scan re-parses nothing: a changed
    // filter signature would re-parse every file and give every symbol a new id (M0-02-R4).
    const symbolIds = () => query<{ id: number; file_path: string }>(root, 'SELECT id, file_path FROM symbols ORDER BY id');
    const ids = symbolIds();
    expect(ids.length).toBeGreaterThan(0);
    mapx(root, 'scan', root, '--exclude', 'app\\Services\\**');
    expect(paths()).toEqual(expected);
    expect(symbolIds()).toEqual(ids);
    mapx(root, 'scan', root, '--exclude', '.\\app\\Services');
    expect(paths()).toEqual(expected);
    mapx(root, 'scan', root);
  });
});

// M0-02-R2: deleting a file drops the edges into it; when it comes back its unchanged referrers
// must be re-parsed, by scan and by sync, with and without git.
const USER_SERVICE = 'app/Services/UserService.php';
const inbound = (root: string) =>
  query<{ e: string }>(
    root,
    "SELECT source_file || ' -> ' || target_file || ' ' || edge_type AS e FROM edges WHERE target_file = ? AND source_file != target_file ORDER BY e",
    USER_SERVICE,
  ).map((r) => r.e);
// Every referrer of the UserService class once it lives at `path`: imports resolve to the file
// declaring the class (M0-04-R2), the parameter type too.
const referrers = (path: string) => [
  `app/Http/Controllers/UserController.php -> ${path} import`,
  `app/Http/Controllers/UserController.php -> ${path} param_type`,
  `app/Models/User.php -> ${path} import`,
];
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });

describe('inbound edges of a deleted and restored file', () => {
  const expected = [
    `app/Http/Controllers/UserController.php -> ${USER_SERVICE} import`,
    `app/Models/User.php -> ${USER_SERVICE} import`,
  ];

  it.each(['scan', 'sync'])('come back after a plain %s (no git)', (command) => {
    const root = workspace(files);
    try {
      init(root);
      mapx(root, 'scan', root);
      const original = inbound(root);
      expect(original).toEqual(expect.arrayContaining(expected));
      const content = readFileSync(join(root, USER_SERVICE), 'utf8');
      rmSync(join(root, USER_SERVICE));
      mapx(root, command, root);
      expect(inbound(root)).toEqual([]);
      writeFileSync(join(root, USER_SERVICE), content);
      mapx(root, command, root);
      expect(inbound(root)).toEqual(original);
    } finally {
      cleanup(root);
    }
  }, 90000);

  it('come back after sync in a git repo: working-tree delete and branch switch', () => {
    const root = workspace(files, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      const original = inbound(root);
      expect(original).toEqual(expect.arrayContaining(expected));

      // Deleted and restored in the working tree, HEAD unchanged.
      rmSync(join(root, USER_SERVICE));
      mapx(root, 'sync', root);
      expect(inbound(root)).toEqual([]);
      git(root, 'checkout', '--', USER_SERVICE);
      mapx(root, 'sync', root);
      expect(inbound(root)).toEqual(original);

      // A branch without the file, and back.
      git(root, 'checkout', '-qb', 'without');
      git(root, 'rm', '-q', USER_SERVICE);
      git(root, 'commit', '-qm', 'drop');
      mapx(root, 'sync', root);
      expect(inbound(root)).toEqual([]);
      git(root, 'checkout', '-q', '-');
      mapx(root, 'sync', root);
      expect(inbound(root)).toEqual(original);
    } finally {
      cleanup(root);
    }
  }, 120000);
});

// Edges from or into a file, other than its own.
const touching = (root: string, path: string) =>
  query<{ e: string }>(
    root,
    "SELECT source_file || ' -> ' || target_file || ' ' || edge_type AS e FROM edges WHERE (source_file = ? OR target_file = ?) AND source_file != target_file ORDER BY e",
    path,
    path,
  ).map((r) => r.e);

// Files and edge tuples, to compare an incremental result with `scan --force`.
const snapshot = (root: string) => ({
  files: query<{ path: string }>(root, 'SELECT path FROM files ORDER BY path').map((f) => f.path),
  edges: query<{ e: string }>(
    root,
    "SELECT source_file || '|' || target_file || '|' || edge_type || '|' || coalesce(source_symbol, '') || '|' || coalesce(target_symbol, '') || '|' || verifiability AS e FROM edges ORDER BY e",
  ).map((r) => r.e),
});

// M0-02-R2: sync honours config filter changes as scan does.
describe('sync after a config filter change', () => {
  const setExcludes = (root: string, change: (p: string[]) => string[]) => {
    const path = join(root, '.mapx', 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.settings.excludePatterns = change(config.settings.excludePatterns);
    writeFileSync(path, JSON.stringify(config));
  };

  it.each([false, true])('gives the same files and edges as scan --force (git: %s)', (withGit) => {
    const root = workspace(files, withGit ? ['.'] : []);
    try {
      if (withGit) {
        writeFileSync(join(root, '.gitignore'), '.mapx/\n');
        git(root, 'add', '-A');
        git(root, 'commit', '-qm', 'init');
      }
      init(root);
      mapx(root, 'scan', root);
      const original = snapshot(root);

      setExcludes(root, (p) => [...p, 'app/Services/**']);
      mapx(root, 'sync', root);
      const excluded = snapshot(root);
      expect(excluded.files.some((p) => p.startsWith('app/Services/'))).toBe(false);
      mapx(root, 'scan', root, '--force');
      expect(excluded).toEqual(snapshot(root));

      setExcludes(root, (p) => p.filter((x) => x !== 'app/Services/**'));
      mapx(root, 'sync', root);
      const restored = snapshot(root);
      mapx(root, 'scan', root, '--force');
      expect(restored).toEqual(snapshot(root));
      expect(restored).toEqual(original);
    } finally {
      cleanup(root);
    }
  }, 120000);
});

describe('Laravel default excludes at scan time', () => {
  // The default settings are scanned once and shared by the tests that need them.
  let defaults: string[] | undefined;
  const scanDefaults = () => (defaults ??= scanWith({}));
  const scanWith = (settings: Record<string, unknown>) => {
    const root = workspace({ ...files, artisan: '#!/usr/bin/env php\n<?php\n' });
    init(root);
    const path = join(root, '.mapx', 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.repos[0].framework = 'laravel';
    config.settings.excludePatterns = config.settings.excludePatterns.filter((p: string) => !p.includes('blade') && !p.includes('resources/views'));
    // init ran with --no-suggestions on a Laravel app, which records a declined suggestion; the
    // "no globs, not declined" case removes that marker.
    delete config.settings.laravelDefaultExcludes;
    Object.assign(config.settings, settings);
    writeFileSync(path, JSON.stringify(config));
    mapx(root, 'scan', root);
    const indexed = query<{ path: string }>(root, 'SELECT path FROM files').map((f) => f.path);
    cleanup(root);
    return indexed;
  };

  it('applies them for framework: laravel even when the config lists no globs', () => {
    expect(scanDefaults()).not.toContain('resources/views/welcome.blade.php');
  }, 60000);

  it('respects a declined suggestion', () => {
    expect(scanWith({ laravelDefaultExcludes: false })).toContain('resources/views/welcome.blade.php');
  }, 60000);

  // M0-02-R2: a list keeps only the defaults it names, so one default can be dropped.
  it('drops a single default when laravelDefaultExcludes lists the others', () => {
    expect(scanDefaults()).not.toContain('public/index.php');
    const indexed = scanWith({ laravelDefaultExcludes: LARAVEL_DEFAULT_EXCLUDES.filter((p) => p !== 'public/**') });
    expect(indexed).toContain('public/index.php');
    expect(indexed).not.toContain('resources/views/welcome.blade.php');
  }, 90000);

  // Review 2026-10-31: the repo-path prefix of a non-root Laravel repo was untested.
  it('scopes the defaults to a non-root repo path', () => {
    const nested = Object.fromEntries(
      Object.entries({ ...files, artisan: '#!/usr/bin/env php\n<?php\n' }).map(([p, c]) => [`api/${p}`, c]),
    );
    const root = workspace(nested);
    try {
      init(root);
      const path = join(root, '.mapx', 'config.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.repos[0].path = 'api';
      config.repos[0].framework = 'laravel';
      config.settings.excludePatterns = config.settings.excludePatterns.filter(
        (p: string) => !p.includes('blade') && !p.includes('resources/views') && !p.includes('public'),
      );
      delete config.settings.laravelDefaultExcludes;
      writeFileSync(path, JSON.stringify(config));
      mapx(root, 'scan', root);
      const indexed = query<{ path: string }>(root, 'SELECT path FROM files').map((f) => f.path);
      expect(indexed).toContain('api/app/Models/User.php');
      expect(indexed).not.toContain('api/public/index.php');
      expect(indexed).not.toContain('api/resources/views/welcome.blade.php');
    } finally {
      cleanup(root);
    }
  }, 60000);
});

// M0-02-R3: git renames, repos nested in a larger checkout, and repos registered through a symlink.
describe('incremental sync: git renames, nested and symlinked repos', () => {
  const ACCOUNT_SERVICE = 'app/Services/AccountService.php';

  it('sync after git mv removes the old path and matches scan --force', () => {
    const root = workspace(files, ['.']);
    try {
      writeFileSync(join(root, '.gitignore'), '.mapx/\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      const original = snapshot(root);
      expect(inbound(root)).toEqual(expect.arrayContaining([`app/Models/User.php -> ${USER_SERVICE} import`]));

      // Committed rename. The class keeps its name: the `use` imports and UserController's parameter
      // type follow the class declared at its new path (M0-04-R2: imports resolve by declaration).
      git(root, 'mv', USER_SERVICE, ACCOUNT_SERVICE);
      git(root, 'commit', '-qm', 'rename');
      mapx(root, 'sync', root);
      const synced = snapshot(root);
      expect(synced.files).toContain(ACCOUNT_SERVICE);
      expect(synced.files).not.toContain(USER_SERVICE);
      expect(touching(root, USER_SERVICE)).toEqual([]);
      expect(touching(root, ACCOUNT_SERVICE)).toEqual(referrers(ACCOUNT_SERVICE));
      mapx(root, 'scan', root, '--force');
      expect(synced).toEqual(snapshot(root));

      // Renamed back, staged but not committed: the diff against HEAD reports a rename too, and the
      // tree is the scanned original again.
      git(root, 'mv', ACCOUNT_SERVICE, USER_SERVICE);
      mapx(root, 'sync', root);
      expect(snapshot(root)).toEqual(original);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('sync in a repo nested inside a larger checkout indexes repo-relative paths', () => {
    // The MapX workspace is api/; git's top level is its parent, which also holds web/.
    const outer = workspace(
      {
        ...Object.fromEntries(Object.entries(files).map(([p, c]) => [`api/${p}`, c])),
        'web/main.ts': 'export const web = 1;\n',
        '.gitignore': '.mapx/\n',
      },
      ['.'],
    );
    const root = join(outer, 'api');
    try {
      git(outer, 'add', '-A');
      git(outer, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);

      writeFileSync(join(root, 'app/Models/User.php'), php('App\\Models', 'User', 'use App\\Services\\UserService;\nclass Profile {}'));
      writeFileSync(join(outer, 'web/main.ts'), 'export const web = 2;\n');
      git(outer, 'rm', '-q', 'api/app/Services/MailService.php');
      git(outer, 'commit', '-qam', 'change');
      mapx(root, 'sync', root);

      const symbols = query<{ name: string; file_path: string }>(root, "SELECT name, file_path FROM symbols WHERE name = 'Profile'");
      expect(symbols).toEqual([{ name: 'Profile', file_path: 'app/Models/User.php' }]);
      const synced = snapshot(root);
      expect(synced.files).not.toContain('app/Services/MailService.php');
      expect(synced.files.filter((p) => p.startsWith('api/') || p.startsWith('web/') || p.startsWith('..'))).toEqual([]);
      mapx(root, 'scan', root, '--force');
      expect(synced).toEqual(snapshot(root));

      // M0-02-R4: moved across two git syncs, which git does not report as a rename: deleted, then
      // added under another path as an untracked file. The parameter type follows the class.
      const content = readFileSync(join(root, USER_SERVICE), 'utf8');
      rmSync(join(root, USER_SERVICE));
      mapx(root, 'sync', root);
      expect(touching(root, USER_SERVICE)).toEqual([]);
      mkdirSync(join(root, 'app/Core'));
      writeFileSync(join(root, 'app/Core/UserService.php'), content);
      mapx(root, 'sync', root);
      expect(touching(root, 'app/Core/UserService.php')).toEqual(referrers('app/Core/UserService.php'));
    } finally {
      cleanup(outer);
    }
  }, 120000);

  it('the nested-repo check treats a symlink to a registered repo as that repo', () => {
    const root = workspace(
      { 'src/app.ts': 'export const app = 1;\n', 'packages/web/index.ts': 'export const web = 1;\n', 'libs/ui/button.ts': 'export const button = 1;\n' },
      ['.', 'libs/ui'],
    );
    try {
      symlinkSync(join(root, 'packages/web'), join(root, 'web-link'));
      symlinkSync(join(root, 'libs/ui'), join(root, 'ui-link'));
      init(root);
      // Registered through their symlinks only, as an older config may have them (M0-10-R2).
      const path = join(root, '.mapx', 'config.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.repos = [config.repos[0], { name: 'web', path: 'web-link' }, { name: 'ui', path: 'ui-link' }];
      writeFileSync(path, JSON.stringify(config));

      const { stderr } = mapxWithStderr(root, 'scan', root, '--all');
      // The plain folder is not indexed a second time under main, and the checkout is not taken
      // for an unregistered nested repo.
      const indexed = query<{ repo: string; path: string }>(root, 'SELECT repo, path FROM files ORDER BY path');
      expect(indexed.filter((f) => f.repo === config.repos[0].name).map((f) => f.path)).toEqual(['src/app.ts']);
      expect(indexed.filter((f) => f.repo !== config.repos[0].name)).toEqual([
        { repo: 'ui', path: 'ui-link/button.ts' },
        { repo: 'web', path: 'web-link/index.ts' },
      ]);
      expect(stderr).not.toContain('unregistered nested git repository');
    } finally {
      cleanup(root);
    }
  }, 60000);
});

// M0-02-R4: plain scan and content-hash sync saw a move as a delete plus an add, and left the moved
// class's referrers unresolved until --force; a repo not at the workspace root stored no blob hashes.
describe('incremental scans: moved targets and non-root blob hashes', () => {
  it('plain scan and sync without git re-link the referrers of a moved class, as scan --force', () => {
    const DOMAIN = 'app/Domain/UserService.php';
    const CORE = 'app/Core/UserService.php';
    const root = workspace(files);
    try {
      init(root);
      mapx(root, 'scan', root);
      const content = readFileSync(join(root, USER_SERVICE), 'utf8');

      // Moved within one plain scan. The `use` imports and the parameter type resolve to the class
      // at its new path (M0-04-R2: imports resolve by declaration, not by PSR-4 path alone).
      mkdirSync(join(root, 'app/Domain'));
      renameSync(join(root, USER_SERVICE), join(root, DOMAIN));
      mapx(root, 'scan', root);
      const scanned = snapshot(root);
      expect(scanned.files).not.toContain(USER_SERVICE);
      expect(touching(root, USER_SERVICE)).toEqual([]);
      expect(touching(root, DOMAIN)).toEqual(referrers(DOMAIN));

      // Moved across two syncs without git: removed by one, added under a new path by the next.
      rmSync(join(root, DOMAIN));
      mapx(root, 'sync', root);
      expect(touching(root, DOMAIN)).toEqual([]);
      mkdirSync(join(root, 'app/Core'));
      writeFileSync(join(root, CORE), content);
      mapx(root, 'sync', root);
      expect(touching(root, CORE)).toEqual(referrers(CORE));
      // The class is declared again, so its name no longer re-parses those referrers whenever a
      // later file mentions it.
      expect(query<{ value: string }>(root, "SELECT value FROM meta WHERE key LIKE 'removed_names:%'").map((m) => JSON.parse(m.value))).toEqual([{}]);

      const synced = snapshot(root);
      mapx(root, 'scan', root, '--force');
      const forced = snapshot(root);
      expect(synced).toEqual(forced);
      // The plain scan's result is the forced one with the class at its first new path.
      const atDomain = (s: { files: string[]; edges: string[] }) => ({
        files: s.files.map((p) => p.replace(CORE, DOMAIN)).sort(),
        edges: s.edges.map((e) => e.replaceAll(CORE, DOMAIN)).sort(),
      });
      expect(atDomain(scanned)).toEqual(atDomain(forced));
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('stores blob hashes under workspace paths for a repo not at the root, and sync skips a listed file whose blob is unchanged', () => {
    const root = workspace(
      {
        'src/app.ts': 'export function app() { return 1; }\n',
        'libs/ui/button.ts': 'export function button() { return 1; }\n',
        'libs/ui/card.ts': 'export function card() { return 1; }\n',
      },
      ['libs/ui'],
    );
    const ui = join(root, 'libs/ui');
    try {
      git(ui, 'add', '-A');
      git(ui, 'commit', '-qm', 'init');
      init(root);
      const path = join(root, '.mapx', 'config.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.repos = [config.repos[0], { name: 'ui', path: 'libs/ui' }];
      writeFileSync(path, JSON.stringify(config));
      // card.ts is modified in the working tree: what is indexed is not HEAD's blob.
      writeFileSync(join(ui, 'card.ts'), 'export function card() { return 4; }\n');
      mapx(root, 'scan', root, '--all');

      const blob = (p: string) => git(ui, 'rev-parse', `HEAD:${p}`).toString().trim();
      expect(query(root, "SELECT path, git_blob_hash FROM files WHERE repo = 'ui' ORDER BY path")).toEqual([
        { path: 'libs/ui/button.ts', git_blob_hash: blob('button.ts') },
        { path: 'libs/ui/card.ts', git_blob_hash: null },
      ]);

      // git lists button.ts (a mode change) with the same blob: it is not re-parsed, so its
      // symbols keep their ids. card.ts changed and is re-parsed.
      const symbols = (p: string) =>
        query<{ id: number; name: string }>(root, 'SELECT id, name FROM symbols WHERE file_path = ? ORDER BY id', p);
      const button = symbols('libs/ui/button.ts');
      expect(button.map((s) => s.name)).toEqual(['button']);
      chmodSync(join(ui, 'button.ts'), 0o755);
      writeFileSync(join(ui, 'card.ts'), 'export function card() { return 2; }\nexport function badge() { return 3; }\n');
      git(ui, 'commit', '-qam', 'change');
      expect(git(ui, 'diff', '--name-status', 'HEAD~1').toString()).toContain('button.ts');
      mapx(root, 'sync', root, '--all');
      expect(symbols('libs/ui/button.ts')).toEqual(button);
      expect(symbols('libs/ui/card.ts').map((s) => s.name).sort()).toEqual(['badge', 'card']);
    } finally {
      cleanup(root);
    }
  }, 90000);
});

// M0-02-R5: git sync kept a deleted file that was never committed (git diff compares two trees
// without it, and ls-files --others stops listing it), and stored no blob ids for what it indexed.
// The tests share one committed workspace and run in order.
describe('git sync: uncommitted files and blob ids', () => {
  const UNTRACKED = 'app/Services/AuditService.php';
  const STAGED = 'app/Services/ReportService.php';
  const MAIL = 'app/Services/MailService.php';
  const usesUser = (cls: string) =>
    `<?php\nnamespace App\\Services;\nclass ${cls} { public function run(UserService $u) {} }\n`;
  const of = (root: string, path: string) => ({
    file: query(root, 'SELECT path FROM files WHERE path = ?', path).length,
    symbols: query<{ name: string }>(root, 'SELECT name FROM symbols WHERE file_path = ? ORDER BY name', path).map((s) => s.name),
    edges: touching(root, path),
  });
  const symbolRows = (root: string, path: string) => query(root, 'SELECT id, name FROM symbols WHERE file_path = ? ORDER BY id', path);
  const hashObject = (root: string, path: string) => git(root, 'hash-object', path).toString().trim();
  const storedBlob = (root: string, path: string) =>
    query<{ h: string | null }>(root, 'SELECT git_blob_hash AS h FROM files WHERE path = ?', path)[0]?.h;
  let root: string;
  beforeAll(() => {
    root = workspace({ ...files, '.gitignore': '.mapx/\n' }, ['.']);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('drops a deleted untracked file and a deleted staged-only file, as scan --force', () => {
    writeFileSync(join(root, UNTRACKED), usesUser('AuditService'));
    writeFileSync(join(root, STAGED), usesUser('ReportService'));
    git(root, 'add', STAGED);
    mapx(root, 'sync', root);
    expect(of(root, UNTRACKED)).toEqual({
      file: 1,
      symbols: ['AuditService', 'run'],
      edges: [`${UNTRACKED} -> ${USER_SERVICE} param_type`],
    });
    expect(of(root, STAGED).edges).toEqual([`${STAGED} -> ${USER_SERVICE} param_type`]);

    // Deleted from the working tree; the staged copy stays in the index, so git diff --cached
    // still lists it as added.
    rmSync(join(root, UNTRACKED));
    rmSync(join(root, STAGED));
    mapx(root, 'sync', root);
    const gone = { file: 0, symbols: [], edges: [] };
    expect(of(root, UNTRACKED)).toEqual(gone);
    expect(of(root, STAGED)).toEqual(gone);
    const synced = snapshot(root);
    mapx(root, 'scan', root, '--force');
    expect(synced).toEqual(snapshot(root));
  }, 60000);

  it('stores the blob id of what it re-indexes, so the file is skipped once committed', () => {
    writeFileSync(join(root, MAIL), php('App\\Services', 'MailService', 'interface Mailer {}'));
    mapx(root, 'sync', root);
    expect(storedBlob(root, MAIL)).toBe(hashObject(root, MAIL));
    const rows = symbolRows(root, MAIL);
    expect(rows.map((r) => (r as { name: string }).name).sort()).toEqual(['MailService', 'Mailer']);

    // The commit makes git list MailService.php against the last scanned commit, with the content
    // that was indexed: it is not re-parsed, so its symbols keep their ids.
    git(root, 'commit', '-qam', 'mailer');
    expect(git(root, 'diff', '--name-only', 'HEAD~1').toString()).toContain(MAIL);
    mapx(root, 'sync', root);
    expect(symbolRows(root, MAIL)).toEqual(rows);
  }, 60000);
});

// Review 2026-10-31: git sync lists every tracked or untracked change; it indexes only what the
// scan walk would reach (no dot-named or DEFAULT_IGNORE segment, no pruned directory).
describe('git sync applies the scan walk file rules', () => {
  it('never indexes dot-named, ignored-folder or pruned-directory files that scan skips', () => {
    const skipped = ['.eslintrc.js', '.storybook/main.ts', 'coverage/prettify.js', 'app/Http/Controllers/UserController.php'];
    const root = workspace({ ...files, '.eslintrc.js': 'module.exports = { root: true };\n', '.storybook/main.ts': 'export function story() { return 1; }\n', 'coverage/prettify.js': 'function cov() { return 1; }\n', '.gitignore': '.mapx/\n' }, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      const path = join(root, '.mapx', 'config.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      config.settings.excludePatterns = [...config.settings.excludePatterns, '**/Controllers'];
      writeFileSync(path, JSON.stringify(config));
      mapx(root, 'scan', root);
      const indexed = () => query<{ path: string }>(root, 'SELECT path FROM files ORDER BY path').map((f) => f.path);
      expect(indexed().filter((p) => skipped.includes(p))).toEqual([]);

      writeFileSync(join(root, '.eslintrc.js'), 'module.exports = { root: false };\n');
      writeFileSync(join(root, '.storybook/main.ts'), 'export function story() { return 2; }\n');
      writeFileSync(join(root, '.storybook/preview.ts'), 'export function preview() { return 1; }\n');
      writeFileSync(join(root, 'coverage/prettify.js'), 'function cov() { return 2; }\n');
      writeFileSync(join(root, 'app/Http/Controllers/UserController.php'), php('App\\Http\\Controllers', 'UserController', 'use App\\Models\\User;'));
      mapx(root, 'sync', root);
      expect(indexed().filter((p) => [...skipped, '.storybook/preview.ts'].includes(p))).toEqual([]);
      const synced = snapshot(root);
      mapx(root, 'scan', root, '--force');
      expect(synced).toEqual(snapshot(root));
    } finally {
      cleanup(root);
    }
  }, 120000);
});

// M0-02-R6: a synced edit that is then reverted to HEAD's content is in no git diff (HEAD is still
// the last scanned commit), so sync must notice that the indexed blob is no longer the file's.
describe('git sync: an edit reverted to HEAD', () => {
  const MAIL = 'app/Services/MailService.php';
  const edited = `<?php\nnamespace App\\Services;\nclass MailService { public function send(UserService $u) {} }\ninterface Mailer {}\n`;
  const symbols = (root: string) =>
    query<{ s: string }>(root, "SELECT file_path || ' ' || name AS s FROM symbols ORDER BY s").map((r) => r.s);
  const state = (root: string) => ({ ...snapshot(root), symbols: symbols(root) });
  let root: string;
  let fresh: ReturnType<typeof state>;
  beforeAll(() => {
    root = workspace({ ...files, '.gitignore': '.mapx/\n' }, ['.']);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    init(root);
    mapx(root, 'scan', root);
    fresh = state(root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('restores HEAD symbols and edges after a working-tree edit is reverted with git checkout', () => {
    writeFileSync(join(root, MAIL), edited);
    mapx(root, 'sync', root);
    expect(symbols(root)).toContain(`${MAIL} Mailer`);
    expect(touching(root, MAIL)).toContain(`${MAIL} -> ${USER_SERVICE} param_type`);

    git(root, 'checkout', '--', MAIL);
    mapx(root, 'sync', root);
    expect(state(root)).toEqual(fresh);
    mapx(root, 'scan', root, '--force');
    expect(state(root)).toEqual(fresh);
  }, 60000);

  it('restores HEAD symbols and edges after a staged edit is reverted with git reset and checkout', () => {
    writeFileSync(join(root, MAIL), edited);
    git(root, 'add', MAIL);
    mapx(root, 'sync', root);
    expect(symbols(root)).toContain(`${MAIL} Mailer`);

    git(root, 'reset', '-q', '--', MAIL);
    git(root, 'checkout', '--', MAIL);
    mapx(root, 'sync', root);
    expect(state(root)).toEqual(fresh);
    mapx(root, 'scan', root, '--force');
    expect(state(root)).toEqual(fresh);
  }, 60000);
});

// M0-02-R7: git sync sequences that ended with an index scan --force does not give (review 2026-10-31).
describe('git sync gives the index scan --force gives', () => {
  const rows = (root: string) => ({
    ...snapshot(root),
    files: query<{ f: string }>(root, "SELECT path || '|' || repo AS f FROM files ORDER BY f").map((r) => r.f),
  });

  it('keeps a registered folder repo inside the primary checkout under its own repo after a plain sync', () => {
    const root = workspace({ 'src/app.ts': 'export const app = 1;\n', 'packages/web/index.ts': 'export function web() { return 1; }\n', '.gitignore': '.mapx/\n' }, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'workspaces', 'add', 'packages/web');
      mapx(root, 'scan', '--all');
      writeFileSync(join(root, 'packages/web/added.ts'), 'export function added() {}\n');
      writeFileSync(join(root, 'packages/web/index.ts'), 'export function web() { return 2; }\n');
      mapx(root, 'sync', root);
      const synced = rows(root);
      expect(synced.files.filter((f) => f.startsWith('packages/web/'))).toEqual(['packages/web/index.ts|web']);
      mapx(root, 'sync', '--all');
      expect(rows(root).files.filter((f) => f.startsWith('packages/web/'))).toEqual(['packages/web/added.ts|web', 'packages/web/index.ts|web']);
      const all = rows(root);
      mapx(root, 'scan', '--all', '--force');
      expect(all).toEqual(rows(root));
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('does not index a repo registered through a symlink twice', () => {
    const root = workspace({ 'src/app.ts': 'export const app = 1;\n', 'packages/web/index.ts': 'export function web() { return 1; }\n', '.gitignore': '.mapx/\nweb-link\n' }, ['.']);
    try {
      symlinkSync(join(root, 'packages/web'), join(root, 'web-link'));
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'workspaces', 'add', 'web-link');
      mapx(root, 'scan', '--all');
      const fresh = rows(root);
      expect(fresh.files.map((f) => f.split('|')[0])).toEqual(['src/app.ts', 'web-link/index.ts']);
      writeFileSync(join(root, 'packages/web/added.ts'), 'export function added() {}\n');
      mapx(root, 'sync', root);
      mapx(root, 'sync', '--all');
      const synced = rows(root);
      expect(synced.files.filter((f) => f.includes('added.ts'))).toEqual(['web-link/added.ts|web-link']);
      mapx(root, 'scan', '--all', '--force');
      expect(synced).toEqual(rows(root));
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-links the referrers of a class re-added elsewhere after an unrelated file declared one of its names', () => {
    const root = workspace({
      'app/Services/UserService.php': '<?php\nnamespace App\\Services;\nclass UserService { public function find($id) { return $id; } }\n',
      'app/Http/UserController.php': '<?php\nnamespace App\\Http;\nuse App\\Services\\UserService;\nclass UserController { public function show(UserService $s) { return $s->find(1); } }\n',
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const service = readFileSync(join(root, 'app/Services/UserService.php'), 'utf8');
      rmSync(join(root, 'app/Services/UserService.php'));
      mapx(root, 'sync', root);
      writeFileSync(join(root, 'app/Repo.php'), '<?php\nnamespace App;\nclass Repo { public function find($id) { return $id; } }\n');
      mapx(root, 'sync', root);
      mkdirSync(join(root, 'app/Core'));
      writeFileSync(join(root, 'app/Core/UserService.php'), service);
      mapx(root, 'sync', root);
      const synced = rows(root);
      expect(touching(root, 'app/Core/UserService.php')).toEqual([
        'app/Http/UserController.php -> app/Core/UserService.php call',
        'app/Http/UserController.php -> app/Core/UserService.php import',
        'app/Http/UserController.php -> app/Core/UserService.php param_type',
      ]);
      mapx(root, 'scan', root, '--force');
      expect(synced).toEqual(rows(root));
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('keeps both files after git mv a b leaves an identical untracked copy at a', () => {
    const root = workspace({ 'src/a.ts': 'export function a() { return 1; }\n', 'src/main.ts': "import { a } from './a';\nexport const m = () => a();\n", '.gitignore': '.mapx/\n' }, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      git(root, 'mv', 'src/a.ts', 'src/b.ts');
      writeFileSync(join(root, 'src/a.ts'), readFileSync(join(root, 'src/b.ts')));
      mapx(root, 'sync', root);
      const synced = rows(root);
      expect(synced.files.map((f) => f.split('|')[0])).toEqual(['src/a.ts', 'src/b.ts', 'src/main.ts']);
      mapx(root, 'scan', root, '--force');
      expect(synced).toEqual(rows(root));
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('indexes gitignored files as scan does: edits, additions and removals', () => {
    const root = workspace({
      ...files,
      'gen/Generated.php': '<?php\nnamespace Gen;\nclass Generated {}\n',
      'app/ignored.php': '<?php\nnamespace App;\nclass Ignored {}\n',
      '.gitignore': '.mapx/\ngen/\napp/ignored.php\n',
    }, ['.']);
    try {
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      mapx(root, 'scan', root);
      const paths = () => rows(root).files.map((f) => f.split('|')[0]);
      expect(paths()).toEqual(expect.arrayContaining(['app/ignored.php', 'gen/Generated.php']));

      writeFileSync(join(root, 'gen/Generated.php'), `<?php\nnamespace Gen;\nuse App\\Services\\UserService;\nclass Generated { public function run(UserService $u) {} }\n`);
      writeFileSync(join(root, 'gen/More.php'), '<?php\nnamespace Gen;\nclass More {}\n');
      rmSync(join(root, 'app/ignored.php'));
      mapx(root, 'sync', root);
      const synced = rows(root);
      expect(touching(root, 'gen/Generated.php')).toEqual([`gen/Generated.php -> ${USER_SERVICE} import`, `gen/Generated.php -> ${USER_SERVICE} param_type`]);
      expect(paths()).toContain('gen/More.php');
      expect(paths()).not.toContain('app/ignored.php');
      mapx(root, 'scan', root, '--force');
      expect(synced).toEqual(rows(root));
    } finally {
      cleanup(root);
    }
  }, 120000);
});

// Independent review of M0-02-R6/R7 (2026-10-31): sequences and costs git sync got wrong.
describe('git sync after the independent review of M0-02-R6/R7', () => {
  const rows = (root: string) => ({
    ...snapshot(root),
    files: query<{ f: string }>(root, "SELECT path || '|' || repo AS f FROM files ORDER BY f").map((r) => r.f),
  });
  const stamps = (root: string) => query<{ s: string }>(root, "SELECT path || '|' || last_scanned AS s FROM files ORDER BY s").map((r) => r.s);
  const committed = (tree: Record<string, string>, gitDirs = ['.']) => {
    const root = workspace({ '.gitignore': '.mapx/\n', ...tree }, gitDirs);
    for (const dir of [...gitDirs].reverse()) {
      git(join(root, dir), 'add', '-A');
      git(join(root, dir), 'commit', '-qm', 'init');
    }
    init(root);
    return root;
  };

  it('re-parses nothing on a no-op sync of an eol=crlf checkout, and still re-indexes a real edit', () => {
    const root = committed({ '.gitattributes': '*.ts text eol=crlf\n', 'src/f.ts': 'export function f() { return 1; }\n', 'src/g.ts': "import { f } from './f';\nexport const g = () => f();\n" });
    try {
      rmSync(join(root, 'src/f.ts'));
      rmSync(join(root, 'src/g.ts'));
      git(root, 'checkout', '--', '.');
      expect(readFileSync(join(root, 'src/f.ts'), 'utf8')).toContain('\r\n');
      mapx(root, 'scan', root);
      const before = stamps(root);
      mapx(root, 'sync', root);
      mapx(root, 'sync', root);
      expect(stamps(root)).toEqual(before);
      writeFileSync(join(root, 'src/f.ts'), 'export function f() { return 2; }\r\nexport function h() {}\r\n');
      mapx(root, 'sync', root);
      expect(query(root, "SELECT name FROM symbols WHERE file_path = 'src/f.ts' ORDER BY name").map((r: any) => r.name)).toEqual(['f', 'h']);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-indexes an edit that a full scan indexed, once it is reverted', () => {
    const root = committed({ 'src/a.ts': 'export function a() { return 1; }\n' });
    try {
      mapx(root, 'scan', root);
      const fresh = rows(root);
      writeFileSync(join(root, 'src/a.ts'), 'export function a() { return 1; }\nexport function extra() {}\n');
      mapx(root, 'scan', root);
      git(root, 'checkout', '--', 'src/a.ts');
      mapx(root, 'sync', root);
      expect(query(root, "SELECT name FROM symbols WHERE name = 'extra'")).toEqual([]);
      expect(rows(root)).toEqual(fresh);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-indexes a gitignored file replaced by same-size content with an older mtime (cp -p)', () => {
    const root = committed({ '.gitignore': '.mapx/\ngen/\n', 'src/a.ts': 'export const a = 1;\n', 'gen/x.ts': 'export function h() { return 1; }\n' });
    try {
      mapx(root, 'scan', root);
      writeFileSync(join(root, 'gen/x.ts'), 'export function q() { return 1; }\n');
      const past = new Date(Date.now() - 3600_000);
      utimesSync(join(root, 'gen/x.ts'), past, past);
      mapx(root, 'sync', root);
      expect(query(root, "SELECT name FROM symbols WHERE file_path = 'gen/x.ts'")).toEqual([{ name: 'q' }]);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('takes the no-change path with a gitignored non-source file', () => {
    const root = committed({ 'src/a.ts': 'export const a = 1;\n', '.gitignore': '.mapx/\ndatabase/*.sqlite\nauth.json\n', 'database/database.sqlite': 'SQLite format 3\0'.repeat(1000), 'auth.json': '{}\n' });
    try {
      mapx(root, 'scan', root);
      expect(mapx(root, 'sync', root)).toMatch(/Updated 0 files/);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('syncs a registered repo two levels inside a gitignored folder, as scan --all --force', () => {
    const root = committed({ '.gitignore': '.mapx/\nvendor-src/\n', 'src/app.ts': 'export const app = 1;\n', 'vendor-src/pkg/web/index.ts': 'export function web() { return 1; }\n' });
    try {
      mapx(root, 'workspaces', 'add', 'vendor-src/pkg/web');
      mapx(root, 'scan', '--all');
      writeFileSync(join(root, 'vendor-src/pkg/web/index.ts'), 'export function web() { return 2; }\nexport function web2() {}\n');
      writeFileSync(join(root, 'vendor-src/pkg/web/added.ts'), 'export function added() {}\n');
      mapx(root, 'sync', '--all');
      const synced = rows(root);
      expect(synced.files).toContain('vendor-src/pkg/web/added.ts|web');
      mapx(root, 'scan', '--all', '--force');
      expect(rows(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('drops the old path of a staged git mv into a registered nested repo', () => {
    const root = committed({ 'src/app.ts': 'export function app() { return 1; }\n', 'packages/web/index.ts': 'export const web = 1;\n' });
    try {
      mapx(root, 'workspaces', 'add', 'packages/web');
      mapx(root, 'scan', '--all');
      git(root, 'mv', 'src/app.ts', 'packages/web/app.ts');
      mapx(root, 'sync', '--all');
      const synced = rows(root);
      expect(synced.files.filter((f) => f.includes('app.ts'))).toEqual(['packages/web/app.ts|web']);
      mapx(root, 'scan', '--all', '--force');
      expect(rows(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-indexes an edit in a gitignored folder with a non-ASCII name', () => {
    const root = committed({ '.gitignore': '.mapx/\ngénérés/\n', 'src/a.ts': 'export const a = 1;\n', 'générés/x.ts': 'export function x() { return 1; }\n' });
    try {
      mapx(root, 'scan', root);
      writeFileSync(join(root, 'générés/x.ts'), 'export function x() { return 1; }\nexport function y() {}\n');
      mapx(root, 'sync', root);
      const synced = rows(root);
      expect(query(root, "SELECT name FROM symbols WHERE name = 'y'")).toHaveLength(1);
      mapx(root, 'scan', root, '--force');
      expect(rows(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-links a class re-added elsewhere under git sync too (committed and uncommitted)', () => {
    const service = '<?php\nnamespace App\\Services;\nclass UserService { public function find($id) { return $id; } }\n';
    const root = committed({
      'app/Services/UserService.php': service,
      'app/Http/UserController.php': '<?php\nnamespace App\\Http;\nuse App\\Services\\UserService;\nclass UserController { public function show(UserService $s) { return $s->find(1); } }\n',
    });
    try {
      mapx(root, 'scan', root);
      rmSync(join(root, 'app/Services/UserService.php'));
      mapx(root, 'sync', root);
      writeFileSync(join(root, 'app/Repo.php'), '<?php\nnamespace App;\nclass Repo { public function find($id) { return $id; } }\n');
      mapx(root, 'sync', root);
      mkdirSync(join(root, 'app/Core'));
      writeFileSync(join(root, 'app/Core/UserService.php'), service);
      mapx(root, 'sync', root);
      const uncommitted = rows(root);
      expect(touching(root, 'app/Core/UserService.php')).toEqual(expect.arrayContaining([
        'app/Http/UserController.php -> app/Core/UserService.php import',
        'app/Http/UserController.php -> app/Core/UserService.php param_type',
      ]));
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'moved');
      mapx(root, 'sync', root);
      expect(rows(root)).toEqual(uncommitted);
      mapx(root, 'scan', root, '--force');
      expect(rows(root)).toEqual(uncommitted);
    } finally {
      cleanup(root);
    }
  }, 120000);
});

describe('export directory excludes', () => {
  it('export --format json --exclude **/Http prunes the folder as scan does', () => {
    const root = workspace(files);
    try {
      init(root);
      mapx(root, 'scan', root);
      const out = mapx(root, 'export', '-d', root, '--format', 'json', '--exclude', '**/Http');
      const json = JSON.parse(out.slice(out.indexOf('{')));
      expect(JSON.stringify(json)).not.toContain('app/Http/');
      expect(JSON.stringify(json)).toContain('app/Services/UserService.php');
    } finally {
      cleanup(root);
    }
  }, 60000);
});

// M0-02-R8: sync after a symbol is renamed, after a resolution config changes, and status after an
// edit git does not list.
describe('sync re-links renamed symbols and follows config changes (M0-02-R8)', () => {
  const calls = (root: string) =>
    query<{ e: string }>(root, "SELECT source_file || ' -> ' || target_file || '#' || target_symbol AS e FROM edges WHERE edge_type = 'call' ORDER BY e").map((r) => r.e);
  const all = (root: string) => query<{ e: string }>(root, "SELECT source_file || '|' || target_file || '|' || edge_type || '|' || coalesce(target_symbol, '') AS e FROM edges ORDER BY e").map((r) => r.e);
  const committed = (tree: Record<string, string>) => {
    const root = workspace({ '.gitignore': '.mapx/\n', ...tree }, ['.']);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    init(root);
    return root;
  };

  it.each([['tracked', 'src'], ['gitignored', 'gen']])('drops the callers\' edge to a renamed function (%s), as scan --force', (_, dir) => {
    const root = committed({
      ...(dir === 'gen' ? { '.gitignore': '.mapx/\ngen/\n' } : {}),
      [`${dir}/a.js`]: 'export function alpha() { return 1; }\n',
      'src/usea.js': `import { alpha } from '../${dir}/a.js';\nexport const u = () => alpha();\n`,
    });
    try {
      mapx(root, 'scan', root);
      expect(calls(root)).toEqual([`src/usea.js -> ${dir}/a.js#alpha`]);
      writeFileSync(join(root, `${dir}/a.js`), 'export function alphb() { return 1; }\n');
      mapx(root, 'sync', root);
      expect(calls(root)).toEqual([]);
      const synced = all(root);
      mapx(root, 'scan', root, '--force');
      expect(all(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('restores the callers\' edge when a rename is undone: a branch round-trip and an edit round-trip', () => {
    const root = committed({ 'src/a.ts': 'export function foo() { return 1; }\n', 'src/b.ts': "import { foo } from './a';\nexport const b = () => foo();\n" });
    try {
      mapx(root, 'scan', root);
      const fresh = all(root);
      git(root, 'checkout', '-qb', 'feature');
      writeFileSync(join(root, 'src/a.ts'), 'export function bar() { return 1; }\n');
      git(root, 'commit', '-qam', 'rename');
      mapx(root, 'sync', root);
      expect(calls(root)).toEqual([]);
      git(root, 'checkout', '-q', '-');
      mapx(root, 'sync', root);
      expect(all(root)).toEqual(fresh);
      // The same without a commit: edit away and back, a sync after each edit.
      writeFileSync(join(root, 'src/a.ts'), 'export function fo() { return 1; }\n');
      mapx(root, 'sync', root);
      writeFileSync(join(root, 'src/a.ts'), 'export function foo() { return 1; }\n');
      mapx(root, 'sync', root);
      expect(all(root)).toEqual(fresh);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('handles a renamed function named like an Object.prototype member (toString)', () => {
    const root = committed({ 'src/money.ts': 'export function toString(m: number) { return String(m); }\n', 'src/b.ts': "import { toString } from './money';\nexport const b = () => toString(1);\n" });
    try {
      mapx(root, 'scan', root);
      writeFileSync(join(root, 'src/money.ts'), 'export function stringify(m: number) { return String(m); }\n');
      mapx(root, 'sync', root);
      mapx(root, 'sync', root);
      const synced = all(root);
      mapx(root, 'scan', root, '--force');
      expect(all(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('re-resolves when package.json gains a dependency, as scan --force', () => {
    const root = committed({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/lib.js': 'export function create() { return 1; }\n',
      'src/use.js': "import axios from 'axios';\nexport const c = () => axios.create();\n",
    });
    try {
      mapx(root, 'scan', root);
      // axios is no listed package yet: name resolution applies.
      expect(calls(root)).toEqual(['src/use.js -> src/lib.js#create']);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { axios: '^1.0.0' } }));
      mapx(root, 'sync', root);
      expect(calls(root)).toEqual([]);
      const synced = all(root);
      mapx(root, 'scan', root, '--force');
      expect(all(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('follows a tsconfig reached through extends: created after the scan, then edited', () => {
    const root = committed({
      '.gitignore': '.mapx/\n.svelte-kit/\n',
      // SvelteKit's root tsconfig extends the one `svelte-kit sync` generates.
      'tsconfig.json': JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }),
      'src/lib/x.ts': 'export function x() { return 1; }\n',
      'src/lib2/x.ts': 'export function x() { return 2; }\n',
      'src/app.ts': "import { x } from '$lib/x';\nexport const a = () => x();\n",
    });
    const imports = () => query<{ t: string }>(root, "SELECT target_file AS t FROM edges WHERE source_file = 'src/app.ts' AND edge_type = 'import' ORDER BY t").map((r) => r.t);
    const kit = (dir: string) => JSON.stringify({ compilerOptions: { paths: { '$lib/*': [`../src/${dir}/*`] } } });
    try {
      mapx(root, 'scan', root);
      expect(imports()).toEqual([]);
      mkdirSync(join(root, '.svelte-kit'));
      writeFileSync(join(root, '.svelte-kit/tsconfig.json'), kit('lib'));
      mapx(root, 'sync', root);
      expect(imports()).toEqual(['src/lib/x.ts']);
      writeFileSync(join(root, '.svelte-kit/tsconfig.json'), kit('lib2'));
      mapx(root, 'sync', root);
      expect(imports()).toEqual(['src/lib2/x.ts']);
      const synced = all(root);
      mapx(root, 'scan', root, '--force');
      expect(all(root)).toEqual(synced);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('mapx status of the primary repo leaves a nested registered repo\'s edits to that repo', () => {
    const root = workspace({ '.gitignore': '.mapx/\nlibs/ui/\n', 'src/a.ts': 'export const a = 1;\n', 'libs/ui/b.ts': 'export const b = 1;\n' }, ['.', 'libs/ui']);
    try {
      for (const dir of ['libs/ui', '.']) {
        git(join(root, dir), 'add', '-A');
        git(join(root, dir), 'commit', '-qm', 'init');
      }
      init(root);
      mapx(root, 'workspaces', 'add', 'libs/ui');
      mapx(root, 'scan', '--all');
      writeFileSync(join(root, 'libs/ui/b.ts'), 'export const b = 2;\n');
      const future = new Date(Date.now() + 5000);
      utimesSync(join(root, 'libs/ui/b.ts'), future, future);
      expect(mapx(root, 'status', '-d', root)).toContain('No changes since last scan');
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('mapx status reports an edit to a gitignored indexed file', () => {
    const root = committed({ '.gitignore': '.mapx/\ngen/\n', 'src/a.ts': 'export const a = 1;\n', 'gen/x.ts': 'export function l() { return 1; }\n' });
    try {
      mapx(root, 'scan', root);
      expect(mapx(root, 'status', '-d', root)).toContain('No changes since last scan');
      writeFileSync(join(root, 'gen/x.ts'), 'export function l2() { return 2; }\n');
      const future = new Date(Date.now() + 5000);
      utimesSync(join(root, 'gen/x.ts'), future, future);
      expect(mapx(root, 'status', '-d', root)).toContain('~ gen/x.ts');
      // Deleted too (review 2026-11-01).
      mapx(root, 'sync', root);
      rmSync(join(root, 'gen/x.ts'));
      expect(mapx(root, 'status', '-d', root)).toContain('- gen/x.ts');
    } finally {
      cleanup(root);
    }
  }, 120000);
});
