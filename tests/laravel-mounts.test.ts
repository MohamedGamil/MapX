import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { opensConditionalBlock, phpString, resourceParam } from '../src/frameworks/detectors/laravel-mounts.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M1-02 … M1-09: Laravel route mounts, handlers, parameters, reachability and route metadata.
interface RouteView {
  method: string;
  path: string;
  handlerSymbol?: string;
  line: number | null;
  name: string | null;
  middlewares: string[];
  reachable: boolean;
  overridden: boolean;
  conditional: boolean;
  dynamic?: boolean;
}

describe('laravel-mounts helpers', () => {
  it('evaluates PHP path and URI expressions', () => {
    const scope = { dir: 'app/routes', root: 'app', vars: new Map([['base', 'notices']]) };
    expect(phpString("__DIR__.'/api/users.php'", scope)).toBe('app/routes/api/users.php');
    expect(phpString("base_path('routes/v2.php')", scope)).toBe('app/routes/v2.php');
    expect(phpString("dirname(__DIR__).'/x.php'", scope)).toBe('app/x.php');
    expect(phpString("$base.'/latest'", scope)).toBe('notices/latest');
    expect(phpString("SOME_CONST.'/x'", scope)).toBeNull();
    expect(phpString('"a$b"', scope)).toBeNull();
  });

  it("singularises resource names like Laravel's Str::singular, with - replaced by _", () => {
    expect(['blog-categories', 'statuses', 'people', 'children', 'addresses', 'boxes', 'news', 'photos.comments'].map(resourceParam))
      .toEqual(['blog_category', 'status', 'person', 'child', 'address', 'box', 'news', 'comment']);
  });

  it('recognises conditional blocks', () => {
    expect(opensConditionalBlock("if (config('a.b')) ")).toBe(true);
    expect(opensConditionalBlock('} else ')).toBe(true);
    expect(opensConditionalBlock('function () ')).toBe(false);
    expect(opensConditionalBlock("Route::group(['x' => 1], function () ")).toBe(false);
  });
});

describe('Laravel routes through the real scanner', () => {
  let root: string;
  let routes: RouteView[];
  const find = (method: string, path: string) => routes.filter((r) => r.method.split('|').includes(method) && r.path === path);

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/api.php': [
        '<?php',
        'use Illuminate\\Support\\Facades\\Route;',
        "Route::group(['namespace' => 'App\\\\Http\\\\Controllers'], function () {",
        "    Route::get('/x', ['type' => 'T', 'uses' => 'XController@show']);",
        '});',
        "Route::group(['middleware' => 'auth'], function () { require __DIR__.'/api/users.php'; });",
        "Route::prefix('admin')->group(function () { require __DIR__.'/api/users.php'; });",
        "Route::resource('people', 'PersonController')->parameters(['people' => 'admin_user'])->only(['show']);",
        "Route::get(SOME_CONST.'/x', 'ConstController@x');",
        "Route::prefix('v2')->group(base_path('routes/v2.php'));",
        "Route::get('after', 'AfterController@index');",
      ].join('\n'),
      'routes/api/users.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('users', 'UserController@index')->name('users.index');\n",
      'routes/v2.php': "<?php\nRoute::get('ping', 'PingController@ping');\n",
      'routes/orphan.php': "<?php\nRoute::get('orphan', 'OrphanController@show');\n",
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  it('M1-02: resolves a uses-array handler to the group namespace FQN', () => {
    expect(find('GET', '/api/x').map((r) => r.handlerSymbol)).toEqual(['App\\Http\\Controllers\\XController@show']);
  });

  it('M1-03: required files inherit prefix and middleware, once per mount', () => {
    const users = find('GET', '/api/users');
    expect(users).toHaveLength(1);
    expect(users[0]!.middlewares).toEqual(expect.arrayContaining(['api', 'auth']));
    expect(find('GET', '/api/admin/users')).toHaveLength(1);
    expect(find('GET', '/users')).toHaveLength(0);
  });

  it('M1-04: a ->group(<path>) mount applies its prefix and does not leak to later routes', () => {
    expect(find('GET', '/api/v2/ping')).toHaveLength(1);
    expect(find('GET', '/api/after')).toHaveLength(1);
    expect(find('GET', '/api/v2/after')).toHaveLength(0);
  });

  it('M1-05: honours ->parameters() and ->only() on resources', () => {
    const people = routes.filter((r) => r.path.startsWith('/api/people'));
    expect(people.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/people/{admin_user}']);
  });

  it('M1-06: an unresolvable dynamic path is flagged instead of leaking PHP text', () => {
    const dynamic = routes.filter((r) => r.handlerSymbol?.endsWith('ConstController@x'));
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]!.dynamic).toBe(true);
    expect(dynamic[0]!.path).not.toContain("'");
  });

  it('M1-07: routes in a file nothing loads are unreachable', () => {
    const orphan = find('GET', '/orphan');
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.reachable).toBe(false);
    expect(find('GET', '/api/users')[0]!.reachable).toBe(true);
  });

  it('M1-09: routes --json carries line, name, middlewares and flags on every route', () => {
    for (const r of routes)
      for (const key of ['line', 'name', 'middlewares', 'reachable', 'overridden', 'conditional']) expect(r, key).toHaveProperty(key);
    const users = find('GET', '/api/users')[0]!;
    expect(users.line).toBe(4);
    expect(users.name).toBe('users.index');
  });

  it('M1-09: route edges keep line and middlewares', () => {
    const edges = query<{ metadata: string }>(root, "SELECT metadata FROM edges WHERE edge_type = 'route' AND source_file = 'routes/api/users.php'");
    const metas = edges.map((e) => JSON.parse(e.metadata));
    const auth = metas.find((m) => m.uri === '/api/users');
    expect(auth).toMatchObject({ line: 4, name: 'users.index' });
    expect(auth.middlewares).toEqual(expect.arrayContaining(['api', 'auth']));
  });
});

describe('M1-08: nested Laravel roots and frameworks.json', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'backend/artisan': '#!/usr/bin/env php\n<?php\n',
      'backend/routes/api.php': "<?php\nRoute::get('health', 'HealthController@show');\n",
      'docs/readme.md': '# parent folder\n',
    });
    init(root);
    mkdirSync(join(root, '.mapx'), { recursive: true });
    writeFileSync(join(root, '.mapx', 'frameworks.json'), JSON.stringify(['laravel', 'express']));
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('detects a Laravel app below a parent-folder workspace root', () => {
    const routes: RouteView[] = JSON.parse(mapx(root, 'routes', root, '--json'));
    expect(routes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/health');
  });

  it('keeps frameworks listed in frameworks.json', () => {
    const file = join(root, '.mapx', 'frameworks.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expect.arrayContaining(['laravel', 'express']));
  });
});
