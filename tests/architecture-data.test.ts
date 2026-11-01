import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-32-R3 (found by the M4-16 dashboard audit): what the Architecture tab shows. A cycle smell named
// a file's self-loop (`a.ts -> a.ts`) instead of the multi-file cycle found, and the codebase profile
// listed frameworks found only in graph-excluded folders (tests/fixtures).
type Smell = { type: string; description: string; involved_files: string };

describe('architecture data shown by the dashboard (real scan)', () => {
  let root: string;
  afterEach(() => cleanup(root));

  it('a cycle smell names the multi-file cycle, not a file\'s edge to itself, and a self-loop alone is no cycle', () => {
    root = workspace({
      // a and b each call a helper in their own file (edges a.ts -> a.ts, b.ts -> b.ts); a calls b and
      // b calls a: one cycle a -> b -> a, whichever file the search starts from.
      'src/a.ts': "import { b } from './b';\nfunction helper(n: number) { return n * 2; }\nexport function a(n: number): number { return helper(n) + b(n); }\n",
      'src/b.ts': "import { a } from './a';\nfunction half(n: number) { return n / 2; }\nexport function b(n: number): number { return n > 10 ? a(half(n)) : n; }\n",
      // c only calls within its own file.
      'src/c.ts': 'function d(n: number) { return n; }\nexport function c(n: number): number { return d(n); }\n',
    });
    init(root);
    mapx(root, 'scan');
    const cycles = query<Smell>(root, "SELECT type, description, involved_files FROM arch_smells WHERE type = 'cyclic-dependency'");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.description).toMatch(/^Cyclic dependency detected: (a\.ts -> b\.ts -> a\.ts|b\.ts -> a\.ts -> b\.ts)$/);
    expect(JSON.parse(cycles[0]!.involved_files).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  }, 120000);

  it('the profile lists only frameworks found outside graph-excluded folders; their routes are still extracted', () => {
    root = workspace({
      'src/app.ts': 'export const app = 1;\n',
      // A Laravel fixture app under tests/ (graph-excluded by default).
      'tests/fixtures/shop/artisan': '#!/usr/bin/env php\n<?php\n',
      'tests/fixtures/shop/composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      'tests/fixtures/shop/routes/web.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/products', [ProductController::class, 'index']);\n",
      'tests/fixtures/shop/app/Http/Controllers/ProductController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass ProductController { public function index() {} }\n',
    });
    init(root);
    mapx(root, 'scan');
    const repo = query<{ value: string }>(root, "SELECT value FROM meta WHERE key LIKE 'codebase_profile:%'");
    const profile = JSON.parse(repo[0]!.value);
    expect(profile.detectedFrameworks).not.toContain('laravel');
    const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as Array<{ path: string }>;
    expect(routes.map((r) => r.path)).toContain('/products');
  }, 120000);

  const laravelApp = (dir: string) => ({
    [`${dir}/artisan`]: '#!/usr/bin/env php\n<?php\n',
    [`${dir}/routes/web.php`]: "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/items', [ItemController::class, 'index']);\n",
    [`${dir}/app/Http/Controllers/ItemController.php`]: '<?php\nnamespace App\\Http\\Controllers;\nclass ItemController { public function index() {} }\n',
  });
  const profileOf = (repo?: string) => {
    const rows = query<{ key: string; value: string }>(root, "SELECT key, value FROM meta WHERE key LIKE 'codebase_profile:%'");
    const row = repo ? rows.find((r) => r.key === `codebase_profile:${repo}`) : rows[0];
    return JSON.parse(row!.value) as { detectedFrameworks: string[] };
  };

  it('keeps a framework with an app outside graph-excluded folders, beside a fixture app (review 2026-11-01)', () => {
    root = workspace({ ...laravelApp('apps/shop'), ...laravelApp('tests/fixtures/shop') });
    init(root);
    mapx(root, 'scan');
    expect(profileOf().detectedFrameworks).toContain('laravel');
  }, 120000);

  it('keeps a nested repo\'s own app in its profile, not in the primary repo\'s (review 2026-11-01)', () => {
    root = workspace({ 'src/app.ts': 'export const app = 1;\n', ...laravelApp('backend') });
    execFileSync('git', ['init', '-q', join(root, 'backend')]);
    init(root);
    mapx(root, 'workspaces', 'add', 'backend');
    mapx(root, 'scan');
    expect(profileOf('backend').detectedFrameworks).toContain('laravel');
    const primary = JSON.parse(readFileSync(join(root, '.mapx/config.json'), 'utf8')).repos[0].name as string;
    expect(profileOf(primary).detectedFrameworks).not.toContain('laravel');
  }, 120000);

  it('judges a folder by its files whatever the exclude glob\'s shape (review 2026-11-01)', () => {
    // **/fixtures/* matches lib/fixtures/artisan, but not the app's deeper files: the app counts.
    root = workspace({ 'src/app.ts': 'export const app = 1;\n', ...laravelApp('lib/fixtures') });
    init(root);
    const configPath = join(root, '.mapx/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.settings.graphExcludePatterns = ['**/fixtures/*'];
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    mapx(root, 'scan');
    expect(profileOf().detectedFrameworks).toContain('laravel');
  }, 120000);
});
