import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pairCall, routeDomainHosts, urlHost, urlSegments, type PairOptions } from '../src/frameworks/http/pairing.js';
import type { HttpCallRecord } from '../src/frameworks/http/http-registry.js';
import type { RouteBinding } from '../src/types.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-06: pairing frontend HTTP calls with backend routes.
const route = (method: string, path: string, handlerSymbol: string, metadata: Record<string, unknown> = {}): RouteBinding =>
  ({ framework: 'laravel', method, path, handlerFile: 'app/C.php', handlerSymbol, metadata });
const call = (method: string, url: string, extra: Partial<HttpCallRecord> = {}): HttpCallRecord =>
  ({ file: 'web/a.ts', line: 1, method, rawUrl: `'${url}'`, url, client: { kind: 'axios', name: 'axios' }, ...extra });

describe('pairCall', () => {
  const routes = [
    route('GET', '/api/people/{person}', 'People@show'),
    route('GET', '/api/blog-categories/create', 'Cat@create'),
    route('GET', '/api/blog-categories/{blog_category}', 'Cat@show'),
    route('GET', '/api/dup', 'Post@oldDup', { overridden: true }),
    route('GET', '/api/dup', 'Post@newDup'),
    route('GET', '/ghost', 'Ghost@show', { reachable: false }),
    route('GET|POST', '/api/search', 'Search@run'),
    route('ANY', '/hook', 'Hook@any'),
  ];

  it('treats {id} and {slug} alike and prefers literal matches', () => {
    expect(pairCall(call('GET', '/api/people/{}'), routes)).toMatchObject({ handlerSymbol: 'People@show', confidence: 'parametric' });
    expect(pairCall(call('GET', '/api/blog-categories/create'), routes)).toMatchObject({ handlerSymbol: 'Cat@create', confidence: 'exact' });
    expect(pairCall(call('GET', '/api/blog-categories/{}'), routes)?.handlerSymbol).toBe('Cat@show');
  });

  it('pairs only with live routes: the winner of a duplicate, never an unmounted route', () => {
    expect(pairCall(call('GET', '/api/dup'), routes)?.handlerSymbol).toBe('Post@newDup');
    expect(pairCall(call('GET', '/ghost'), routes)).toBeNull();
  });

  it('honours method sets and ANY, and rejects other methods', () => {
    expect(pairCall(call('POST', '/api/search'), routes)?.handlerSymbol).toBe('Search@run');
    expect(pairCall(call('DELETE', '/hook'), routes)?.handlerSymbol).toBe('Hook@any');
    expect(pairCall(call('DELETE', '/api/search'), routes)).toBeNull();
  });

  it('never pairs an unknown segment with a literal route segment', () => {
    expect(pairCall(call('GET', '/api/{}'), [route('GET', '/api/posts', 'Post@index')])).toBeNull();
  });

  it('matches by suffix when the base URL is unknown, and ignores host, query and hash', () => {
    expect(pairCall(call('GET', 'people/{}', { baseURLUnresolved: true }), routes)).toMatchObject({ handlerSymbol: 'People@show', confidence: 'suffix' });
    expect(urlSegments('https://x.test/api/a?b=1#c')).toEqual(['api', 'a']);
    expect(pairCall(call('GET', 'https://x.test/api/people/7?full=1'), routes)?.handlerSymbol).toBe('People@show');
  });
});

// Pairing defects found by the independent M2 review (fixed in M2-06 before acceptance).
describe('pairCall review fixes', () => {
  it('never pairs with client-side page routes, even when they match better', () => {
    const routes = [
      { ...route('GET|HEAD', '/api/posts', 'Post@index') },
      { ...route('GET', '/posts', 'default'), framework: 'vue-router', handlerFile: 'src/views/Posts.vue' },
      { ...route('GET', '/dashboard', 'default'), framework: 'nextjs', metadata: { routeType: 'client' } },
    ];
    expect(pairCall(call('GET', '/posts'), routes)).toBeNull();
    expect(pairCall(call('GET', '/dashboard'), routes)).toBeNull();
    expect(pairCall(call('GET', 'posts', { baseURLUnresolved: true }), routes)).toMatchObject({ handlerSymbol: 'Post@index', confidence: 'suffix' });
  });

  it('matches Next.js ALL handlers and Express, Flask and Django parameters', () => {
    const routes = [
      { ...route('ALL', '/api/hello', 'default'), framework: 'nextjs', metadata: { routeType: 'server' } },
      { ...route('GET', '/api/users/:id', 'getUser'), framework: 'express' },
      { ...route('GET', '/items/<int:item_id>', 'item'), framework: 'flask' },
    ];
    expect(pairCall(call('POST', '/api/hello'), routes)?.handlerSymbol).toBe('default');
    expect(pairCall(call('GET', '/api/users/{}'), routes)?.handlerSymbol).toBe('getUser');
    expect(pairCall(call('GET', '/items/7'), routes)?.handlerSymbol).toBe('item');
  });
});

// M2-06-R1: a call pairs only with a route its literal path supports, on the right host.
describe('pairing needs literal evidence (M2-06-R1)', () => {
  const routes = [
    route('GET', '/api/blog-categories/{blog_category}', 'Cat@show'),
    route('GET', '/', 'Home@index'),
    route('DELETE', '/api/items/{item}', 'Item@destroy'),
    route('GET', '/{slug}', 'Page@show'),
  ];

  it('leaves calls without a literal path segment unmatched', () => {
    // `${endpoint}?page=${n}`, `${base}/${id}` and DELETE '/' behind an unknown base URL
    expect(pairCall(call('GET', '?page={}', { baseURLUnresolved: true }), routes)).toBeNull();
    expect(pairCall(call('GET', '/{}', { baseURLUnresolved: true }), routes)).toBeNull();
    expect(pairCall(call('DELETE', '/', { baseURLUnresolved: true }), routes)).toBeNull();
    // A fully known URL with no literal segment is no evidence either.
    expect(pairCall(call('GET', '/{}'), routes)).toBeNull();
  });

  it('still pairs the root path when the whole URL is known, and literal suffixes', () => {
    expect(pairCall(call('GET', '/'), routes)?.handlerSymbol).toBe('Home@index');
    expect(pairCall(call('GET', 'blog-categories/{}', { baseURLUnresolved: true }), routes)?.handlerSymbol).toBe('Cat@show');
  });

  it('lets a {dynamic} route segment match only alongside a literal, below a real parameter', () => {
    const dynamic = [route('GET', '/{dynamic}', 'Dyn@any'), route('GET', '/{dynamic}/users', 'Dyn@users')];
    expect(pairCall(call('GET', '/anything'), dynamic)).toBeNull();
    expect(pairCall(call('GET', '/api/users'), dynamic)).toMatchObject({ handlerSymbol: 'Dyn@users' });
    const both = [route('GET', '/api/{dynamic}', 'Dyn@show'), route('GET', '/api/{id}', 'Real@show')];
    expect(pairCall(call('GET', '/api/7'), both)?.handlerSymbol).toBe('Real@show');
    expect(pairCall(call('GET', '/api/7'), [...both].reverse())?.handlerSymbol).toBe('Real@show');
  });

  it('pairs absolute URLs only on local or workspace hosts', () => {
    const people = [route('GET', '/api/people/{person}', 'People@show')];
    expect(pairCall(call('GET', 'https://api.github.com/api/people/7'), people)).toBeNull();
    expect(pairCall(call('GET', '//cdn.example.org/api/people/7'), people)).toBeNull();
    expect(pairCall(call('GET', 'https://api.example.com/api/people/7'), people)).toBeNull();
    expect(pairCall(call('GET', 'https://api.example.com/api/people/7'), people, { hosts: new Set(['api.example.com']) })?.handlerSymbol).toBe('People@show');
    for (const local of ['http://localhost:8000', 'http://127.0.0.1', 'http://app.test', 'https://shop.localhost'])
      expect(pairCall(call('GET', `${local}/api/people/7`), people)?.handlerSymbol, local).toBe('People@show');
    expect(urlHost('https://user@API.Example.com:8443/x')).toBe('api.example.com');
    expect(urlHost('/api/x')).toBeNull();
  });

  it('never pairs a call whose method is unknown, even with an ANY route', () => {
    expect(pairCall(call('UNKNOWN', '/hook'), [route('ANY', '/hook', 'Hook@any')])).toBeNull();
  });
});

// M2-06-R2: a call with a host pairs only with routes whose Route::domain matches that host.
describe('pairing honours Route::domain (M2-06-R2)', () => {
  const onDomain = (path: string, handlerSymbol: string, domain?: string): RouteBinding =>
    ({ ...route('GET', path, handlerSymbol, domain ? { domain } : {}), handlerFile: `app/Http/Controllers/${handlerSymbol.split('@')[0]}.php` });
  // AdminUserController sorts first, so the old lexicographic tie-break picked the admin route.
  const admin = onDomain('/users', 'AdminUserController@index', 'admin.example.com');
  const api = onDomain('/users', 'ApiUserController@index', 'api.example.com');
  const hosts = new Set(['admin.example.com', 'api.example.com', 'acme.example.com', 'acme.other.com', 'a.b.example.com']);

  it('pairs a call with the route on its own domain, never with an admin-domain route', () => {
    expect(pairCall(call('GET', 'https://api.example.com/users'), [admin, api], { hosts })?.handlerSymbol).toBe('ApiUserController@index');
    expect(pairCall(call('GET', 'https://api.example.com/users'), [api, admin], { hosts })?.handlerSymbol).toBe('ApiUserController@index');
    expect(pairCall(call('GET', 'https://admin.example.com/users'), [admin, api], { hosts })?.handlerSymbol).toBe('AdminUserController@index');
    // With only the admin route, the api call has no route at all.
    expect(pairCall(call('GET', 'https://api.example.com/users'), [admin], { hosts })).toBeNull();
    // A local host is a host too: an admin-domain route does not serve it.
    expect(pairCall(call('GET', 'http://localhost:8000/users'), [admin])).toBeNull();
  });

  it('treats {param} domain segments as one-label wildcards, case-insensitively', () => {
    const tenant = onDomain('/users', 'TenantController@index', '{account}.Example.com');
    expect(pairCall(call('GET', 'https://ACME.example.com/users'), [tenant], { hosts })?.handlerSymbol).toBe('TenantController@index');
    expect(pairCall(call('GET', 'https://acme.other.com/users'), [tenant], { hosts })).toBeNull();
    expect(pairCall(call('GET', 'https://a.b.example.com/users'), [tenant], { hosts })).toBeNull();
    // A domain MapX could not evaluate stands for any text, dots included.
    const unknown = onDomain('/users', 'DynController@index', '{dynamic}.example.com');
    expect(pairCall(call('GET', 'https://a.b.example.com/users'), [unknown], { hosts })?.handlerSymbol).toBe('DynController@index');
    expect(pairCall(call('GET', 'https://acme.other.com/users'), [unknown], { hosts })).toBeNull();
  });

  it('leaves routes without a domain and calls without a host as before', () => {
    const plain = onDomain('/users', 'UserController@index');
    expect(pairCall(call('GET', 'https://api.example.com/users'), [admin, plain], { hosts })?.handlerSymbol).toBe('UserController@index');
    // A relative URL goes to whatever host serves the page: any domain may serve it.
    expect(pairCall(call('GET', '/users'), [admin])?.handlerSymbol).toBe('AdminUserController@index');
  });
});

// M2-06-R4: a route's literal Route::domain is one of the workspace's own hosts, as if a .env named it.
describe('route domains are workspace hosts (M2-06-R4)', () => {
  it('takes only literal domains of live backend routes as hosts, with the apps that declare them', () => {
    const hosts = routeDomainHosts([
      route('GET', '/feed', 'Feed@index', { domain: 'partners.example.com', appRoot: 'partners' }),
      route('GET', '/feed2', 'Feed@other', { domain: 'partners.example.com', appRoot: 'mirror' }),
      route('GET', '/b', 'B@x', { domain: 'https://Billing.Example.com:8443', appRoot: '' }),
      // A declaring route outside any known app still names the host, for no app's domain-less routes.
      route('GET', '/n', 'N@x', { domain: 'noapp.example.com' }),
      // No single host: a {param} label, an unevaluated part, or no domain at all.
      route('GET', '/t', 'T@x', { domain: '{account}.example.com', appRoot: 'partners' }),
      route('GET', '/d', 'D@x', { domain: '{dynamic}', appRoot: 'partners' }),
      route('GET', '/e', 'E@x', { domain: 'api.{dynamic}', appRoot: 'partners' }),
      route('GET', '/plain', 'P@x', { appRoot: 'shop' }),
      // Routes no request reaches name no served host.
      route('GET', '/u', 'U@x', { domain: 'unmounted.example.com', reachable: false }),
      route('GET', '/o', 'O@x', { domain: 'overridden.example.com', overridden: true }),
      { ...route('GET', '/page', 'Page'), framework: 'vue-router', metadata: { domain: 'spa.example.com' } },
    ]);
    expect(Object.fromEntries([...hosts].map(([host, apps]) => [host, [...apps].sort()]))).toEqual({
      'billing.example.com': [''],
      'noapp.example.com': [],
      'partners.example.com': ['mirror', 'partners'],
    });
  });

  // Review of M2-06-R4 (P1): a host only route domains name is served by the apps that declare it.
  it('never lets a domain-less route of another app serve a host only route domains name', () => {
    const routeHosts = new Map([['api.example.com', new Set(['partners'])]]);
    const routes = [
      route('GET', '/v1/users', 'Partner@users', { domain: 'api.example.com', appRoot: 'partners' }),
      route('GET', '/v1/status', 'Partner@status', { appRoot: 'partners' }),
      route('GET', '/v1/users', 'Shop@users', { appRoot: 'shop' }),
      route('GET', '/v1/orders', 'Shop@orders', { appRoot: 'shop' }),
      route('GET', '/v1/tenant', 'Shop@tenant', { domain: '{sub}.example.com', appRoot: 'shop' }),
      route('GET', '/v1/any', 'Shop@any', { domain: '{dynamic}', appRoot: 'shop' }),
      // A route of no known app (another framework) is another app too.
      route('GET', '/v1/express', 'expressOrders'),
    ];
    const pair = (url: string, options: PairOptions = { routeHosts }) => pairCall(call('GET', url), routes, options)?.handlerSymbol ?? null;
    expect(pair('https://api.example.com/v1/users')).toBe('Partner@users');
    expect(pair('https://API.example.com:8443/v1/status')).toBe('Partner@status');
    expect(pair('https://api.example.com/v1/orders')).toBeNull();
    expect(pair('https://api.example.com/v1/express')).toBeNull();
    // Another app serves the host only through a domain that matches it with evidence: {dynamic} is none.
    expect(pair('https://api.example.com/v1/tenant')).toBe('Shop@tenant');
    expect(pair('https://api.example.com/v1/any')).toBeNull();
    // A host the workspace names otherwise (.env, settings) keeps M2-06-R2 pairing.
    expect(pair('https://api.example.com/v1/orders', { routeHosts, hosts: new Set(['api.example.com']) })).toBe('Shop@orders');
    // Relative URLs are unaffected.
    expect(pair('/v1/orders')).toBe('Shop@orders');
  });

  describe('in a scan', () => {
    let root: string;
    beforeAll(() => {
      root = workspace(
        {
          // No .env, no settings.http: the only evidence for partners.example.com is the route domain.
          'frontend/src/feed.ts': [
            "import axios from 'axios';",
            "export const feed = () => axios.get('https://partners.example.com/feed');",
            "export const status = () => axios.get('https://partners.example.com/status');",
            "export const admin = () => axios.get('https://admin.example.net/admin-feed');",
            "export const other = () => axios.get('https://elsewhere.example.org/feed');",
            // Only the shop app serves /orders, with no domain: it does not serve partners.example.com.
            "export const orders = () => axios.get('https://partners.example.com/orders');",
            '',
          ].join('\n'),
          'backend/artisan': '#!/usr/bin/env php\n<?php\n',
          'backend/app/Http/Controllers/FeedController.php':
            '<?php\nnamespace App\\Http\\Controllers;\nclass FeedController { public function index() {} public function admin() {} public function status() {} }\n',
          'backend/routes/web.php': [
            '<?php',
            'use App\\Http\\Controllers\\FeedController;',
            "Route::domain('partners.example.com')->group(function () {",
            "    Route::get('feed', [FeedController::class, 'index']);",
            '});',
            "Route::domain(config('app.admin_host'))->group(function () {",
            "    Route::get('admin-feed', [FeedController::class, 'admin']);",
            '});',
            "Route::get('status', [FeedController::class, 'status']);",
            '',
          ].join('\n'),
          'shop/artisan': '#!/usr/bin/env php\n<?php\n',
          'shop/app/Http/Controllers/OrderController.php':
            '<?php\nnamespace App\\Http\\Controllers;\nclass OrderController { public function index() {} }\n',
          'shop/routes/web.php': "<?php\nuse App\\Http\\Controllers\\OrderController;\nRoute::get('orders', [OrderController::class, 'index']);\n",
        },
        ['frontend', 'backend', 'shop'],
      );
      init(root);
      mapx(root, 'workspaces', 'add', 'frontend');
      mapx(root, 'workspaces', 'add', 'backend');
      mapx(root, 'workspaces', 'add', 'shop');
    }, 120000);
    afterAll(() => cleanup(root));

    it('pairs a call to a literal route domain with no .env naming it', () => {
      const records = JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as HttpCallRecord[];
      const pairs = Object.fromEntries(records.map((r) => [r.url, r.route?.handlerSymbol ?? null]));
      expect(pairs['https://partners.example.com/feed']).toBe('App\\Http\\Controllers\\FeedController@index');
      // The host reaches the app, so its domain-less routes serve it too.
      expect(pairs['https://partners.example.com/status']).toBe('App\\Http\\Controllers\\FeedController@status');
      expect(pairs['https://elsewhere.example.org/feed']).toBeNull();
      // A domain-less route of another app does not serve a host only the backend's route domain names.
      expect(pairs['https://partners.example.com/orders']).toBeNull();
      const edges = query<{ source_file: string; target_symbol: string }>(
        root, "SELECT source_file, target_symbol FROM edges WHERE edge_type = 'http' ORDER BY target_symbol",
      );
      expect(edges.map((e) => [e.source_file, e.target_symbol])).toEqual([
        ['frontend/src/feed.ts', 'App\\Http\\Controllers\\FeedController@index'],
        ['frontend/src/feed.ts', 'App\\Http\\Controllers\\FeedController@status'],
      ]);
    });

    it('does not take a {dynamic} domain as a host', () => {
      const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as { path: string; domain?: string }[];
      expect(routes.find((r) => r.path.endsWith('admin-feed'))?.domain).toBe('{dynamic}');
      const unmatched = JSON.parse(mapx(root, 'routes', root, '--clients', '--unmatched', '--json')) as HttpCallRecord[];
      expect(unmatched.map((r) => r.url).sort()).toEqual([
        'https://admin.example.net/admin-feed', 'https://elsewhere.example.org/feed', 'https://partners.example.com/orders',
      ]);
    });
  });

  // A domain added or removed by a sync re-pairs exactly as a forced full scan does.
  describe('through sync', () => {
    let root: string;
    const routesFile = () => join(root, 'backend/routes/web.php');
    const withDomain = (domain: boolean) => [
      '<?php',
      'use App\\Http\\Controllers\\FeedController;',
      ...(domain
        ? ["Route::domain('partners.example.com')->group(function () {", "    Route::get('feed', [FeedController::class, 'index']);", '});']
        : ["Route::get('feed', [FeedController::class, 'index']);"]),
      '',
    ].join('\n');
    const state = () => ({
      records: (JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as HttpCallRecord[])
        .map((r) => `${r.url} → ${r.route?.handlerSymbol ?? null}`),
      edges: query<{ source_file: string; target_symbol: string }>(
        root, "SELECT source_file, target_symbol FROM edges WHERE edge_type = 'http' ORDER BY source_file, target_symbol",
      ).map((e) => `${e.source_file} → ${e.target_symbol}`),
    });
    beforeAll(() => {
      root = workspace(
        {
          'frontend/src/feed.ts': "import axios from 'axios';\nexport const feed = () => axios.get('https://partners.example.com/feed');\n",
          'backend/artisan': '#!/usr/bin/env php\n<?php\n',
          'backend/app/Http/Controllers/FeedController.php':
            '<?php\nnamespace App\\Http\\Controllers;\nclass FeedController { public function index() {} }\n',
          'backend/routes/web.php': withDomain(false),
        },
        ['frontend', 'backend'],
      );
      init(root);
      mapx(root, 'workspaces', 'add', 'frontend');
      mapx(root, 'workspaces', 'add', 'backend');
    }, 120000);
    afterAll(() => cleanup(root));

    it('re-pairs when a sync adds or removes a route domain, as a full scan does', () => {
      const unpaired = { records: ['https://partners.example.com/feed → null'], edges: [] };
      const paired = {
        records: ['https://partners.example.com/feed → App\\Http\\Controllers\\FeedController@index'],
        edges: ['frontend/src/feed.ts → App\\Http\\Controllers\\FeedController@index'],
      };
      expect(state()).toEqual(unpaired);

      writeFileSync(routesFile(), withDomain(true));
      mapx(root, 'sync', root);
      expect(state()).toEqual(paired);
      mapx(root, 'scan', root, '--force');
      expect(state()).toEqual(paired);

      writeFileSync(routesFile(), withDomain(false));
      mapx(root, 'sync', root);
      expect(state()).toEqual(unpaired);
      mapx(root, 'scan', root, '--force');
      expect(state()).toEqual(unpaired);
    }, 120000);
  });
});

describe('pairing through the scanner', () => {
  let root: string;
  // Records right after the frontend scan, before the backend (and its routes) exists.
  let beforeBackend: HttpCallRecord[];
  beforeAll(() => {
    root = workspace(
      {
        'frontend/.env': 'VITE_API_URL=/api\n',
        'frontend/src/http.ts': "import axios from 'axios';\nexport const http = axios.create({ baseURL: import.meta.env.VITE_API_URL });\n",
        'frontend/src/users.ts': "import { http } from './http';\nexport const list = () => http.get('users');\nexport const show = (id: number) => http.get(`users/${id}`);\nexport const gone = () => http.get('nope');\n",
        'backend/artisan': '#!/usr/bin/env php\n<?php\n',
        'backend/app/Http/Controllers/UserController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass UserController { public function index() {} public function show() {} }\n',
        'backend/routes/api.php': "<?php\nuse App\\Http\\Controllers\\UserController;\nRoute::get('users', [UserController::class, 'index']);\nRoute::get('users/{user}', [UserController::class, 'show']);\n",
      },
      ['frontend', 'backend'],
    );
    init(root);
    // `workspaces add` scans the repo it adds: the frontend is extracted (and paired against no
    // routes) first, then only the backend is scanned. No later scan re-extracts the frontend, so
    // the backend scan itself must re-pair existing records (M2-06-R1: a pair-once mutant fails).
    mapx(root, 'workspaces', 'add', 'frontend');
    beforeBackend = JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as HttpCallRecord[];
    mapx(root, 'workspaces', 'add', 'backend');
  }, 120000);
  afterAll(() => cleanup(root));

  it('pairs calls even when the frontend repo is scanned first', () => {
    expect(beforeBackend.map((r) => `${r.url} → ${r.route ?? null}`)).toEqual(['/api/users → null', '/api/users/{} → null', '/api/nope → null']);
    const records = JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as HttpCallRecord[];
    expect(records.map((r) => `${r.url} → ${r.route?.handlerSymbol ?? null}`)).toEqual([
      '/api/users → App\\Http\\Controllers\\UserController@index',
      '/api/users/{} → App\\Http\\Controllers\\UserController@show',
      '/api/nope → null',
    ]);
  });

  it('stores http edges for paired calls only, targeting the handler', () => {
    const edges = query<{ source_file: string; target_file: string; target_symbol: string; repo: string; metadata: string }>(
      root, "SELECT source_file, target_file, target_symbol, repo, metadata FROM edges WHERE edge_type = 'http' ORDER BY target_symbol",
    );
    expect(edges.map((e) => [e.source_file, e.target_file, e.target_symbol, e.repo])).toEqual([
      ['frontend/src/users.ts', 'backend/app/Http/Controllers/UserController.php', 'App\\Http\\Controllers\\UserController@index', 'frontend'],
      ['frontend/src/users.ts', 'backend/app/Http/Controllers/UserController.php', 'App\\Http\\Controllers\\UserController@show', 'frontend'],
    ]);
    expect(JSON.parse(edges[0]!.metadata)).toMatchObject({ httpVerb: 'GET', uri: '/api/users', route: '/api/users', line: 2 });
  });

  it('lists unmatched calls with routes --clients --unmatched', () => {
    const unmatched = JSON.parse(mapx(root, 'routes', root, '--clients', '--unmatched', '--json')) as HttpCallRecord[];
    expect(unmatched.map((r) => r.url)).toEqual(['/api/nope']);
    expect(mapx(root, 'routes', root, '--clients')).toContain('UNMATCHED');
  });
});

describe('unmatched calls on the M2-02 fixture', () => {
  let work: string;
  beforeAll(() => {
    const fixtures = resolve(__dirname, 'fixtures');
    work = mkdtempSync(join(tmpdir(), 'mapx-http-unmatched-'));
    cpSync(join(fixtures, 'laravel-routes'), join(work, 'backend'), { recursive: true });
    for (const app of readdirSync(join(fixtures, 'vue-http'), { withFileTypes: true }))
      if (app.isDirectory()) cpSync(join(fixtures, 'vue-http', app.name), join(work, `frontend-${app.name}`), { recursive: true });
    init(work);
    const configPath = join(work, '.mapx', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.settings.http = JSON.parse(readFileSync(join(fixtures, 'vue-http', 'http-config.json'), 'utf8')).settings.http;
    writeFileSync(configPath, JSON.stringify(config));
    mapx(work, 'scan', work);
  }, 120000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('reports the unserved and unmounted-route calls as unmatched', () => {
    const unmatched = JSON.parse(mapx(work, 'routes', work, '--clients', '--unmatched', '--json')) as HttpCallRecord[];
    const labelled = unmatched.filter((r) => !r.file.endsWith('apiService.ts')).map((r) => `${r.method} ${r.url}`).sort();
    expect(labelled).toEqual([
      'GET /api/nope/missing', 'GET /api/reports/daily', 'GET /ghost',
      // M2-06-R1: no literal segment (L40, L39), a third-party host (L41), an unknown fetch method (L44)
      'GET /{}', 'GET ?page={}',
      // M2-06-R2: the ops route is served only on ops.example.com (L47)
      'GET https://api.example.com/ops/v3/status',
      // M2-06-R4: only partners-api declares partners.example.com; the backend's route does not serve it (L50)
      'GET https://partners.example.com/api/notices/latest',
      'GET https://status.example.org/api/health', 'UNKNOWN /api/statuses',
    ]);
  });
});
