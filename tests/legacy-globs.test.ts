import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    mapx(root, 'scan', root, '--exclude', 'app\\Services\\**');
    expect(paths()).toEqual(expected);
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
  const touching = (root: string, path: string) =>
    query<{ e: string }>(
      root,
      "SELECT source_file || ' -> ' || target_file || ' ' || edge_type AS e FROM edges WHERE (source_file = ? OR target_file = ?) AND source_file != target_file ORDER BY e",
      path,
      path,
    ).map((r) => r.e);

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

      // Committed rename. The class keeps its name: the `use` imports no longer resolve (PSR-4
      // path), but UserController's parameter type still resolves to the class at its new path.
      git(root, 'mv', USER_SERVICE, ACCOUNT_SERVICE);
      git(root, 'commit', '-qm', 'rename');
      mapx(root, 'sync', root);
      const synced = snapshot(root);
      expect(synced.files).toContain(ACCOUNT_SERVICE);
      expect(synced.files).not.toContain(USER_SERVICE);
      expect(touching(root, USER_SERVICE)).toEqual([]);
      expect(touching(root, ACCOUNT_SERVICE)).toEqual([`app/Http/Controllers/UserController.php -> ${ACCOUNT_SERVICE} param_type`]);
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
