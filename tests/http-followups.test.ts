import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectProviders, extractHttpCalls, HTTP_SKIP, urlBranches } from '../src/frameworks/http/client-calls.js';
import { evaluate, fileConstants } from '../src/frameworks/http/url-resolver.js';
import { pairCall } from '../src/frameworks/http/pairing.js';
import { MapxGraph } from '../src/core/graph.js';
import type { RouteBinding } from '../src/types.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M2-07: the P2 findings of the independent M2 review.
const extract = (files: Record<string, string>, file: string) => {
  const list = Object.entries(files).map(([path, content]) => ({ path, content }));
  return extractHttpCalls(file, files[file]!, { providers: collectProviders(list), files: new Set(Object.keys(files)) });
};

describe('URL expressions', () => {
  it('splits nested ternaries in the consequent and the alternate', () => {
    expect(urlBranches("a ? b ? '/x' : '/y' : '/z'")).toEqual(["'/x'", "'/y'", "'/z'"]);
    expect(urlBranches("a ? '/x' : b ? '/y' : '/z'")).toEqual(["'/x'", "'/y'", "'/z'"]);
    expect(urlBranches("url ?? '/x'")).toEqual(["url ?? '/x'"]);
  });

  it('resolves nested templates, parenthesised parts and multi-declarator constants', () => {
    expect(evaluate('`/api/${t ? `x` : `y`}/list`', new Map())).toEqual({ value: '/api/{}/list', known: true });
    expect(evaluate("('/api/' + id)", new Map()).value).toBe('/api/{}');
    expect(evaluate("('/api/' + (id)) + '/x'", new Map()).value).toBe('/api/{}/x');
    const consts = fileConstants("const A = '/a', B = '/b';\nfunction f(c = '/no', d = '/no') {}\n");
    expect([...consts.entries()]).toEqual([['A', '/a'], ['B', '/b']]);
  });
});

describe('client providers', () => {
  it('recognises async and block-bodied factories, re-exports and namespace imports', () => {
    const files = {
      'src/a.ts': "import axios from 'axios';\nexport async function makeApi() { return axios.create({ baseURL: '/a' }); }\n",
      'src/b.ts': "import axios from 'axios';\nexport const makeB = () => { return axios.create({ baseURL: '/b' }); };\n",
      'src/http.ts': "import axios from 'axios';\nconst http = axios.create({ baseURL: '/h' });\nexport default http;\n",
      'src/index.ts': "export { default as http } from './http';\n",
      'src/use.ts': [
        "import * as ax from 'axios';",
        "import { makeApi } from './a';",
        "import { makeB } from './b';",
        "import { http } from './index';",
        "ax.get('/ns');",
        "makeApi().get('x');",
        "makeB().post('y');",
        "http.delete('z');",
      ].join('\n'),
    };
    expect(extract(files, 'src/use.ts').map((c) => `${c.method} ${c.rawUrl} ${c.client.baseURL ?? '-'}`)).toEqual([
      "GET '/ns' -",
      "GET 'x' '/a'",
      "POST 'y' '/b'",
      "DELETE 'z' '/h'",
    ]);
  });
});

describe('pairing ties', () => {
  const route = (path: string, handlerFile: string): RouteBinding => ({ framework: 'laravel', method: 'GET', path, handlerFile, handlerSymbol: `${handlerFile}@x` });
  it('picks the same route whatever the routes.json order', () => {
    const routes = [route('/api/users/{id}', 'z.php'), route('/api/users/{id}', 'a.php'), route('/admin/users/{id}', 'm.php')];
    const call = { file: 'w.ts', line: 1, method: 'GET', rawUrl: "'x'", url: '/api/users/{}', client: { kind: 'axios' as const, name: 'axios' } };
    expect(pairCall(call, routes)?.handlerFile).toBe('a.php');
    expect(pairCall(call, [...routes].reverse())?.handlerFile).toBe('a.php');
    const suffix = { ...call, url: 'users/{}', baseURLUnresolved: true };
    expect(pairCall(suffix, routes)?.path).toBe(pairCall(suffix, [...routes].reverse())?.path);
  });
});

describe('graph http edges', () => {
  it('keeps calls to different actions of one controller as distinct edges', () => {
    const graph = new MapxGraph('t');
    graph.addFileNode('web/a.ts', 'typescript', 1, 1);
    graph.addFileNode('app/C.php', 'php', 1, 1);
    for (const target of ['C@index', 'C@show'])
      graph.addDependencyEdge({ sourceFile: 'web/a.ts', targetFile: 'app/C.php', sourceSymbol: null, targetSymbol: target, edgeType: 'http', repo: 't', weight: 1 } as any);
    expect((graph as any).graph.size).toBe(2);
  });
});

describe('large bundles', () => {
  it('extracts 6,000 calls from a 3 MB single-line file in linear time', () => {
    const call = "axios.get('/api/items/' + id);";
    const make = (n: number) => `import axios from 'axios';` + Array.from({ length: n }, (_, i) => `function f${i}(id){${call}var pad${i}='${'x'.repeat(440)}';}`).join('');
    const time = (n: number) => {
      const body = make(n);
      const start = performance.now();
      const calls = extract({ 'src/big.js': body }, 'src/big.js');
      expect(calls).toHaveLength(n);
      return { ms: performance.now() - start, size: body.length };
    };
    time(600); // warm-up (JIT, regex compilation)
    const small = time(600);
    const big = time(6000);
    expect(big.size).toBeGreaterThan(3_000_000);
    // 10x the input must cost far less than the ~100x a quadratic line lookup did; absolute
    // ceiling is generous because the full suite runs files in parallel.
    expect(big.ms / Math.max(small.ms, 1)).toBeLessThan(30);
    expect(big.ms).toBeLessThan(5000);
  });

  it('skips built and vendored bundles', () => {
    for (const p of ['public/js/app.js', 'backend/public/js/app.js', 'web/dist/assets/index.js', 'src/lib.min.js', 'node_modules/x/index.js'])
      expect(HTTP_SKIP.test(p), p).toBe(true);
    expect(HTTP_SKIP.test('resources/js/app.js')).toBe(false);
  });
});

describe('env-only edits refresh records', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'web/.env': 'VITE_API=/v1\n',
      'web/src/a.ts': "fetch(`${import.meta.env.VITE_API}/users`);\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('re-resolves URLs after only .env changed', () => {
    const url = () => (JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as { url: string }[])[0]!.url;
    expect(url()).toBe('/v1/users');
    writeFileSync(join(root, 'web/.env'), 'VITE_API=/v2\n');
    mapx(root, 'sync', root);
    expect(url()).toBe('/v2/users');
  });
});

// Review 2026-10-31 (post-acceptance defect): when the last HTTP record disappeared, pairing
// returned before clearing, so the old `http` edges stayed in the store.
describe('http edges follow the records', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'frontend/src/svc.js': "export const a = () => apiService.get('/api/users');\n",
      'backend/artisan': '#!/usr/bin/env php\n<?php\n',
      'backend/app/Http/Controllers/UserController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass UserController { public function index() {} }\n',
      'backend/routes/api.php': "<?php\nuse App\\Http\\Controllers\\UserController;\nRoute::get('users', [UserController::class, 'index']);\n",
    }, ['frontend', 'backend']);
    init(root);
    mapx(root, 'workspaces', 'add', 'frontend');
    mapx(root, 'workspaces', 'add', 'backend');
  }, 90000);
  afterAll(() => cleanup(root));

  it('removes http edges when no call is left', () => {
    const configPath = join(root, '.mapx', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.settings.http = { clients: [{ receiver: 'apiService' }] };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    mapx(root, 'scan', root, '--all');
    const httpEdges = () => query<{ target_symbol: string }>(root, "SELECT target_symbol FROM edges WHERE edge_type = 'http'").map((e) => e.target_symbol);
    expect(httpEdges()).toEqual(['App\\Http\\Controllers\\UserController@index']);
    delete config.settings.http;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    mapx(root, 'scan', root, '--all');
    expect(httpEdges()).toEqual([]);
  });
});
