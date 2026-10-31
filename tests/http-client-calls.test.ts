import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { collectProviders, extractHttpCalls, urlBranches, callArguments } from '../src/frameworks/http/client-calls.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// M2-03: HTTP client call-site extraction (D008).
const extract = (files: Record<string, string>, file: string, clients: { receiver: string; baseURL?: string }[] = []) => {
  const list = Object.entries(files).map(([path, content]) => ({ path, content }));
  return extractHttpCalls(file, files[file]!, { providers: collectProviders(list), files: new Set(Object.keys(files)), clients });
};

describe('HTTP call-site extraction', () => {
  it('finds axios, instances, factories, aliases and fetch with their methods', () => {
    const files = {
      'app/src/api/Api.js': "import axios from 'axios';\nexport default () => axios.create({ baseURL: process.env.VUE_APP_ROOT_API });\n",
      'app/src/http.ts': "import axios from 'axios';\nexport const http = axios.create({ baseURL: '/api', timeout: 5 });\n",
      'app/src/use.js': [
        "import axios from 'axios';",
        "import Api from '@/api/Api';",
        "import { http as client } from './http';",
        'const api = Api();',
        "axios.get('/a');",
        "Api().post('b', {});",
        "api.delete(`c/${id}`);",
        "client.patch('d');",
        "fetch('/e', { method: 'PUT' });",
        "window.fetch('/f');",
      ].join('\n'),
    };
    const calls = extract(files, 'app/src/use.js');
    expect(calls.map((c) => `${c.line} ${c.method} ${c.rawUrl} ${c.client.kind}`)).toEqual([
      "5 GET '/a' axios",
      "6 POST 'b' factory",
      '7 DELETE `c/${id}` factory',
      "8 PATCH 'd' instance",
      "9 PUT '/e' fetch",
      "10 GET '/f' fetch",
    ]);
    expect(calls.find((c) => c.method === 'PATCH')!.client).toMatchObject({ baseURL: "'/api'", definedIn: 'app/src/http.ts' });
    expect(calls.find((c) => c.method === 'POST')!.client.baseURL).toBe('process.env.VUE_APP_ROOT_API');
  });

  it('ignores member calls on objects that are not HTTP clients', () => {
    const files = {
      'src/x.ts': "const map = new Map();\nmap.get('x');\nstore.get('k');\nthis.http.get('/nope');\nconst cache = { get: (k) => k };\ncache.get('y');\n",
    };
    expect(extract(files, 'src/x.ts')).toEqual([]);
  });

  it('extracts a configured receiver only when configured', () => {
    const files = { 'src/v.vue': "<script setup>\nimport { apiService } from './apiService';\nconst a = await apiService.get('billing/v1/invoices');\n</script>\n" };
    expect(extract(files, 'src/v.vue')).toEqual([]);
    const calls = extract(files, 'src/v.vue', [{ receiver: 'apiService', baseURL: '/api' }]);
    expect(calls).toEqual([{ file: 'src/v.vue', line: 3, method: 'GET', rawUrl: "'billing/v1/invoices'", client: { kind: 'configured', name: 'apiService', baseURL: "'/api'" },
      offset: files['src/v.vue'].indexOf('apiService.get') }]);
  });

  it('splits conditional URLs into one call site per branch and keeps split-line arguments', () => {
    expect(urlBranches("admin ? 'v1/users' : 'v1/people'")).toEqual(["'v1/users'", "'v1/people'"]);
    expect(urlBranches("a ? 'x' : b ? 'y' : 'z'")).toEqual(["'x'", "'y'", "'z'"]);
    expect(urlBranches('user?.id')).toEqual(['user?.id']);
    expect(callArguments("get(\n  'v1/users',\n  { a: (1, 2) }\n)", 3)).toEqual(["'v1/users'", '{ a: (1, 2) }']);
  });
});

describe('http-calls.json through the scanner', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'web/src/http.ts': "import axios from 'axios';\nexport const http = axios.create({ baseURL: '/api' });\n",
      'web/src/users.ts': "import { http } from './http';\nexport const list = () => http.get('users');\n",
    });
    init(root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('writes records and stays identical on a re-scan', () => {
    mapx(root, 'scan', root);
    const first = readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8');
    mapx(root, 'scan', root, '--force');
    const second = readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8');
    expect(JSON.parse(first)).toEqual([
      { file: 'web/src/users.ts', line: 2, method: 'GET', rawUrl: "'users'", url: '/api/users', client: { kind: 'instance', name: 'http', baseURL: "'/api'", definedIn: 'web/src/http.ts' }, route: null },
    ]);
    expect(second).toBe(first);
  });
});

// M2-03-R1: defects found by the independent M2 review.
describe('extraction defects (M2-03-R1)', () => {
  it('recognises a global window.axios and a required axios', () => {
    const files = {
      'resources/js/bootstrap.js': "window.axios = require('axios');\n",
      'resources/js/a.js': "export function load() { return axios.get('/a'); }\nwindow.axios.post('/b');\n",
      'resources/js/c.js': "const http = require('axios');\nhttp.delete('/c');\n",
    };
    expect(extract(files, 'resources/js/a.js').map((c) => `${c.method} ${c.rawUrl}`)).toEqual(["GET '/a'", "POST '/b'"]);
    expect(extract(files, 'resources/js/c.js').map((c) => `${c.method} ${c.rawUrl}`)).toEqual(["DELETE '/c'"]);
  });

  it('ignores calls inside comments, strings and SFC templates', () => {
    const files = {
      'src/x.js': "import axios from 'axios';\n// axios.get('/old');\n/* axios.delete('/x') */\nconst help = \"use axios.post('/docs') to call\";\nconst t = `axios.put('/t')`;\naxios.get('/real');\n",
      'src/v.vue': "<template><button @click=\"fetch(x)\">axios.get('/tpl')</button></template>\n<script>\nimport axios from 'axios';\nexport default { methods: { go() { return axios.get('/go'); } } };\n</script>\n",
    };
    expect(extract(files, 'src/x.js').map((c) => c.rawUrl)).toEqual(["'/real'"]);
    expect(extract(files, 'src/v.vue').map((c) => c.rawUrl)).toEqual(["'/go'"]);
  });

  it('keeps calls whose arguments contain a comment with a quote or a regex literal', () => {
    const files = { 'src/y.js': "import axios from 'axios';\naxios.get('/api/a', // don't cache\n  {});\naxios.get(u.replace(/'/g, ''));\naxios.post(`/b/${id}`, { re: /[/']/ });\n" };
    expect(extract(files, 'src/y.js').map((c) => `${c.line} ${c.rawUrl}`)).toEqual([
      "2 '/api/a'",
      "4 u.replace(/'/g, '')",
      '5 `/b/${id}`',
    ]);
  });

  it('does not record fetch method or function definitions as calls', () => {
    const files = { 'src/z.ts': "export default {\n  async fetch(id) { return id; },\n  fetch2() {},\n};\nfunction fetch(url) { return url; }\nclass S { fetch(x: string): Promise<void> { return x as any; } }\nfetch('/real');\n" };
    expect(extract(files, 'src/z.ts').map((c) => `${c.line} ${c.rawUrl}`)).toEqual(["7 '/real'"]);
  });
});

describe('deleted files lose their records (M2-03-R1)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'web/src/a.ts': "fetch('/a');\n",
      'web/src/b.ts': "fetch('/b');\n",
    }, ['web']);
    execFileSync('git', ['-C', join(root, 'web'), 'add', '.']);
    execFileSync('git', ['-C', join(root, 'web'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    init(root);
    mapx(root, 'workspaces', 'add', 'web');
    mapx(root, 'scan', '.', '--all');
  }, 120000);
  afterAll(() => cleanup(root));

  it('drops the records of a file deleted before a re-scan', () => {
    const read = () => (JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as { file: string }[]).map((r) => r.file);
    expect(read()).toEqual(['web/src/a.ts', 'web/src/b.ts']);
    rmSync(join(root, 'web/src/b.ts'));
    mapx(root, 'scan', '.', '--all');
    expect(read()).toEqual(['web/src/a.ts']);
  });
});
