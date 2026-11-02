import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskPhp, opensConditionalBlock, phpString, resourceParam, stringAssignments, varsAt } from '../src/frameworks/detectors/laravel-mounts.js';
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

  // Review 2026-10-31 (M1-07-R2): "admin/{$this->version}" stayed raw in RouteServiceProvider prefixes.
  it('M1-07-R2: reads $this->prop from class properties, apart from locals of the same name', () => {
    const src = [
      'class P {',
      '    public function boot() { $version = \'local\'; $routes = base_path(\'routes/x.php\'); }',
      "    protected string $version = 'v3';",
      "    public static $shared = 'static';",
      '}',
    ].join('\n');
    const { code, text } = maskPhp(src);
    const assignments = stringAssignments(text, code, { dir: 'app/Providers', root: 'app' });
    // (Scope barriers, `keep`, are the function bodies: M1-03-R2.)
    expect(assignments.filter((a) => !a.keep).map((a) => `${a.name}=${a.value}@${a.index < 0 ? 'class' : 'local'}`)).toEqual([
      'this->version=v3@class', 'version=local@local', 'routes=app/routes/x.php@local',
    ]);
    // Inside boot(): its locals and the class properties; after the method, only the properties.
    const scope = { dir: '', root: '', vars: varsAt(assignments, src.indexOf('}', src.indexOf('$routes'))) };
    expect(phpString('$version', { dir: '', root: '', vars: varsAt(assignments, src.length) })).toBeNull();
    expect(phpString('"admin/{$this->version}"', scope)).toBe('admin/v3');
    expect(phpString('"admin/$this->version/x"', scope)).toBe('admin/v3/x');
    expect(phpString("'admin/'.$this->version", scope)).toBe('admin/v3');
    expect(phpString('$version', scope)).toBe('local');
    expect(phpString('"{$this->missing}/x"', scope)).toBeNull();
    expect(phpString('"{$this->missing}/x"', scope, '{dynamic}')).toBe('{dynamic}/x');
    expect(phpString("config('app.api_prefix')", scope, '{dynamic}')).toBe('{dynamic}');
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
        // Route::any URIs are evaluated like every other verb's (review 2026-10-31).
        "Route::any(\"a/$unknownVar\", 'DynController@a');",
        "Route::any('b/' . SOME_CONST, 'DynController@b');",
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
      'DynController@a /api/a/{dynamic} true',
      'DynController@b /api/b/{dynamic} true',
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

// Review 2026-10-31 (P1, reviewer D): the RouteServiceProvider was read by a parser that only knew
// Route::…->group(<path>), so its glob loops, require, loadRoutesFrom and ->group($var) mounts left
// their routes unreachable (and out of HTTP pairing), its prefixes were taken raw, and its ->name()
// and ->domain() were dropped.
describe('M1-07-R2: RouteServiceProvider mounts are walked like other providers', () => {
  type View = RouteView & { reachability?: string; domain?: string; metadata?: Record<string, any> };
  const RSP = 'app/Providers/RouteServiceProvider.php';
  const provider = (body: string[], props: string[] = []) => [
    '<?php',
    'namespace App\\Providers;',
    'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
    'use Illuminate\\Support\\Facades\\Route;',
    'class RouteServiceProvider extends ServiceProvider',
    '{',
    "    protected $version = 'v3';",
    ...props,
    '    public function boot(): void',
    '    {',
    ...body,
    '    }',
    '}',
  ];
  const lineOf = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
  const line = (r: View) =>
    `${r.method} ${r.path} ${r.handlerSymbol?.split('\\').pop()} name=${r.name ?? '-'} domain=${r.domain ?? '-'} [${r.middlewares.join(',')}] ${r.reachability}${r.dynamic ? ' dynamic' : ''}`;

  describe('evaluable mounts and attributes', () => {
    let root: string;
    let routes: View[];
    const rsp = provider([
      '        $this->routes(function () {',
      "            Route::prefix(config('app.api_prefix'))->middleware('api')->name('api.')->group(base_path('routes/api.php'));",
      "            Route::prefix(\"admin/{$this->version}\")->domain('admin.example.com')->middleware('web')->namespace($this->adminNamespace)->group(base_path('routes/admin.php'));",
      "            foreach (glob(base_path('routes/modules/*.php')) as $file) {",
      "                Route::middleware('web')->prefix('modules')->group($file);",
      '            }',
      "            foreach (glob(base_path('routes/plain/*.php')) as $file) require $file;",
      "            require base_path('routes/required.php');",
      "            $version = 'local';",
      "            $shop = base_path('routes/shop.php');",
      '            Route::prefix("shop/$this->version")->group($shop);',
      '        });',
      "        $this->loadRoutesFrom(base_path('routes/loaded.php'));",
    ], ["    protected $namespace = 'App\\Web\\Controllers';", "    protected $adminNamespace = 'App\\Admin\\Controllers';"]);
    beforeAll(() => {
      root = workspace({
        artisan: '#!/usr/bin/env php\n<?php\n',
        [RSP]: rsp.join('\n'),
        'routes/api.php': "<?php\nRoute::get('users', 'UserController@index')->name('users');\n",
        'routes/admin.php': "<?php\nRoute::get('panel', 'AdminController@panel')->name('panel');\n",
        'routes/modules/blog.php': "<?php\nRoute::get('blog', 'BlogController@index');\n",
        'routes/modules/news.php': "<?php\nRoute::get('news', 'NewsController@index');\n",
        'routes/plain/notes.php': "<?php\nRoute::get('notes', 'NoteController@index');\n",
        'routes/required.php': "<?php\nRoute::get('required', 'ReqController@index');\n",
        'routes/shop.php': "<?php\nRoute::get('cart', 'ShopController@cart');\n",
        'routes/loaded.php': "<?php\nRoute::get('loaded', 'LoadedController@index');\n",
        'routes/orphan.php': "<?php\nRoute::get('orphan', 'OrphanController@index');\n",
        'resources/js/client.js': "import axios from 'axios';\nexport const cart = () => axios.get('/shop/v3/cart');\nexport const loaded = () => axios.get('/loaded');\n",
      });
      init(root);
      mapx(root, 'scan', root);
      routes = JSON.parse(mapx(root, 'routes', root, '--json'));
    }, 90000);
    afterAll(() => cleanup(root));

    it('makes routes of glob, require, loadRoutesFrom and ->group($var) mounts reachable, mounted by the provider line', () => {
      const mounted = (path: string) => routes.find((r) => r.path === path)?.metadata?.mountedBy;
      expect(mounted('/modules/blog')).toBe(`${RSP}:${lineOf(rsp, "->prefix('modules')")}`);
      expect(mounted('/modules/news')).toBe(`${RSP}:${lineOf(rsp, "->prefix('modules')")}`);
      expect(mounted('/notes')).toBe(`${RSP}:${lineOf(rsp, 'routes/plain/')}`);
      expect(mounted('/required')).toBe(`${RSP}:${lineOf(rsp, 'routes/required.php')}`);
      expect(mounted('/shop/v3/cart')).toBe(`${RSP}:${lineOf(rsp, '->group($shop)')}`);
      expect(mounted('/loaded')).toBe(`${RSP}:${lineOf(rsp, 'loadRoutesFrom')}`);
      // The provider mounts everything else, so a file nothing loads is still proven unreachable.
      expect(routes.map(line).sort()).toEqual([
        'GET /admin/v3/panel AdminController@panel name=panel domain=admin.example.com [web] reachable',
        'GET /loaded LoadedController@index name=- domain=- [] reachable',
        'GET /modules/blog BlogController@index name=- domain=- [web] reachable',
        'GET /modules/news NewsController@index name=- domain=- [web] reachable',
        'GET /notes NoteController@index name=- domain=- [] reachable',
        'GET /orphan OrphanController@index name=- domain=- [] unreachable',
        'GET /required ReqController@index name=- domain=- [] reachable',
        'GET /shop/v3/cart ShopController@cart name=- domain=- [] reachable',
        'GET /{dynamic}/users UserController@index name=api.users domain=- [api] reachable dynamic',
      ]);
    });

    it('evaluates prefixes: config() is {dynamic}, $this->version is the property, and no URI holds PHP text', () => {
      for (const r of routes) expect(r.path, r.path).not.toMatch(/[()'"$]|->/);
      expect(routes.find((r) => r.path === '/{dynamic}/users')).toMatchObject({ dynamic: true });
      expect(routes.filter((r) => r.path.includes('local'))).toEqual([]);
    });

    it("namespaces handlers with the provider's $namespace, or the mount's evaluated ->namespace()", () => {
      const handler = (path: string) => routes.find((r) => r.path === path)?.handlerSymbol;
      expect(handler('/{dynamic}/users')).toBe('App\\Web\\Controllers\\UserController@index');
      expect(handler('/admin/v3/panel')).toBe('App\\Admin\\Controllers\\AdminController@panel');
    });

    it('pairs HTTP calls with routes the provider mounts', () => {
      const http = query<{ source_file: string; target_symbol: string }>(root, "SELECT source_file, target_symbol FROM edges WHERE edge_type = 'http'");
      const targets = http.map((e) => `${e.source_file} ${e.target_symbol?.split('\\').pop()}`);
      expect(targets).toContain('resources/js/client.js ShopController@cart');
      expect(targets).toContain('resources/js/client.js LoadedController@index');
    });
  });

  describe('mounts that cannot be evaluated', () => {
    let root: string;
    let routes: View[];
    const rsp = provider([
      '        $this->routes(function () {',
      "            Route::middleware('web')->group(base_path('routes/web.php'));",
      "            Route::middleware('api')->group($this->app->make('plugins')->routeFile());",
      "            foreach (glob(config('routes.glob')) as $file) require $file;",
      '        });',
    ]);
    beforeAll(() => {
      root = workspace({
        artisan: '#!/usr/bin/env php\n<?php\n',
        [RSP]: rsp.join('\n'),
        'routes/web.php': "<?php\nRoute::get('home', 'HomeController@index');\n",
        'routes/plugin.php': "<?php\nRoute::get('plugin', 'PluginController@index');\n",
        'resources/js/client.js': "import axios from 'axios';\nexport const plugin = () => axios.get('/plugin');\n",
      });
      init(root);
      mapx(root, 'scan', root);
      routes = JSON.parse(mapx(root, 'routes', root, '--json'));
    }, 90000);
    afterAll(() => cleanup(root));

    it('records them unresolved, so routes nothing visibly mounts are unknown, not unreachable, and still pair', () => {
      expect(routes.map(line).sort()).toEqual([
        'GET /home HomeController@index name=- domain=- [web] reachable',
        'GET /plugin PluginController@index name=- domain=- [] unknown',
      ]);
      const plugin = routes.find((r) => r.path === '/plugin')!;
      expect(plugin.reachable).toBe(true);
      expect(plugin.metadata?.unresolvedMounts).toEqual([
        `${RSP}:${lineOf(rsp, 'routeFile()')}`,
        `${RSP}:${lineOf(rsp, 'routes.glob')}`,
      ]);
      const http = query<{ target_symbol: string }>(root, "SELECT target_symbol FROM edges WHERE edge_type = 'http'");
      expect(http.map((e) => e.target_symbol?.split('\\').pop())).toContain('PluginController@index');
    });
  });

  describe('a provider whose only mount cannot be evaluated', () => {
    let root: string;
    beforeAll(() => {
      root = workspace({
        artisan: '#!/usr/bin/env php\n<?php\n',
        [RSP]: provider(["        Route::middleware('api')->prefix('api')->group($this->apiRoutes());"]).join('\n'),
        'routes/api.php': "<?php\nRoute::get('ping', 'PingController@index');\n",
      });
      init(root);
      mapx(root, 'scan', root);
    }, 90000);
    afterAll(() => cleanup(root));

    it('does not fall back to the default mounts: routes/api.php is unknown, not reachable', () => {
      const routes: View[] = JSON.parse(mapx(root, 'routes', root, '--json'));
      expect(routes.map(line)).toEqual(['GET /api/ping PingController@index name=- domain=- [api] unknown']);
    });
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

// M0-04-R3: middleware named by class constant. The route walker kept only quoted names, so
// `->middleware(EnsureAdmin::class)` gave the route no middleware and the route file no edge.
describe('M0-04-R3: ->middleware(X::class) through the route file use table', () => {
  let root: string;
  const mw = (name: string) => `<?php\nnamespace App\\Http\\Middleware;\nclass ${name} { public function handle($request, $next) { return $next($request); } }\n`;
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Http/Kernel.php': [
        '<?php',
        'namespace App\\Http;',
        'class Kernel {',
        '    protected $middlewareAliases = [',
        "        'verified' => \\Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified::class,",
        '    ];',
        '}',
      ].join('\n'),
      'app/Http/Middleware/EnsureAdmin.php': mw('EnsureAdmin'),
      'app/Http/Middleware/EnsureTeam.php': mw('EnsureTeam'),
      'app/Http/Middleware/Audit.php': mw('Audit'),
      'app/Http/Middleware/Unimported.php': mw('Unimported'),
      'app/Http/Controllers/HomeController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass HomeController { public function admin() {} public function team() {} public function audit() {} public function loose() {} public function verify() {} }\n',
      'routes/web.php': [
        '<?php',
        'use App\\Http\\Controllers\\HomeController;',
        'use App\\Http\\Middleware\\EnsureAdmin;',
        'use App\\Http\\Middleware\\EnsureTeam;',
        'use App\\Http\\Middleware as Mw;',
        'use Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified;',
        'use Illuminate\\Support\\Facades\\Route;',
        "Route::get('/admin', [HomeController::class, 'admin'])->middleware(EnsureAdmin::class);",
        "Route::middleware([EnsureTeam::class, 'auth'])->group(function () {",
        "    Route::get('/team', [HomeController::class, 'team']);",
        '});',
        "Route::get('/audit', [HomeController::class, 'audit'])->middleware([Mw\\Audit::class]);",
        // Not imported: the global \\Unimported, which no file declares.
        "Route::get('/loose', [HomeController::class, 'loose'])->middleware(Unimported::class);",
        // Vendor middleware: not indexed.
        "Route::get('/verify', [HomeController::class, 'verify'])->middleware(EnsureEmailIsVerified::class);",
        // The same vendor class through its Kernel alias: the Kernel registers it but cannot resolve it.
        "Route::get('/verified', [HomeController::class, 'verify'])->middleware('verified');",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('gives each route its middleware classes by FQN', () => {
    const routes: RouteView[] = JSON.parse(mapx(root, 'routes', root, '--json'));
    const of = (path: string) => routes.find((r) => r.path === path)?.middlewares.filter((m) => m !== 'web');
    expect(of('/admin')).toEqual(['App\\Http\\Middleware\\EnsureAdmin']);
    expect(of('/team')).toEqual(['App\\Http\\Middleware\\EnsureTeam', 'auth']);
    expect(of('/audit')).toEqual(['App\\Http\\Middleware\\Audit']);
    expect(of('/loose')).toEqual(['\\Unimported']);
    expect(of('/verify')).toEqual(['Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified']);
  });

  it('links the route file to each indexed middleware class, and to nothing else', () => {
    const edges = query<{ target_file: string; target_symbol: string; metadata: string }>(root,
      "SELECT target_file, target_symbol, metadata FROM edges WHERE source_file = 'routes/web.php' AND edge_type = 'middleware' ORDER BY target_file")
      .map((e) => `${e.target_file} ${e.target_symbol} ${JSON.parse(e.metadata).routes.join(',')}`);
    expect(edges).toEqual([
      'app/Http/Middleware/Audit.php App\\Http\\Middleware\\Audit GET /audit',
      'app/Http/Middleware/EnsureAdmin.php App\\Http\\Middleware\\EnsureAdmin GET /admin',
      'app/Http/Middleware/EnsureTeam.php App\\Http\\Middleware\\EnsureTeam GET /team',
    ]);
  });
});

// M0-04-R6 (review 2026-10-31): `X::class.':param'` kept its raw text (a bogus `:admin` entry in an
// array) and the scanner resolved the part before ':' by short class name, so an unimported class
// or a plain string such as 'Thing' linked to whatever class bore that name. Laravel's
// MiddlewareNameResolver gives `App\…\EnsureRole:editor`: the class, then its parameters.
describe('M0-04-R6: middleware parameters, no short-name guessing, variadic and group use', () => {
  let root: string;
  const mw = (ns: string, name: string) => `<?php\nnamespace ${ns};\nclass ${name} { public function handle($request, $next) { return $next($request); } }\n`;
  const actions = ['editor', 'admin', 'owner', 'staff', 'roled', 'loose', 'thing', 'both', 'grouped', 'audit'];
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Http/Kernel.php': [
        '<?php',
        'namespace App\\Http;',
        'use App\\Http\\Middleware\\EnsureRole;',
        'class Kernel {',
        '    protected $middlewareAliases = [',
        // An imported class constant in the Kernel is named through the Kernel's use table.
        "        'role' => EnsureRole::class,",
        '    ];',
        '}',
      ].join('\n'),
      'app/Http/Middleware/EnsureRole.php': mw('App\\Http\\Middleware', 'EnsureRole'),
      'app/Http/Middleware/Unimported.php': mw('App\\Http\\Middleware', 'Unimported'),
      'app/Http/Middleware/Grouped.php': mw('App\\Http\\Middleware', 'Grouped'),
      'app/Http/Middleware/Audit.php': mw('App\\Http\\Middleware', 'Audit'),
      'app/Other/Thing.php': mw('App\\Other', 'Thing'),
      'app/Http/Controllers/HomeController.php': `<?php\nnamespace App\\Http\\Controllers;\nclass HomeController { ${actions.map((a) => `public function ${a}() {}`).join(' ')} }\n`,
      'routes/web.php': [
        '<?php',
        'use App\\Http\\Controllers\\HomeController;',
        'use App\\Http\\Middleware\\EnsureRole;',
        'use App\\Http\\Middleware\\{Grouped as U2, Audit};',
        'use Illuminate\\Support\\Facades\\Route;',
        "Route::get('/editor', [HomeController::class, 'editor'])->middleware(EnsureRole::class.':editor');",
        "Route::get('/admin', [HomeController::class, 'admin'])->middleware([EnsureRole::class . ':admin', 'auth']);",
        "Route::middleware(EnsureRole::class.\":owner\")->group(function () {",
        "    Route::get('/owner', [HomeController::class, 'owner']);",
        '});',
        "Route::group(['middleware' => EnsureRole::class.':staff'], function () {",
        "    Route::get('/staff', [HomeController::class, 'staff']);",
        '});',
        // A Kernel alias with parameters: the alias's class, then the parameters.
        "Route::get('/roled', [HomeController::class, 'roled'])->middleware('role:manager');",
        // Not imported, in a file without namespace: PHP's \\Unimported, which no file declares.
        "Route::get('/loose', [HomeController::class, 'loose'])->middleware(Unimported::class.':admin');",
        // Neither a Kernel alias nor a group: Laravel loads the global class Thing, which no file declares.
        "Route::get('/thing', [HomeController::class, 'thing'])->middleware('Thing');",
        // Route::middleware(...$middleware): every argument is a middleware.
        "Route::get('/both', [HomeController::class, 'both'])->middleware('auth', 'verified');",
        "Route::get('/grouped', [HomeController::class, 'grouped'])->middleware(U2::class);",
        "Route::get('/audit', [HomeController::class, 'audit'])->middleware(Audit::class);",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('names each middleware class with its parameters, and keeps every variadic argument', () => {
    const routes: RouteView[] = JSON.parse(mapx(root, 'routes', root, '--json'));
    expect(Object.fromEntries(actions.map((a) => [a, routes.find((r) => r.path === `/${a}`)?.middlewares.filter((m) => m !== 'web')]))).toEqual({
      editor: ['App\\Http\\Middleware\\EnsureRole:editor'],
      admin: ['App\\Http\\Middleware\\EnsureRole:admin', 'auth'],
      owner: ['App\\Http\\Middleware\\EnsureRole:owner'],
      staff: ['App\\Http\\Middleware\\EnsureRole:staff'],
      roled: ['App\\Http\\Middleware\\EnsureRole:manager'],
      loose: ['\\Unimported:admin'],
      thing: ['Thing'],
      both: ['auth', 'verified'],
      grouped: ['App\\Http\\Middleware\\Grouped'],
      audit: ['App\\Http\\Middleware\\Audit'],
    });
  });

  it('links the route file to each named middleware class, never by short class name', () => {
    const edges = query<{ target_file: string; target_symbol: string; metadata: string }>(root,
      "SELECT target_file, target_symbol, metadata FROM edges WHERE source_file = 'routes/web.php' AND edge_type = 'middleware' ORDER BY target_file")
      .map((e) => `${e.target_file} ${e.target_symbol} ${JSON.parse(e.metadata).routes.join(',')}`);
    expect(edges).toEqual([
      'app/Http/Middleware/Audit.php App\\Http\\Middleware\\Audit GET /audit',
      'app/Http/Middleware/EnsureRole.php App\\Http\\Middleware\\EnsureRole GET /editor,GET /admin,GET /owner,GET /staff,GET /roled',
      'app/Http/Middleware/Grouped.php App\\Http\\Middleware\\Grouped GET /grouped',
    ]);
  });
});

// M1-05-R3: excluded middleware, implicit binding fields in plain URIs and repeated RouteRegistrar
// attributes. EXPECTED is frozen output of laravel/framework v12.70.2 for this exact route file,
// mounted like the default routes/api.php (prefix api, middleware api, App\\Http\\Controllers). Its
// middleware is what Router::gatherRouteMiddleware keeps: Route::middleware() minus excludedMiddleware().
describe('M1-05-R3: withoutMiddleware, {param:field} URIs and repeated chained attributes match Laravel', () => {
  let root: string;
  let routes: (RouteView & { domain?: string; metadata?: { bindingFields?: Record<string, string> } })[];
  const EXPECTED = [
    'GET /api/open - OpenController@show [api,throttle] -',
    'GET /api/limited - OpenController@limited [api,auth,throttle:60,1] -',
    'GET /api/bare - OpenController@bare [] -',
    'GET /api/lean - OpenController@lean [api,etag] -',
    'GET /api/calm - OpenController@calm [api,auth] -',
    'GET /api/notes notes.index NoteController@index [api,auth] -',
    'GET /api/calmer - OpenController@calmer [api,log] -',
    'GET /api/panel - PanelController@index [api,App\\Http\\Middleware\\Audit,auth] -',
    'GET /api/trail - PanelController@trail [api,App\\Http\\Middleware\\EnsureAdmin,auth] -',
    'GET /api/legacy - OpenController@legacy [api,auth] -',
    'GET /api/photos photos.index PhotoController@index [api,auth] -',
    'GET /api/photos/{photo} photos.show PhotoController@show [api,auth] -',
    'GET /api/videos videos.index VideoController@index [api,verified] -',
    'GET /api/videos/{video} videos.show VideoController@show [api,verified] -',
    'GET /api/clips clips.index ClipController@index [api,auth] -',
    'GET /api/clips/{clip} clips.show ClipController@show [api] -',
    'GET /api/tags tags.index TagController@index [] -',
    'GET /api/settings settings.show SettingsController@show [api] -',
    'GET /api/settings/edit settings.edit SettingsController@edit [api,auth] -',
    'GET /api/twice - RepeatController@twice [api,second] -',
    'GET /api/after - RepeatController@after [api,first,second,third] -',
    'GET /api/override - RepeatController@override [api,action,later] -',
    'GET /api/grouped - RepeatController@grouped [api,inner] -',
    'GET /api/pens pens.index PenController@index [api,second] -',
    'GET /api/two/nested - RepeatController@nested [api] -',
    'GET /api/roster - RosterController@index [api] -',
    'GET /api/named b.route RepeatController@named [api] -',
    'GET /api/posts/{post} - PostController@show [api] - {"post":"slug"}',
    'GET /api/users/{user}/posts/{post?} - PostController@byUser [api] - {"post":"slug"}',
    'GET /api/files/{file} - FileController@handle [api] - {"file":"hash"}',
    'POST /api/files/{file} - FileController@handle [api] - {"file":"hash"}',
    'GET /api/teams/{team}/members/{member} - MemberController@show [api] - {"team":"uuid","member":"email"}',
    'GET /api/teams/{team}/items/{item} items.show ItemController@show [api] - {"team":"uuid"}',
    'GET /api/teams/{team}/boards/{board} boards.show BoardController@show [api] - {"board":"code"}',
    'GET /v2/api/tags/{tag} - TagController@byName [api] -',
  ];
  const line = (r: (typeof routes)[number]) => {
    const fields = r.metadata?.bindingFields;
    return `${r.method} ${r.path} ${r.name ?? '-'} ${r.handlerSymbol?.split('\\').pop() ?? 'Closure'} [${r.middlewares.join(',')}] ${r.domain ?? '-'}` +
      (fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '');
  };
  const mw = (name: string) => `<?php\nnamespace App\\Http\\Middleware;\nclass ${name} { public function handle($request, $next) { return $next($request); } }\n`;

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Http/Middleware/EnsureAdmin.php': mw('EnsureAdmin'),
      'app/Http/Middleware/Audit.php': mw('Audit'),
      'routes/api.php': [
        '<?php',
        'use App\\Http\\Middleware\\EnsureAdmin;',
        'use App\\Http\\Middleware as Mw;',
        'use Illuminate\\Support\\Facades\\Route;',
        '',
        '// withoutMiddleware on a route, before and after the verb, on groups and with class constants.',
        "Route::middleware(['auth', 'throttle'])->group(function () {",
        "    Route::get('open', 'OpenController@show')->withoutMiddleware('auth');",
        "    Route::get('limited', 'OpenController@limited')->middleware('throttle:60,1')->withoutMiddleware('throttle');",
        '});',
        "Route::withoutMiddleware('api')->get('bare', 'OpenController@bare');",
        "Route::withoutMiddleware('log')->withoutMiddleware('cache')->get('lean', 'OpenController@lean')->middleware(['log', 'cache', 'etag']);",
        "Route::withoutMiddleware(['throttle'])->group(function () {",
        "    Route::get('calm', 'OpenController@calm')->middleware(['throttle', 'auth']);",
        "    Route::resource('notes', 'NoteController')->middleware(['throttle', 'auth'])->only(['index']);",
        "    Route::group(['excluded_middleware' => ['auth']], function () {",
        "        Route::get('calmer', 'OpenController@calmer')->middleware(['throttle', 'auth', 'log']);",
        '    });',
        '});',
        "Route::middleware([EnsureAdmin::class, Mw\\Audit::class, 'auth'])->group(function () {",
        "    Route::get('panel', 'PanelController@index')->withoutMiddleware(EnsureAdmin::class);",
        "    Route::get('trail', 'PanelController@trail')->withoutMiddleware([Mw\\Audit::class]);",
        '});',
        "Route::get('legacy', ['middleware' => ['auth', 'log'], 'excluded_middleware' => ['log'], 'uses' => 'OpenController@legacy']);",
        '',
        '// Resources: withoutMiddleware, withoutMiddlewareFor, the options keys and a chained attribute.',
        "Route::resource('photos', 'PhotoController')->middleware(['auth', 'log'])->withoutMiddleware('log')->only(['index', 'show']);",
        "Route::apiResource('videos', 'VideoController')->middleware(['auth', 'verified'])->withoutMiddlewareFor('index', 'verified')->withoutMiddlewareFor(['show', 'index'], ['auth'])->only(['index', 'show']);",
        "Route::resource('clips', 'ClipController', ['middleware' => ['auth', 'log'], 'excluded_middleware' => ['log'], 'excluded_middleware_for' => ['show' => ['auth']]])->only(['index', 'show']);",
        "Route::withoutMiddleware('api')->resource('tags', 'TagController')->withoutMiddleware('auth')->middleware('auth')->only(['index']);",
        "Route::singleton('settings', 'SettingsController')->middleware('auth')->withoutMiddlewareFor('show', 'auth')->only(['show', 'edit']);",
        '',
        '// Repeated chained attributes: a RouteRegistrar attribute is replaced, Route::middleware() appends.',
        "Route::middleware('first')->middleware('second')->get('twice', 'RepeatController@twice');",
        "Route::middleware('first')->get('after', 'RepeatController@after')->middleware('second')->middleware('third');",
        "Route::middleware('first')->get('override', ['middleware' => 'action', 'uses' => 'RepeatController@override'])->middleware('later');",
        "Route::middleware('outer')->middleware('inner')->group(function () {",
        "    Route::get('grouped', 'RepeatController@grouped');",
        '});',
        "Route::middleware('first')->middleware('second')->resource('pens', 'PenController')->only(['index']);",
        "Route::prefix('one')->prefix('two')->group(function () {",
        "    Route::get('nested', 'RepeatController@nested');",
        '});',
        "Route::namespace('Admin')->namespace('Staff')->group(function () {",
        "    Route::get('roster', 'RosterController@index');",
        '});',
        "Route::name('a.')->name('b.')->group(function () {",
        "    Route::get('named', 'RepeatController@named')->name('route');",
        '});',
        '',
        '// Implicit binding fields in plain route URIs and group prefixes.',
        "Route::get('posts/{post:slug}', 'PostController@show');",
        "Route::get('users/{user}/posts/{post:slug?}', 'PostController@byUser');",
        "Route::match(['get', 'post'], 'files/{file:hash}', 'FileController@handle');",
        "Route::prefix('teams/{team:uuid}')->group(function () {",
        "    Route::get('members/{member:email}', 'MemberController@show');",
        "    Route::resource('items', 'ItemController')->only(['show']);",
        "    Route::resource('boards', 'BoardController')->scoped(['board' => 'code'])->only(['show']);",
        '});',
        "Route::get('tags/{tag:name}', 'TagController@byName')->prefix('v2');",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  it("reports exactly Laravel's route list: excluded middleware removed, binding fields split from the URI", () => {
    // One line per method, like the oracle: Route::match() is one route with several methods.
    expect(routes.flatMap((r) => r.method.split('|').map((method) => line({ ...r, method }))).sort()).toEqual([...EXPECTED].sort());
  });

  it('links a middleware class only from the routes that keep it', () => {
    const edges = query<{ target_file: string; metadata: string }>(root,
      "SELECT target_file, metadata FROM edges WHERE source_file = 'routes/api.php' AND edge_type = 'middleware' ORDER BY target_file")
      .map((e) => `${e.target_file} ${JSON.parse(e.metadata).routes.join(',')}`);
    expect(edges).toEqual([
      'app/Http/Middleware/Audit.php GET /api/panel',
      'app/Http/Middleware/EnsureAdmin.php GET /api/trail',
    ]);
  });

  it('keeps the last chained namespace attribute for a group', () => {
    expect(routes.find((r) => r.path === '/api/roster')?.handlerSymbol).toBe('App\\Http\\Controllers\\Staff\\RosterController@index');
  });
});

// M1-05-R3: the same attribute rules for a RouteServiceProvider mount and a `->group(<path>)` mount.
// The expected list is laravel/framework v12.70.2 output for the provider's chain and these two files.
describe('M1-05-R3: repeated attributes and withoutMiddleware on provider and file mounts match Laravel', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Providers/RouteServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
        'use Illuminate\\Support\\Facades\\Route;',
        'class RouteServiceProvider extends ServiceProvider',
        '{',
        '    public function boot(): void',
        '    {',
        '        $this->routes(function () {',
        "            Route::middleware('web')->middleware(['extra', 'auth'])->prefix('lost')->prefix('portal')->withoutMiddleware('extra')->group(base_path('routes/portal.php'));",
        '        });',
        '    }',
        '}',
      ].join('\n'),
      'routes/portal.php': [
        '<?php',
        'use Illuminate\\Support\\Facades\\Route;',
        "Route::get('home', 'PortalController@home');",
        "Route::middleware('first')->middleware(['second', 'log'])->prefix('lost')->prefix('admin')->withoutMiddleware('auth')->group(__DIR__.'/portal-admin.php');",
      ].join('\n'),
      'routes/portal-admin.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('stats', 'PortalController@stats')->withoutMiddleware('log');\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it("reports Laravel's prefixes and gathered middleware", () => {
    const routes: RouteView[] = JSON.parse(mapx(root, 'routes', root, '--json'));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.handlerSymbol?.split('\\').pop()} [${r.middlewares.join(',')}]`).sort()).toEqual([
      'GET /portal/admin/stats PortalController@stats [second]',
      'GET /portal/home PortalController@home [auth]',
    ]);
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

// Independent review of M1-07-R2 (2026-10-31): `$path` of one provider method reached another.
describe('M1-07-R2 review: variable bindings stay in their method', () => {
  it('mounts each method\'s own $path; one that cannot be evaluated is unknown, never another method\'s file', () => {
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Providers/RouteServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
        'use Illuminate\\Support\\Facades\\Route;',
        'class RouteServiceProvider extends ServiceProvider',
        '{',
        '    public function map()',
        '    {',
        '        $this->mapApiRoutes();',
        "        $this->mapModuleRoutes('blog');",
        '        $this->mapLegacy($this->legacyPath);',
        '        $this->mapAdmin(env(\'ADMIN_ROUTES\'));',
        '    }',
        '    protected function mapAdmin($file)',
        '    {',
        "        $path = base_path('routes/admin.php');",
        "        $path = base_path($file);",
        "        Route::prefix('admin')->group($path);",
        '    }',
        '    protected function mapApiRoutes()',
        '    {',
        "        $path = base_path('routes/api.php');",
        "        Route::prefix('api')->middleware('api')->group($path);",
        '    }',
        '    protected function mapLegacy($path)',
        '    {',
        "        Route::prefix('legacy')->group($path);",
        '    }',
        '    protected function mapModuleRoutes(string $module)',
        '    {',
        '        $path = base_path("routes/modules/{$module}.php");',
        "        Route::prefix($module)->middleware('web')->group($path);",
        '    }',
        '}',
      ].join('\n'),
      'routes/api.php': "<?php\nRoute::get('users', 'UserController@index');\n",
      'routes/modules/blog.php': "<?php\nRoute::get('posts', 'PostController@index');\n",
      'routes/admin.php': "<?php\nRoute::get('panel', 'AdminController@panel');\n",
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as Array<{ method: string; path: string; reachability?: string }>;
      expect(routes.map((r) => `${r.method} ${r.path} ${r.reachability}`).sort()).toEqual([
        'GET /api/users reachable',
        'GET /panel unknown',
        'GET /posts unknown',
      ]);
    } finally {
      cleanup(root);
    }
  }, 90000);
});

// Independent review of M0-04-R6 (2026-10-31).
describe('M0-04-R6 review: constructor middleware, app boundaries, resource middleware', () => {
  type View = { method: string; path: string; middlewares: string[] };
  const kernel = (ns = 'App\\Http') => `<?php\nnamespace ${ns};\nclass Kernel { protected $routeMiddleware = ['auth' => \\App\\Http\\Middleware\\Authenticate::class]; }\n`;
  const mw = (cls: string) => `<?php\nnamespace App\\Http\\Middleware;\nclass ${cls} { public function handle($r, $n) { return $n($r); } }\n`;
  it('names constructor middleware given as a class constant, and links it', () => {
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Http/Kernel.php': kernel(),
      'app/Http/Middleware/Authenticate.php': mw('Authenticate'),
      'app/Http/Middleware/EnsureRole.php': mw('EnsureRole'),
      'app/Http/Controllers/PostController.php': [
        '<?php', 'namespace App\\Http\\Controllers;', 'use App\\Http\\Middleware\\EnsureRole;',
        'class PostController { public function __construct() { $this->middleware(EnsureRole::class); } public function index() {} }',
      ].join('\n'),
      'routes/web.php': "<?php\nuse App\\Http\\Controllers\\PostController;\nRoute::get('posts', [PostController::class, 'index']);\n",
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as View[];
      expect(routes.find((r) => r.path === '/posts')?.middlewares).toEqual(['App\\Http\\Middleware\\EnsureRole']);
      const targets = query<{ t: string }>(root, "SELECT target_file AS t FROM edges WHERE edge_type = 'middleware' AND source_file = 'routes/web.php' ORDER BY t").map((r) => r.t);
      expect(targets).toContain('app/Http/Middleware/EnsureRole.php');
    } finally {
      cleanup(root);
    }
  }, 90000);

  it('reads one argument of ->middleware() on a resource, as PendingResourceRegistration does', () => {
    const root = workspace({
      artisan: '<?php\n',
      'routes/web.php': "<?php\nRoute::resource('photos', PhotoController::class)->middleware('auth', 'extra');\nRoute::get('a', fn () => 1)->middleware('auth', 'verified');\n",
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as View[];
      const photos = routes.filter((r) => r.path.startsWith('/photos'));
      expect(photos.length).toBeGreaterThan(0);
      // routes/web.php adds the web group.
      for (const r of photos) expect(r.middlewares).toEqual(['web', 'auth']);
      expect(routes.find((r) => r.path === '/a')?.middlewares).toEqual(['web', 'auth', 'verified']);
    } finally {
      cleanup(root);
    }
  }, 90000);

  it('never links a route to a middleware class only another Laravel app declares', () => {
    const app = (dir: string) => ({ [`${dir}/artisan`]: '#!/usr/bin/env php\n<?php\n', [`${dir}/app/Http/Kernel.php`]: kernel() });
    const root = workspace({
      ...app('a'),
      ...app('b'),
      'a/routes/web.php': "<?php\nuse App\\Http\\Middleware\\OnlyInB;\nRoute::get('x', fn () => 1)->middleware(OnlyInB::class);\n",
      'b/app/Http/Middleware/OnlyInB.php': mw('OnlyInB'),
      'b/routes/web.php': "<?php\nuse App\\Http\\Middleware\\OnlyInB;\nRoute::get('y', fn () => 1)->middleware(OnlyInB::class);\n",
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const edges = query<{ e: string }>(root, "SELECT source_file || ' -> ' || target_file AS e FROM edges WHERE edge_type = 'middleware' ORDER BY e").map((r) => r.e);
      expect(edges).toEqual(['b/routes/web.php -> b/app/Http/Middleware/OnlyInB.php']);
    } finally {
      cleanup(root);
    }
  }, 90000);
});

// M1-03-R2 (review 2026-10-31, P2; RouteServiceProvider findings of reviewer J): variable bindings
// follow PHP's assignment operators, property writes and closure scope.
describe('M1-03-R2: compound and property assignments, closure scope', () => {
  it('evaluates .= and ??=, scopes a $this->prop write to the rest of its method, and hides outer variables from a closure without use', () => {
    const src = [
      'class P {',
      "    protected $edition = 'e1';",
      '    public function a($given) {',
      "        $p = 'cmp';",
      "        $p .= '/more';",
      "        $q ??= 'fresh';",
      "        $k = 'kept';",
      "        $k ??= 'other';",
      "        $u = config('x');",
      "        $u ??= 'never';",
      "        $w = 'w';",
      "        $w .= config('z');",
      "        $given ??= 'x';",
      '        /*before*/',
      "        $this->edition = 'e2';",
      "        $f = 'file.php';",
      '        /*A*/',
      '        Route::group(function () { /*noUse*/ });',
      '        Route::group(function () use ($f) { /*use*/ });',
      '        Route::group(fn () => 1 /*arrow*/);',
      '    }',
      '    public function b() { /*B*/ }',
      '}',
      "$t ??= 'top';",
      '/*top*/',
    ].join('\n');
    const { code, text } = maskPhp(src);
    const assignments = stringAssignments(text, code, { dir: '', root: '' });
    const at = (marker: string) => Object.fromEntries(varsAt(assignments, src.indexOf(`/*${marker}*/`)));
    expect(at('A')).toEqual({ p: 'cmp/more', q: 'fresh', k: 'kept', f: 'file.php', 'this->edition': 'e2' });
    // Another method may have written the property first: unknown before the write and elsewhere.
    expect(at('before')).toEqual({ p: 'cmp/more', q: 'fresh', k: 'kept' });
    expect(at('B')).toEqual({});
    // A closure sees $this and its `use` variables only; an arrow function sees the whole scope.
    expect(at('noUse')).toEqual({ 'this->edition': 'e2' });
    expect(at('use')).toEqual({ f: 'file.php', 'this->edition': 'e2' });
    expect(at('arrow')).toEqual({ p: 'cmp/more', q: 'fresh', k: 'kept', f: 'file.php', 'this->edition': 'e2' });
    // Top-level code may inherit the variables of whatever requires it: ??= there is unknown.
    expect(at('top')).toEqual({});
  });
});

describe('M1-03-R2: require_once and cycles, trailing slashes, dynamic resources, match verbs, invokable controllers', () => {
  let root: string;
  let routes: RouteView[];

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/api.php': [
        '<?php',
        'use Illuminate\\Support\\Facades\\Route;',
        'use App\\Http\\Controllers\\ShowProfile;',
        "Route::prefix('v1')->group(function () { require_once __DIR__.'/shared.php'; });",
        "Route::prefix('v2')->group(function () { require_once __DIR__.'/shared.php'; });",
        "require __DIR__.'/cycle-a.php';",
        "require __DIR__.'/loop-a.php';",
        "Route::prefix('admin')->group(fn () => Route::get('/', 'AdminController@old'));",
        "Route::get('admin', 'AdminController@current');",
        "Route::prefix('blank')->group(function () { Route::get('', 'BlankController@index'); });",
        "Route::resource($unknown, 'PhotoController')->only(['index', 'show']);",
        "Route::resource(\"albums-{$unknown}\", 'AlbumController')->only(['show']);",
        "Route::match([\"get\", \"post\"], 'feeds', 'FeedController@feeds');",
        "Route::match('put', 'single', 'FeedController@single');",
        "Route::match($verbs, 'any-verb', 'FeedController@unknown');",
        "Route::get('profile', ShowProfile::class);",
        "Route::get('legacy-profile', 'LegacyProfile');",
      ].join('\n'),
      'routes/shared.php': "<?php\nRoute::get('shared', 'SharedController@show');\n",
      // cycle-b goes back with require_once: both files are already loaded, so PHP does nothing.
      'routes/cycle-a.php': "<?php\nRoute::get('cycle-a', 'CycleController@a');\nrequire __DIR__.'/cycle-b.php';\n",
      'routes/cycle-b.php': "<?php\nRoute::get('cycle-b', 'CycleController@b');\nrequire_once __DIR__.'/cycle-a.php';\nrequire_once __DIR__.'/api.php';\n",
      // A plain require cycle: PHP would recurse until it fails; each route is reported once.
      'routes/loop-a.php': "<?php\nRoute::get('loop-a', 'LoopController@a');\nrequire __DIR__.'/loop-b.php';\n",
      'routes/loop-b.php': "<?php\nRoute::get('loop-b', 'LoopController@b');\nrequire __DIR__.'/loop-a.php';\n",
      'app/Http/Controllers/ShowProfile.php': '<?php\nnamespace App\\Http\\Controllers;\nclass ShowProfile { public function __invoke() {} }\n',
    });
    init(root);
    mapx(root, 'scan', root);
    routes = JSON.parse(mapx(root, 'routes', root, '--json'));
  }, 90000);
  afterAll(() => cleanup(root));

  const view = (r: RouteView) =>
    `${r.method} ${r.path} ${r.handlerSymbol?.split('\\').pop() ?? '-'}${r.overridden ? ' overridden' : ''}${r.dynamic ? ' dynamic' : ''}`;

  it('mounts a require_once file once and reports each route of a require cycle once', () => {
    const files = ['SharedController', 'CycleController', 'LoopController'];
    expect(routes.filter((r) => files.some((f) => r.handlerSymbol?.includes(f))).map(view).sort()).toEqual([
      'GET /api/cycle-a CycleController@a',
      'GET /api/cycle-b CycleController@b',
      'GET /api/loop-a LoopController@a',
      'GET /api/loop-b LoopController@b',
      'GET /api/v1/shared SharedController@show',
    ]);
    // routes/api.php itself is not mounted again through cycle-b's require_once.
    expect(routes.filter((r) => r.path === '/api/profile')).toHaveLength(1);
  });

  it("gives '/' and '' under a prefix the prefix itself, overridden by a later route of that URI", () => {
    expect(routes.filter((r) => /Admin|Blank/.test(r.handlerSymbol ?? '')).map(view).sort()).toEqual([
      'GET /api/admin AdminController@current',
      'GET /api/admin AdminController@old overridden',
      'GET /api/blank BlankController@index',
    ]);
  });

  it('flags a resource whose name cannot be evaluated dynamic, with {dynamic} wildcards', () => {
    expect(routes.filter((r) => /Photo|Album/.test(r.handlerSymbol ?? '')).map(view).sort()).toEqual([
      'GET /api/albums-{dynamic}/{dynamic} AlbumController@show dynamic',
      'GET /api/{dynamic} PhotoController@index dynamic',
      'GET /api/{dynamic}/{dynamic} PhotoController@show dynamic',
    ]);
  });

  it('reads Route::match verbs as PHP values: quoted either way, a single string, or unknown (ANY)', () => {
    expect(routes.filter((r) => r.handlerSymbol?.includes('FeedController')).map(view).sort()).toEqual([
      'ANY /api/any-verb FeedController@unknown dynamic',
      'GET|POST /api/feeds FeedController@feeds',
      'PUT /api/single FeedController@single',
    ]);
  });

  it('gives a single-action controller (X::class or a class-name string) its __invoke handler', () => {
    expect(routes.filter((r) => r.path.includes('profile')).map((r) => `${r.path} ${r.handlerSymbol}`).sort()).toEqual([
      '/api/legacy-profile App\\Http\\Controllers\\LegacyProfile@__invoke',
      '/api/profile App\\Http\\Controllers\\ShowProfile@__invoke',
    ]);
  });
});

describe('M1-03-R2: RouteServiceProvider assignments, partly dynamic prefixes, name prefixes and closure scope', () => {
  it('evaluates .=, ??= and $this->prop writes or makes them unknown, flags partly dynamic URIs, keeps {dynamic} name prefixes', () => {
    const file = (uri: string, name = '') => `<?php\nRoute::get('${uri}', fn () => 1)${name ? `->name('${name}')` : ''};\n`;
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Providers/RouteServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
        'use Illuminate\\Support\\Facades\\Route;',
        'class RouteServiceProvider extends ServiceProvider',
        '{',
        "    protected $edition = 'e1';",
        '    public function boot(): void',
        '    {',
        '        $this->routes(function () {',
        '            $this->mapCompound();',
        "            $this->mapGiven('x');",
        '            $this->mapEdition();',
        '            $this->mapAfterEdition();',
        '            $this->mapNoUse();',
        '            $this->mapUse();',
        '            $this->mapPartial();',
        '        });',
        '    }',
        '    protected function mapCompound()',
        '    {',
        "        $p = 'cmp';",
        "        $p .= '/more';",
        "        $q ??= 'fresh';",
        "        $known = 'kept';",
        "        $known ??= 'ignored';",
        "        $u = config('x');",
        "        $u ??= 'never';",
        "        $w = 'w';",
        "        $w .= config('z');",
        "        Route::prefix($p)->group(base_path('routes/compound.php'));",
        "        Route::prefix($q)->group(base_path('routes/fresh.php'));",
        "        Route::prefix($known)->group(base_path('routes/kept.php'));",
        "        Route::prefix($u)->group(base_path('routes/unknown.php'));",
        "        Route::prefix($w)->group(base_path('routes/tail.php'));",
        '    }',
        '    protected function mapGiven($given)',
        '    {',
        "        $given ??= 'g';",
        "        Route::prefix($given)->group(base_path('routes/given.php'));",
        '    }',
        '    protected function mapEdition()',
        '    {',
        "        $this->edition = 'e2';",
        "        Route::prefix($this->edition)->group(base_path('routes/edition.php'));",
        '    }',
        '    protected function mapAfterEdition()',
        '    {',
        "        Route::prefix(\"after/{$this->edition}\")->group(base_path('routes/after.php'));",
        '    }',
        '    protected function mapNoUse()',
        '    {',
        "        $file = base_path('routes/hidden.php');",
        "        Route::prefix('nu')->group(function () { require $file; });",
        '    }',
        '    protected function mapUse()',
        '    {',
        "        $file = base_path('routes/captured.php');",
        "        Route::prefix('cu')->group(function () use ($file) { require $file; });",
        '    }',
        '    protected function mapPartial()',
        '    {',
        "        Route::prefix(\"zone{$this->zone()}\")->name(\"z.{$this->zone()}.\")->group(base_path('routes/zone.php'));",
        "        Route::prefix('nm')->name(config('app.route_name'))->group(base_path('routes/named.php'));",
        '    }',
        '}',
      ].join('\n'),
      'routes/compound.php': file('c'),
      'routes/fresh.php': file('f'),
      'routes/kept.php': file('k'),
      'routes/unknown.php': file('u'),
      'routes/tail.php': file('t'),
      'routes/given.php': file('g'),
      'routes/edition.php': file('e'),
      'routes/after.php': file('a'),
      'routes/hidden.php': file('h'),
      'routes/captured.php': file('cap'),
      'routes/zone.php': file('map', 'map'),
      'routes/named.php': file('n', 'page'),
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as Array<RouteView & { reachability?: string }>;
      expect(routes.map((r) => `${r.method} ${r.path} ${r.reachability}${r.dynamic ? ' dynamic' : ''}${r.name ? ` ${r.name}` : ''}`).sort()).toEqual([
        'GET /after/{dynamic}/a reachable dynamic',
        'GET /cmp/more/c reachable',
        'GET /cu/cap reachable',
        'GET /e2/e reachable',
        'GET /fresh/f reachable',
        // The closure without `use` cannot see $file: the mount is unresolved, the file unknown.
        'GET /h unknown',
        'GET /kept/k reachable',
        'GET /nm/n reachable {dynamic}page',
        'GET /zone{dynamic}/map reachable dynamic z.{dynamic}.map',
        'GET /{dynamic}/g reachable dynamic',
        'GET /{dynamic}/t reachable dynamic',
        'GET /{dynamic}/u reachable dynamic',
      ]);
    } finally {
      cleanup(root);
    }
  }, 90000);
});

// Review 2026-10-31 (M1-03-R2): Laravel 11 withRouting registers api, then web.
describe('M1-03-R2 review: withRouting order', () => {
  it('mounts api before web: a shared require_once file belongs to api, and web overrides a URI both define', () => {
    const php = (lines: string[]) => ['<?php', 'use Illuminate\\Support\\Facades\\Route;', ...lines].join('\n') + '\n';
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'bootstrap/app.php': "<?php\nuse Illuminate\\Foundation\\Application;\nreturn Application::configure(basePath: dirname(__DIR__))\n    ->withRouting(\n        web: __DIR__.'/../routes/web.php',\n        api: __DIR__.'/../routes/api.php',\n        apiPrefix: '',\n    )->create();\n",
      'routes/web.php': php(["require_once __DIR__.'/shared.php';", "Route::get('same', 'WebController@same');"]),
      'routes/api.php': php(["require_once __DIR__.'/shared.php';", "Route::get('same', 'ApiController@same');"]),
      'routes/shared.php': php(["Route::get('shared', 'SharedController@x');"]),
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as Array<{ path: string; handlerSymbol?: string; metadata?: Record<string, any> }>;
      expect(routes.find((r) => r.path === '/shared')?.metadata?.middlewares).toEqual(['api']);
      const live = routes.filter((r) => r.path === '/same' && !r.metadata?.overriddenBy).map((r) => r.handlerSymbol?.split('\\').pop());
      expect(live).toEqual(['WebController@same']);
    } finally {
      cleanup(root);
    }
  }, 90000);
});

// Review 2026-11-02 (M1-07-R2/M1-03-R2): Router::group wraps its routes in an array, so a list of
// files mounts each; a foreach-bound or conditionally reassigned prefix is unknown, not definite.
describe('M1-07-R3: route files mounted as arrays; loop and conditional prefix variables', () => {
  type View = { method: string; path: string; handlerSymbol?: string; reachability?: string; dynamic?: boolean; conditional?: boolean; metadata?: Record<string, any> };
  const RSP = 'app/Providers/RouteServiceProvider.php';
  const provider = (body: string[]) => [
    '<?php',
    'namespace App\\Providers;',
    'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
    'use Illuminate\\Support\\Facades\\Route;',
    'class RouteServiceProvider extends ServiceProvider',
    '{',
    "    protected $sections = ['docs' => 'Docs'];",
    '    public function map()',
    '    {',
    ...body.map((l) => `        ${l}`),
    '    }',
    '}',
  ].join('\n');
  const file = (uri: string) => `<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('${uri}', fn () => 1);\n`;
  const lineOf = (src: string, needle: string) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const scanRoutes = (files: Record<string, string>) => {
    const root = workspace({ artisan: '#!/usr/bin/env php\n<?php\n', ...files });
    try {
      init(root);
      mapx(root, 'scan', root);
      return JSON.parse(mapx(root, 'routes', root, '--json')) as View[];
    } finally {
      cleanup(root);
    }
  };

  it('mounts each file of a list under ->group([...]) and Route::group($attributes, [...]), with the group attributes', () => {
    const rsp = provider([
      "Route::prefix('bundle')->middleware('web')->group([",
      "    base_path('routes/first.php'),",
      "    base_path('routes/second.php'),",
      ']);',
      "Route::group(['prefix' => 'kit', 'middleware' => 'api'], array(__DIR__.'/../../routes/tools.php', base_path('routes/parts.php')));",
      // Review 2026-11-02: a literal spread is flattened.
      "Route::prefix('sp')->group([...[base_path('routes/s1.php')], base_path('routes/s2.php')]);",
    ]);
    const routes = scanRoutes({
      [RSP]: rsp,
      'routes/first.php': `${file('first')}Route::prefix('nested')->group([__DIR__.'/nested.php', __DIR__.'/nested2.php']);\n`,
      // Review 2026-11-02: closures in the list are group bodies; the files in it still mount.
      'routes/second.php': `${file('second')}Route::prefix('mix')->group([function () { Route::get('inline', fn () => 1); }, __DIR__.'/t.php', static fn () => Route::get('arrow', fn () => 1)]);\n`,
      'routes/t.php': file('t'),
      'routes/s1.php': file('s1'),
      'routes/s2.php': file('s2'),
      // Both define `same`: the file listed later registers it later, so it wins.
      'routes/nested.php': `${file('n')}Route::get('same', 'NestedController@same');\n`,
      'routes/nested2.php': `${file('n2')}Route::get('same', 'Nested2Controller@same');\n`,
      'routes/tools.php': file('tools'),
      'routes/parts.php': file('parts'),
      'routes/orphan.php': file('orphan'),
    });
    expect(routes.map((r) => `${r.method} ${r.path} [${(r.metadata?.middlewares ?? []).join(',')}] ${r.reachability}`).sort()).toEqual([
      'GET /bundle/first [web] reachable',
      'GET /bundle/mix/arrow [web] reachable',
      'GET /bundle/mix/inline [web] reachable',
      'GET /bundle/mix/t [web] reachable',
      'GET /bundle/nested/n [web] reachable',
      'GET /bundle/nested/n2 [web] reachable',
      'GET /bundle/nested/same [web] reachable',
      'GET /bundle/nested/same [web] reachable',
      'GET /bundle/second [web] reachable',
      'GET /kit/parts [api] reachable',
      'GET /kit/tools [api] reachable',
      // Every mount was evaluated, so a file nothing loads is proven unreachable.
      'GET /orphan [] unreachable',
      'GET /sp/s1 [] reachable',
      'GET /sp/s2 [] reachable',
    ]);
    const mounted = (path: string) => routes.find((r) => r.path === path)?.metadata?.mountedBy;
    expect(mounted('/bundle/first')).toBe(`${RSP}:${lineOf(rsp, "prefix('bundle')")}`);
    expect(mounted('/bundle/second')).toBe(`${RSP}:${lineOf(rsp, "prefix('bundle')")}`);
    expect(mounted('/kit/tools')).toBe(`${RSP}:${lineOf(rsp, "'kit'")}`);
    expect(mounted('/bundle/nested/n2')).toBe('routes/first.php:4');
    const live = routes.filter((r) => r.path === '/bundle/nested/same' && !r.metadata?.overriddenBy).map((r) => r.handlerSymbol?.split('\\').pop());
    expect(live).toEqual(['Nested2Controller@same']);
    // Each file of the list has its own position: the later one sorts after the earlier.
    const order = (path: string) => (routes.find((r) => r.path === path)?.metadata?.order ?? []) as number[];
    const later = (a: number[], b: number[]) => { const i = a.findIndex((x, k) => x !== b[k]); return i >= 0 && a[i]! > b[i]!; };
    expect(later(order('/bundle/nested/n2'), order('/bundle/nested/n'))).toBe(true);
  }, 90000);

  it('records a list element that cannot be evaluated unresolved: the other elements mount, unmounted files are unknown', () => {
    // Two elements cannot be evaluated: the statement's line is listed once. `static::file()` is a
    // call, not a static closure (review 2026-11-02).
    const rsp = provider([
      "Route::prefix('mixed')->group([base_path('routes/known.php'), env('EXTRA_ROUTES'), $this->extra()]);",
      "Route::prefix('st')->group([static::file('s.php'), base_path('routes/t.php')]);",
    ]);
    const routes = scanRoutes({ [RSP]: rsp, 'routes/known.php': file('k'), 'routes/other.php': file('o'), 'routes/s.php': file('s'), 'routes/t.php': file('t') });
    expect(routes.map((r) => `${r.method} ${r.path} ${r.reachability}`).sort()).toEqual(['GET /mixed/k reachable', 'GET /o unknown', 'GET /s unknown', 'GET /st/t reachable']);
    expect(routes.find((r) => r.path === '/o')?.metadata?.unresolvedMounts).toEqual([
      `${RSP}:${lineOf(rsp, "prefix('mixed')")}`,
      `${RSP}:${lineOf(rsp, "prefix('st')")}`,
    ]);
  }, 90000);

  it('makes foreach-bound and conditionally reassigned prefixes {dynamic}, keeping values that are certain', () => {
    const routes = scanRoutes({
      [RSP]: provider([
        "$v = 'v0';",
        "foreach (['v1', 'v2'] as $v) {",
        "    Route::prefix($v)->group(base_path('routes/loop.php'));",
        '}',
        "$key = 'k0';",
        'foreach ($this->sections as $key => $label) {',
        "    Route::prefix($key)->group(base_path('routes/keyed.php'));",
        '}',
        "$p = 'admin';",
        "if ($this->app->environment('local')) {",
        "    $p = 'staff';",
        '}',
        "Route::prefix($p)->group(base_path('routes/cond.php'));",
        "$q = 'one';",
        "if (app()->isLocal()) $q = 'two';",
        "Route::prefix($q)->group(base_path('routes/braceless.php'));",
        "$r = 'out';",
        'if (app()->isLocal()) {',
        "    $r = 'in';",
        "    Route::prefix($r)->group(base_path('routes/inner.php'));",
        '}',
        'if (! $this->app->routesAreCached()) {',
        "    $s = 'cached';",
        '}',
        "Route::prefix($s)->group(base_path('routes/cached.php'));",
        // Review 2026-11-02: a later assignment in a loop body reaches the next pass; a do body
        // always runs once.
        "$w = 'w0';",
        'while (app()->isLocal()) {',
        "    Route::prefix($w)->group(base_path('routes/while.php'));",
        "    $w = 'w1';",
        '}',
        "$f = 'f0';",
        'for ($j = 0; $j < 2; $j++) {',
        "    Route::prefix($f)->group(base_path('routes/for.php'));",
        "    $f = 'f1';",
        '}',
        "$g = 'g0';",
        'foreach ([1, 2] as $n) {',
        "    Route::prefix($g)->group(base_path('routes/each.php'));",
        "    $g = 'g1';",
        '}',
        "$d = 'd0';",
        'do {',
        "    $d = 'd1';",
        '} while (app()->isLocal());',
        "Route::prefix($d)->group(base_path('routes/do.php'));",
      ]),
      'routes/while.php': file('w'),
      'routes/for.php': file('f'),
      'routes/each.php': file('g'),
      'routes/do.php': file('d'),
      'routes/loop.php': file('l'),
      'routes/keyed.php': file('k'),
      'routes/cond.php': file('c'),
      'routes/braceless.php': file('b'),
      'routes/inner.php': file('i'),
      'routes/cached.php': file('s'),
    });
    expect(routes.map((r) => `${r.path}${r.dynamic ? ' dynamic' : ''}${r.conditional ? ' conditional' : ''}`).sort()).toEqual([
      '/cached/s',
      '/d1/d',
      '/in/i conditional',
      '/{dynamic}/b dynamic',
      '/{dynamic}/c dynamic',
      '/{dynamic}/f dynamic',
      '/{dynamic}/g dynamic',
      '/{dynamic}/k dynamic',
      '/{dynamic}/l dynamic',
      '/{dynamic}/w dynamic',
    ]);
  }, 90000);

  it('binds foreach variables and conditional assignments only where they surely hold', () => {
    const src = [
      '<?php',
      'function f() {',
      "    $keep = 'yes'; $v = 'v0'; $k = 'k0'; $w = 'w0';",
      '    foreach ($items as $k => [$v, &$w]) { /*A*/ }',
      "    $p = 'admin';",
      "    if ($x) { $p = 'staff'; /*B*/ }",
      '    /*C*/',
      "    while ($y) { $t = 'loop'; }",
      "    $u = 'one'; if ($z) $u = 'two'; /*D*/",
      "    $e = 'e0'; while ($y) { /*E*/ $e = 'e1'; /*F*/ }",
      "    $o = 'o0'; do { /*H*/ $o = 'o1'; } while ($y); /*G*/",
      '}',
    ].join('\n');
    const { code, text } = maskPhp(src);
    const at = stringAssignments(text, code, { dir: '', root: '' });
    const vars = (mark: string) => Object.fromEntries(varsAt(at, src.indexOf(mark)));
    expect(vars('/*A*/')).toEqual({ keep: 'yes' });
    expect(vars('/*B*/')).toEqual({ keep: 'yes', p: 'staff' });
    expect(vars('/*C*/')).toEqual({ keep: 'yes' });
    expect(vars('/*D*/')).toEqual({ keep: 'yes' });
    // Review 2026-11-02: the next pass of a loop sees its later assignments; a do body runs once.
    expect(vars('/*E*/')).toEqual({ keep: 'yes' });
    expect(vars('/*F*/')).toEqual({ keep: 'yes', e: 'e1' });
    expect(vars('/*G*/')).toEqual({ keep: 'yes', o: 'o1' });
    expect(vars('/*H*/')).toEqual({ keep: 'yes' });
  });
});

// Review 2026-10-31 (M1-03-R2): a compound assignment under a condition may not have run.
describe('M1-03-R2 review: conditional compound assignments', () => {
  it('makes a .= under an if unknown, never applies it as certain', () => {
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Providers/RouteServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
        'use Illuminate\\Support\\Facades\\Route;',
        'class RouteServiceProvider extends ServiceProvider',
        '{',
        '    public function map()',
        '    {',
        "        $p = 'web1';",
        "        if ($this->app->environment('local')) {",
        "            $p .= '-dev';",
        '        }',
        "        Route::prefix($p)->group(base_path('routes/g.php'));",
        "        $s = 'plain';",
        "        $s .= '-x';",
        "        Route::prefix($s)->group(base_path('routes/s.php'));",
        '    }',
        '}',
      ].join('\n'),
      'routes/g.php': "<?php\nRoute::get('g', 'GController@g');\n",
      'routes/s.php': "<?php\nRoute::get('t', 'SController@t');\n",
    });
    try {
      init(root);
      mapx(root, 'scan', root);
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as Array<{ path: string; dynamic?: boolean }>;
      expect(routes.map((r) => `${r.path}${r.dynamic ? ' dynamic' : ''}`).sort()).toEqual(['/plain-x/t', '/{dynamic}/g dynamic']);
    } finally {
      cleanup(root);
    }
  }, 90000);
});
