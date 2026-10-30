import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pairCall, urlSegments } from '../src/frameworks/http/pairing.js';
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

describe('pairing through the scanner', () => {
  let root: string;
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
    // The frontend is registered, and therefore scanned, before the backend.
    mapx(root, 'workspaces', 'add', 'frontend');
    mapx(root, 'workspaces', 'add', 'backend');
    mapx(root, 'scan', '.', '--all');
  }, 120000);
  afterAll(() => cleanup(root));

  it('pairs calls even when the frontend repo is scanned first', () => {
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
    expect(labelled).toEqual(['GET /api/nope/missing', 'GET /api/reports/daily', 'GET /ghost']);
  });
});
