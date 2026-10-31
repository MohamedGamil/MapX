import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

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
};

describe('glob filters', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(files);
    init(root);
  }, 60000);
  afterAll(() => cleanup(root));
  const edgeCount = () => query<{ n: number }>(root, 'SELECT count(*) AS n FROM edges')[0]!.n;

  it('restores inbound edges after an exclude is removed', () => {
    mapx(root, 'scan', root);
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
    const all = (mapx(root, 'scan', root), paths());
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
});

describe('Laravel default excludes at scan time', () => {
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
    expect(scanWith({})).not.toContain('resources/views/welcome.blade.php');
  }, 60000);

  it('respects a declined suggestion', () => {
    expect(scanWith({ laravelDefaultExcludes: false })).toContain('resources/views/welcome.blade.php');
  }, 60000);
});
