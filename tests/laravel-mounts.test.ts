import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskPhp, opensConditionalBlock, phpString, resourceParam } from '../src/frameworks/detectors/laravel-mounts.js';
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
    // Review 2026-10-31 (post-acceptance defect): `-ses`/`-zes` words lost their final `e`.
    expect(['courses', 'responses', 'sizes', 'cases', 'houses', 'licenses', 'databases', 'phases', 'prizes', 'branches', 'dishes', 'glasses'].map(resourceParam))
      .toEqual(['course', 'response', 'size', 'case', 'house', 'license', 'database', 'phase', 'prize', 'branch', 'dish', 'glass']);
  });

  it('M1-03-R1: masks comments, strings and heredocs without moving offsets', () => {
    const src = [
      "<?php $a = 'x{y};/*'; # Route::get('h')",
      "// Route::get('s') ?>html<?php $b = \"q\\\"{\";",
      "/* Route::get('b') */ $c = <<<TXT",
      "  Route::get('d'); {",
      "  TXT;",
      "$e = <<<'NOW'",
      "}\nNOW;",
      "Route::get('live');",
    ].join('\n');
    const { code, text } = maskPhp(src);
    expect(code).toHaveLength(src.length);
    expect(text).toHaveLength(src.length);
    expect(code.split('\n').length).toBe(src.split('\n').length);
    // Only the last line keeps route code; braces and semicolons inside strings are gone.
    expect(code.match(/Route::/g)).toHaveLength(1);
    expect(code.indexOf('Route::')).toBe(src.lastIndexOf('Route::'));
    expect(code.replace(/[^{}]/g, '')).toBe('');
    // Comment-free text keeps string contents for argument evaluation.
    expect(text).toContain("'x{y};/*'");
    expect(text).not.toContain("Route::get('h')");
    expect(text).not.toContain("Route::get('b')");
  });

  it('M1-03-R1: evaluates interpolated strings from local variables, else null', () => {
    const scope = { dir: '', root: '', vars: new Map([['base', 'notices']]) };
    expect(phpString('"$base/x"', scope)).toBe('notices/x');
    expect(phpString('"{$base}/x"', scope)).toBe('notices/x');
    expect(phpString('"${base}/x"', scope)).toBe('notices/x');
    expect(phpString('"\\$base/x"', scope)).toBe('$base/x');
    expect(phpString('"$missing/x"', scope)).toBeNull();
    expect(phpString('"{$base->x}/y"', scope)).toBeNull();
    expect(phpString('"$base[0]/y"', scope)).toBeNull();
    // With a fallback only the unresolvable part is replaced.
    expect(phpString('"{$missing}/x/$base"', scope, '{dynamic}')).toBe('{dynamic}/x/notices');
    expect(phpString("SOME_CONST.'/x'.$base", scope, '{dynamic}')).toBe('{dynamic}/xnotices');
    expect(phpString('"{$a->b}/$c[1]/y"', scope, '{dynamic}')).toBe('{dynamic}/{dynamic}/y');
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

describe('M1-03-R1: brace-less groups, comments and dynamic paths through the real scanner', () => {
  let root: string;
  let routes: RouteView[];
  const find = (method: string, path: string) => routes.filter((r) => r.method.split('|').includes(method) && r.path === path);

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/api.php': [
        '<?php',
        'use Illuminate\\Support\\Facades\\Route;',
        // The M1-03 AC1 arrow form: the group ends with the call, not at a later brace.
        "Route::group(['middleware' => 'auth'], fn () => require __DIR__.'/api/users.php');",
        "Route::get('open', 'OpenController@index');",
        "# Route::get('hashed', 'GhostController@show');",
        "Route::get(\"{$unknown}/x\", 'DynController@x');",
        "Route::get(\"$alsoUnknown/y\", 'DynController@y');",
        "Route::prefix($nope)->group(function () { Route::get('z', 'DynController@z'); });",
        "Route::group(['prefix' => $nope], function () { Route::get('w', 'DynController@w'); });",
        "Route::prefix($nope)->group(__DIR__.'/api/mounted.php');",
        "Route::get('last', 'LastController@index');",
      ].join('\n'),
      'routes/api/users.php': "<?php\nRoute::get('users', 'UserController@index');\n",
      'routes/api/mounted.php': "<?php\nRoute::get('m', 'DynController@m');\n",
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  it('scopes the arrow-function group to its call: the required file gets auth, later routes do not', () => {
    const users = find('GET', '/api/users');
    expect(users).toHaveLength(1);
    expect(users[0]!.middlewares).toEqual(expect.arrayContaining(['api', 'auth']));
    for (const path of ['/api/open', '/api/last']) {
      const later = find('GET', path);
      expect(later, path).toHaveLength(1);
      expect(later[0]!.middlewares, path).not.toContain('auth');
    }
  });

  it('never reports a route from a # comment', () => {
    expect(routes.filter((r) => r.path.includes('hashed'))).toEqual([]);
  });

  it('flags unresolvable interpolated URIs and variable prefixes as dynamic instead of emitting PHP text', () => {
    const dyn = routes.filter((r) => r.handlerSymbol?.includes('DynController@'));
    expect(dyn.map((r) => `${r.handlerSymbol!.split('\\').pop()} ${r.path} ${r.dynamic}`).sort()).toEqual([
      'DynController@m /api/{dynamic}/m true',
      'DynController@w /api/{dynamic}/w true',
      'DynController@x /api/{dynamic}/x true',
      'DynController@y /api/{dynamic}/y true',
      'DynController@z /api/{dynamic}/z true',
    ]);
    for (const r of routes) expect(r.path, r.path).not.toMatch(/[$'"]/);
    expect(find('GET', '/api/last')[0]!.dynamic).toBeFalsy();
  });
});

describe('M1-07-R1: unknown reachability, duplicate winners and override keys through the real scanner', () => {
  let root: string;
  let routes: (RouteView & { reachability?: string; overriddenBy?: string; domain?: string })[];
  const find = (method: string, path: string) => routes.filter((r) => r.method.split('|').includes(method) && r.path === path);
  const short = (r: RouteView) => r.handlerSymbol?.split('\\').pop();

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/api.php': [
        '<?php',
        'use App\\Http\\Controllers\\DupController;',
        "Route::get('same', [DupController::class, 'show']);",
        "require __DIR__.'/api/again.php';",
        // Nothing can evaluate this mount, so unmounted files may still be loaded by it.
        'require $pluginRoutes;',
        "Route::get('items/{id}', 'ItemController@byId');",
        "Route::get('items/{slug}', 'ItemController@bySlug');",
        "Route::domain('admin.example.com')->group(function () { Route::get('home', 'AdminController@home'); });",
        "Route::get('home', 'SiteController@home');",
        "Route::get(SOME_CONST.'/z', 'DynController@z');",
      ].join('\n'),
      'routes/api/again.php': "<?php\nuse App\\Http\\Controllers\\DupController;\n\nRoute::get('same', [DupController::class, 'show']);\n",
      'routes/hidden.php': "<?php\nRoute::get('hidden', 'HiddenController@show');\n",
      'routes/cached.php': "<?php\nRoute::get('cached', 'CachedController@show');\n",
      'app/Providers/CacheServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use Illuminate\\Support\\ServiceProvider;',
        'class CacheServiceProvider extends ServiceProvider',
        '{',
        '    public function boot(): void',
        '    {',
        '        if (! $this->app->routesAreCached()) {',
        "            $this->loadRoutesFrom(base_path('routes/cached.php'));",
        '        }',
        '    }',
        '}',
      ].join('\n'),
      'app/Http/Controllers/DupController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass DupController { public function show() {} }\n',
      'app/Http/Controllers/AttrController.php': [
        '<?php',
        'namespace App\\Http\\Controllers;',
        'use Spatie\\RouteAttributes\\Attributes\\Get;',
        'class AttrController',
        '{',
        "    #[Get('/attr')]",
        '    public function show() {}',
        '}',
      ].join('\n'),
      'resources/js/client.js': "import axios from 'axios';\nexport const hidden = () => axios.get('/hidden');\n",
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  it('keeps both copies of a route overridden with the same handler, pointing at the winner', () => {
    const same = find('GET', '/api/same');
    expect(same.map((r) => `${r.line} ${r.overridden} ${r.overriddenBy ?? '-'}`).sort()).toEqual([
      '3 true routes/api/again.php:4',
      '4 false -',
    ]);
  });

  it('marks routes of unmounted files unknown, not unreachable, when a mount cannot be evaluated, and pairs them', () => {
    const hidden = find('GET', '/hidden');
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.reachable).toBe(true);
    expect(hidden[0]!.reachability).toBe('unknown');
    expect(find('GET', '/api/same').every((r) => r.reachability === 'reachable')).toBe(true);
    expect(mapx(root, 'routes', root).split('\n').find((l) => l.includes('/hidden'))).toContain('[reachability unknown]');
    const http = query<{ source_file: string; target_symbol: string }>(root, "SELECT source_file, target_symbol FROM edges WHERE edge_type = 'http'");
    expect(http.map((e) => `${e.source_file} ${e.target_symbol?.split('\\').pop()}`)).toContain('resources/js/client.js HiddenController@show');
    const edge = query<{ metadata: string }>(root, "SELECT metadata FROM edges WHERE edge_type = 'route' AND source_file = 'routes/hidden.php'");
    expect(JSON.parse(edge[0]!.metadata)).toMatchObject({ reachability: 'unknown' });
  });

  it('keys overrides on the exact URI and the domain', () => {
    expect(find('GET', '/api/items/{id}').map((r) => r.overridden)).toEqual([false]);
    expect(find('GET', '/api/items/{slug}').map((r) => r.overridden)).toEqual([false]);
    const home = find('GET', '/api/home');
    expect(home.map((r) => `${short(r)} ${r.domain ?? '-'} ${r.overridden}`).sort()).toEqual([
      'AdminController@home admin.example.com false',
      'SiteController@home - false',
    ]);
  });

  it('does not treat `if (! $this->app->routesAreCached())` as a conditional mount', () => {
    const cached = find('GET', '/cached');
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({ reachable: true, conditional: false });
  });

  it('gives attribute routes a line, and route edges keep dynamic and mountedBy', () => {
    expect(find('GET', '/attr').map((r) => r.line)).toEqual([6]);
    const metas = query<{ metadata: string }>(root, "SELECT metadata FROM edges WHERE edge_type = 'route'").map((e) => JSON.parse(e.metadata));
    expect(metas.every((m) => typeof m.line === 'number')).toBe(true);
    expect(metas.find((m) => m.uri === '/api/{dynamic}/z')).toMatchObject({ dynamic: true });
    expect(metas.find((m) => m.uri === '/api/same' && m.overridden === undefined)).toMatchObject({ mountedBy: 'routes/api.php:4' });
  });
});

// Review 2026-10-31 (P2, M1-05): resource options arrays, nested and plural registration, array
// handlers without `uses`, and group name prefixes. EXPECTED is the route list Laravel 12.70's own
// router builds from these files (vendor Illuminate\Routing, driven by a scratch oracle script),
// with two documented differences: MapX reports resource `update` as separate PUT and PATCH routes,
// and an action array whose callable is `[C::class, 'm']` (no `uses`) is reported as C@m, which is
// what Laravel runs, where route:list prints "Closure".
describe('M1-05-R1: resource forms, array handlers and group name prefixes match Laravel', () => {
  let root: string;
  let routes: RouteView[];
  const EXPECTED = [
    'GET /api/photos gallery PhotoController@index [api,auth]',
    'GET /api/photos/{picture} photos.show PhotoController@show [api,auth]',
    'GET /api/videos media.videos.index VideoController@index [api]',
    'POST /api/videos media.videos.store VideoController@store [api]',
    'GET /api/videos/{video} media.videos.show VideoController@show [api]',
    'GET /api/albums/{album} records.show AlbumController@show [api]',
    'GET /api/photos/{pic}/comments photos.comments.index CommentController@index [api]',
    'POST /api/photos/{pic}/comments photos.comments.store CommentController@store [api]',
    'GET /api/photos/{pic}/comments/{comment} photos.comments.show CommentController@show [api]',
    'PUT /api/photos/{pic}/comments/{comment} photos.comments.update CommentController@update [api]',
    'PATCH /api/photos/{pic}/comments/{comment} photos.comments.update CommentController@update [api]',
    'DELETE /api/photos/{pic}/comments/{comment} photos.comments.destroy CommentController@destroy [api]',
    'GET /api/admin/posts/{post}/notes posts.notes.index NoteController@index [api]',
    'POST /api/admin/posts/{post}/notes posts.notes.store NoteController@store [api]',
    'GET /api/admin/notes/{note} notes.show NoteController@show [api]',
    'GET /api/cats/{cat} cats.show CatController@show [api]',
    'GET /api/dogs/{dog} dogs.show UserController@show [api]',
    'GET /api/badges badges.index BadgeController@index [api]',
    'POST /api/badges badges.store BadgeController@store [api]',
    'GET /api/badges/{badge} badges.show BadgeController@show [api]',
    'PUT /api/badges/{badge} badges.update BadgeController@update [api]',
    'PATCH /api/badges/{badge} badges.update BadgeController@update [api]',
    'DELETE /api/badges/{badge} badges.destroy BadgeController@destroy [api]',
    'GET /api/items items.index ItemController@index [api]',
    'GET /api/items/create items.create ItemController@create [api]',
    'GET /api/tags tags.all TagController@index [api,auth]',
    'GET /api/closure closure.show Closure [api,auth,verified]',
    'GET /api/callable - UserController@show [api,throttle]',
    'GET /api/admin/home admin.home AdminController@home [api]',
    'GET /api/admin/bare admin. AdminController@bare [api]',
    'GET /api/admin/reports/daily admin.reports.daily ReportController@daily [api]',
    'GET /api/admin/reports/exports admin.reports.exports.index ExportController@index [api]',
    'GET /api/admin/users admin.users AdminController@users [api]',
    'GET /api/after after AfterController@index [api]',
  ];
  const line = (r: RouteView) =>
    `${r.method} ${r.path} ${r.name ?? '-'} ${r.handlerSymbol?.split('\\').pop() ?? 'Closure'} [${r.middlewares.join(',')}]`;

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/api.php': [
        '<?php',
        'use App\\Http\\Controllers\\PhotoController;',
        'use App\\Http\\Controllers\\UserController;',
        'use Illuminate\\Support\\Facades\\Route;',
        '',
        // Third-argument options (array and array()) and chained options.
        "Route::resource('photos', PhotoController::class, ['only' => ['index', 'show'], 'parameters' => ['photos' => 'picture'], 'names' => ['index' => 'gallery'], 'middleware' => 'auth']);",
        "Route::apiResource('videos', 'VideoController', array('except' => ['destroy', 'update'], 'as' => 'media'));",
        "Route::resource('albums', 'AlbumController')->only('show')->names('records');",
        // Nested (parameters apply to the parent segment too) and prefixed shallow nesting.
        "Route::resource('photos.comments', 'CommentController')->parameters(['photos' => 'pic'])->except(['create', 'edit']);",
        "Route::resource('admin/posts.notes', 'NoteController')->shallow()->only(['index', 'store', 'show']);",
        // Plural registration with shared options.
        "Route::resources(['cats' => 'CatController', 'dogs' => UserController::class], ['only' => ['show']]);",
        "Route::apiResources(['badges' => 'BadgeController']);",
        // apiResource()->only() replaces the API default, and a chained prefix never reaches a resource.
        "Route::apiResource('items', 'ItemController')->only(['index', 'create']);",
        "Route::prefix('ignored')->middleware('auth')->resource('tags', 'TagController')->only(['index'])->name('index', 'tags.all');",
        // Array handlers without `uses`.
        "Route::get('closure', ['as' => 'closure.', 'middleware' => ['auth', 'verified'], function () { return 1; }])->name('show');",
        "Route::get('callable', ['middleware' => 'throttle', [UserController::class, 'show']]);",
        // Group name prefixes: chained, array `as`, nested, on resources and across a require mount.
        "Route::name('admin.')->prefix('admin')->group(function () {",
        "    Route::get('home', 'AdminController@home')->name('home');",
        "    Route::get('bare', 'AdminController@bare');",
        "    Route::group(['as' => 'reports.', 'prefix' => 'reports'], function () {",
        "        Route::get('daily', ['as' => 'daily', 'uses' => 'ReportController@daily']);",
        "        Route::resource('exports', 'ExportController')->only(['index']);",
        '    });',
        "    require __DIR__.'/api/admin.php';",
        '});',
        "Route::get('after', 'AfterController@index')->name('after');",
      ].join('\n'),
      'routes/api/admin.php': "<?php\nRoute::get('users', 'AdminController@users')->name('users');\n",
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  it("reports exactly Laravel's route list: URIs, parameters, handlers, names and middleware", () => {
    expect(routes.map(line).sort()).toEqual([...EXPECTED].sort());
  });

  it('resolves resources and array handlers to fully-qualified controllers', () => {
    const fqn = (path: string) => routes.filter((r) => r.path === path).map((r) => r.handlerSymbol);
    expect(fqn('/api/dogs/{dog}')).toEqual(['App\\Http\\Controllers\\UserController@show']);
    expect(fqn('/api/callable')).toEqual(['App\\Http\\Controllers\\UserController@show']);
    expect(fqn('/api/cats/{cat}')).toEqual(['App\\Http\\Controllers\\CatController@show']);
  });
});

// M1-05-R2: EXPECTED is the output of Laravel's own router (laravel/framework 12.70.2 installed
// fresh with composer into a scratch directory) for the synthetic route file below, loaded inside
// an `api` prefix + middleware group: method, URI, name, action, middleware, domain and the
// non-null binding fields. As in M1-05-R1, Laravel's single `PUT|PATCH` update route is listed
// as MapX's two routes.
describe('M1-05-R2: singletons, scoped(), middlewareFor() and route-level prefix/domain keys match Laravel', () => {
  let root: string;
  let routes: (RouteView & { domain?: string; metadata?: { bindingFields?: Record<string, string>; confidence?: string } })[];
  const EXPECTED = [
    'GET /api/profile profile.show ProfileController@show [api] -',
    'GET /api/profile/edit profile.edit ProfileController@edit [api] -',
    'PUT /api/profile profile.update ProfileController@update [api] -',
    'PATCH /api/profile profile.update ProfileController@update [api] -',
    'GET /api/photos/{photo}/thumbnail photos.thumbnail.show ThumbnailController@show [api] -',
    'PUT /api/photos/{photo}/thumbnail photos.thumbnail.update ThumbnailController@update [api] -',
    'PATCH /api/photos/{photo}/thumbnail photos.thumbnail.update ThumbnailController@update [api] -',
    'GET /api/photos/{photo}/thumbnail/create photos.thumbnail.create ThumbnailController@create [api] -',
    'POST /api/photos/{photo}/thumbnail photos.thumbnail.store ThumbnailController@store [api] -',
    'DELETE /api/photos/{photo}/thumbnail photos.thumbnail.destroy ThumbnailController@destroy [api] -',
    'GET /api/admin/settings settings.view SettingsController@show [api,auth] -',
    'PUT /api/admin/settings settings.update SettingsController@update [api,auth] -',
    'PATCH /api/admin/settings settings.update SettingsController@update [api,auth] -',
    'GET /api/avatar avatar.show UserController@show [api] -',
    'PUT /api/avatar avatar.update UserController@update [api] -',
    'PATCH /api/avatar avatar.update UserController@update [api] -',
    'DELETE /api/avatar avatar.destroy UserController@destroy [api] -',
    'GET /api/teams/{squad}/logo teams.logo.show LogoController@show [api] -',
    'PUT /api/teams/{squad}/logo teams.logo.update LogoController@update [api] -',
    'PATCH /api/teams/{squad}/logo teams.logo.update LogoController@update [api] -',
    'POST /api/teams/{squad}/logo teams.logo.store LogoController@store [api] -',
    'DELETE /api/teams/{squad}/logo teams.logo.destroy LogoController@destroy [api] -',
    'GET /api/account my.account.show AccountController@show [api,verified] -',
    'GET /api/account/edit my.account.edit AccountController@edit [api] -',
    'GET /api/cart cart.show CartController@show [api] -',
    'GET /api/wallet wallet.show WalletController@show [api] -',
    'GET /api/plan plan.show PlanController@show [api] -',
    'PUT /api/plan plan.update PlanController@update [api] -',
    'PATCH /api/plan plan.update PlanController@update [api] -',
    'GET /api/posts/{post}/comments posts.comments.index CommentController@index [api] -',
    'GET /api/posts/{post}/comments/{comment} posts.comments.show CommentController@show [api] - {"comment":"slug"}',
    'GET /api/users/{user}/notes users.notes.index NoteController@index [api] - {"user":"uuid"}',
    'GET /api/users/{user}/notes/{note} users.notes.show NoteController@show [api] - {"user":"uuid","note":"slug"}',
    'GET /api/orders orders.index OrderController@index [api,auth] -',
    'POST /api/orders orders.store OrderController@store [api,auth,verified,can:write] -',
    'GET /api/orders/{order} orders.show OrderController@show [api,auth,verified] -',
    'DELETE /api/orders/{order} orders.destroy OrderController@destroy [api,auth,verified,can:write] -',
    'GET /api/invoices invoices.index InvoiceController@index [api,cache,auth] -',
    'GET /api/invoices/{invoice} invoices.show InvoiceController@show [api,auth] -',
    'GET /api/carts carts.index CartItemController@index [api,throttle] -',
    'GET /api/carts/{cart} carts.show CartItemController@show [api,throttle,auth] -',
    'GET /api/refunds refunds.index RefundController@index [api] -',
    'GET /api/refunds/{refund} refunds.show RefundController@show [api,audit] -',
    'GET /v9/api/ping - PingController@show [api] -',
    'GET /outer/api/inner/pong pong PingController@pong [api] -',
    'GET /lead/api/inner/chained - PingController@chained [api] -',
    'GET /kept/api/inner/both - PingController@both [api] -',
    'GET /tail/api/inner/after - PingController@after [api] -',
    'GET /api/tenant - TenantController@show [api] {account}.example.com',
    'GET /api/dash - DashController@index [api] ops.example.com',
    'GET /api/home - DashController@home [api] admin.example.com',
    'GET /p/api/closure - Closure [api,auth] x.test',
  ];
  const line = (r: (typeof routes)[number]) => {
    const fields = r.metadata?.bindingFields;
    return `${r.method} ${r.path} ${r.name ?? '-'} ${r.handlerSymbol?.split('\\').pop() ?? 'Closure'} [${r.middlewares.join(',')}] ${r.domain ?? '-'}` +
      (fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '');
  };

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/api.php': [
        '<?php',
        'use App\\Http\\Controllers\\UserController;',
        'use Illuminate\\Support\\Facades\\Route;',
        '',
        // Singletons: defaults, creatable/destroyable, nesting, prefixes, options and plural forms.
        "Route::singleton('profile', 'ProfileController');",
        "Route::singleton('photos.thumbnail', 'ThumbnailController')->creatable()->except('edit');",
        "Route::singleton('admin/settings', 'SettingsController', ['only' => ['show', 'update'], 'names' => ['show' => 'settings.view'], 'middleware' => 'auth']);",
        "Route::apiSingleton('avatar', UserController::class)->destroyable();",
        "Route::apiSingleton('teams.logo', 'LogoController')->creatable()->parameters(['teams' => 'squad']);",
        "Route::name('my')->singleton('account', 'AccountController')->only(['show', 'edit'])->middlewareFor('show', 'verified');",
        "Route::singletons(['cart' => 'CartController', 'wallet' => 'WalletController'], ['only' => ['show']]);",
        "Route::apiSingletons(['plan' => 'PlanController']);",
        // scoped(): URIs keep plain wildcards, binding fields go to the routes that carry them.
        "Route::resource('posts.comments', 'CommentController')->scoped(['comment' => 'slug'])->only(['index', 'show']);",
        "Route::apiResource('users.notes', 'NoteController')->scoped(['user' => 'uuid', 'note' => 'slug'])->only(['index', 'show']);",
        // middlewareFor(): per-action middleware, merged with middleware() in either order.
        "Route::resource('orders', 'OrderController')->middleware('auth')->middlewareFor('show', 'verified')->middlewareFor(['store', 'destroy'], ['verified', 'can:write'])->only(['index', 'store', 'show', 'destroy']);",
        "Route::apiResource('invoices', 'InvoiceController')->middlewareFor('index', 'cache')->middleware('auth')->only(['index', 'show']);",
        "Route::middleware('throttle')->resource('carts', 'CartItemController')->middlewareFor('show', ['auth', 'throttle'])->only(['index', 'show']);",
        "Route::resource('refunds', 'RefundController', ['middleware_for' => ['show' => 'audit']])->only(['index', 'show']);",
        // Route-level prefix (action array key or chained) goes before the group prefix; domain keys win.
        "Route::get('ping', ['prefix' => 'v9', 'uses' => 'PingController@show']);",
        "Route::group(['prefix' => 'inner'], function () {",
        "    Route::get('pong', ['prefix' => 'outer', 'as' => 'pong', 'uses' => 'PingController@pong']);",
        "    Route::prefix('lead')->get('chained', 'PingController@chained');",
        "    Route::prefix('lost')->get('both', ['prefix' => 'kept', 'uses' => 'PingController@both']);",
        "    Route::get('after', 'PingController@after')->prefix('tail');",
        '});',
        "Route::get('tenant', ['domain' => '{account}.example.com', 'uses' => 'TenantController@show']);",
        "Route::domain('admin.example.com')->group(function () {",
        "    Route::get('dash', ['domain' => 'ops.example.com', 'uses' => 'DashController@index']);",
        "    Route::get('home', 'DashController@home');",
        '});',
        "Route::get('closure', ['prefix' => 'p', 'domain' => 'x.test', 'middleware' => 'auth', function () { return 1; }]);",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  it("reports exactly Laravel's route list: URIs, names, handlers, middleware, domains and binding fields", () => {
    expect(routes.map(line).sort()).toEqual([...EXPECTED].sort());
  });

  it('resolves singleton controllers to fully-qualified classes and marks them declared', () => {
    const avatar = routes.filter((r) => r.path === '/api/avatar');
    expect(avatar.map((r) => r.handlerSymbol).sort()).toEqual([
      'App\\Http\\Controllers\\UserController@destroy',
      'App\\Http\\Controllers\\UserController@show',
      'App\\Http\\Controllers\\UserController@update',
      'App\\Http\\Controllers\\UserController@update',
    ]);
    expect(avatar.map((r) => r.metadata?.confidence)).toEqual(['declared', 'declared', 'declared', 'declared']);
  });
});

// Review 2026-10-31: the M1-08 test seeded frameworks.json and used artisan, so detection from
// composer.json alone was never exercised.
describe('M1-08: a nested Laravel app found from composer.json alone', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'backend/composer.json': JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^12.0' } }),
      'backend/routes/api.php': "<?php\nRoute::get('health', 'HealthController@show');\n",
      'backend/routes/orphan.php': "<?php\nRoute::get('orphan', 'OrphanController@show');\n",
      'docs/readme.md': '# parent folder\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('detects Laravel and builds the app mount graph without a seeded frameworks.json', () => {
    const routes: RouteView[] = JSON.parse(mapx(root, 'routes', root, '--json'));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.reachable}`).sort()).toEqual(['GET /api/health true', 'GET /orphan false']);
  });
});

describe('M1-08: nested Laravel roots and frameworks.json', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'backend/artisan': '#!/usr/bin/env php\n<?php\n',
      'backend/routes/api.php': "<?php\nRoute::get('health', 'HealthController@show');\n",
      'admin/artisan': '#!/usr/bin/env php\n<?php\n',
      'admin/routes/api.php': "<?php\nRoute::get('health', 'HealthController@show');\n",
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

  // Review 2026-10-31 (post-acceptance defect): last-registration-wins ignored the app root.
  it('never marks a route overridden by the same route of another Laravel app', () => {
    const routes: RouteView[] = JSON.parse(mapx(root, 'routes', root, '--json'));
    const health = routes.filter((r) => r.path === '/api/health');
    expect(health).toHaveLength(2);
    expect(health.map((r) => r.overridden)).toEqual([false, false]);
  });

  it('keeps frameworks listed in frameworks.json', () => {
    const file = join(root, '.mapx', 'frameworks.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(expect.arrayContaining(['laravel', 'express']));
  });
});
