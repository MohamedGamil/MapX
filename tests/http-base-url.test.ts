import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envCandidates, evaluate, joinURL, parseDotenv } from '../src/frameworks/http/url-resolver.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';

// M2-05: base URLs from literals, constants and .env files, joined with axios semantics.
describe('base URL joining', () => {
  it("follows axios combineURLs: '/api/' + 'x' and '/api/' + '/x' both give /api/x", () => {
    expect(joinURL('/api/', 'x')).toBe('/api/x');
    expect(joinURL('/api/', '/x')).toBe('/api/x');
    expect(joinURL('/api', 'x/')).toBe('/api/x/');
    expect(joinURL('/api', 'https://other.test/x')).toBe('https://other.test/x');
    expect(joinURL(undefined, '/x')).toBe('/x');
  });

  it('reads env values, nearest directory and most specific file first', () => {
    expect(parseDotenv('# c\nVITE_API_URL="/api"\nexport VUE_APP_ROOT_API=/v1 # note\n')).toEqual(
      new Map([['VITE_API_URL', '/api'], ['VUE_APP_ROOT_API', '/v1']]),
    );
    expect(envCandidates('web/src/http.ts').slice(0, 3)).toEqual(['web/src/.env.development.local', 'web/src/.env.development', 'web/src/.env.local']);
    expect(envCandidates('web/src/http.ts')).toContain('web/.env');
    const env = (k: string) => (k === 'VITE_API_URL' ? '/api' : undefined);
    expect(evaluate('import.meta.env.VITE_API_URL', new Map(), env).value).toBe('/api');
    expect(evaluate('process.env.MISSING', new Map(), env).known).toBe(false);
  });
});

describe('base URLs through the scanner', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'web/.env': 'VITE_API_URL=/api/\n',
      'web/src/http.ts': "import axios from 'axios';\nexport const http = axios.create({ baseURL: import.meta.env.VITE_API_URL });\nexport const other = axios.create({ baseURL: process.env.NOT_SET });\n",
      'web/src/use.ts': "import { http, other } from './http';\nhttp.get('/users');\nother.get('things');\nfetch('/raw');\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('joins the env base URL and flags an unresolvable base', () => {
    const records = JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as { rawUrl: string; url?: string; baseURLUnresolved?: boolean }[];
    const byRaw = Object.fromEntries(records.map((r) => [r.rawUrl, r]));
    expect(byRaw["'/users'"]).toMatchObject({ url: '/api/users' });
    expect(byRaw["'things'"]).toMatchObject({ url: 'things', baseURLUnresolved: true });
    expect(byRaw["'/raw'"]).toMatchObject({ url: '/raw' });
    expect(byRaw["'/raw'"]!.baseURLUnresolved).toBeUndefined();
  });
});

// M2-04-R1: env walk and env or unknown prefixes in the request path.
describe('env and prefix defects (M2-04-R1)', () => {
  it('terminates on absolute paths, stops at the root, and uses Vite precedence', () => {
    expect(envCandidates('/abs/x.ts').at(-1)).toBe('/.env.production');
    expect(envCandidates('repo/web/src/a.ts', 'repo/web')).toEqual([
      'repo/web/src/.env.development.local', 'repo/web/src/.env.development', 'repo/web/src/.env.local', 'repo/web/src/.env', 'repo/web/src/.env.production',
      'repo/web/.env.development.local', 'repo/web/.env.development', 'repo/web/.env.local', 'repo/web/.env', 'repo/web/.env.production',
    ]);
  });
});

describe('env and unknown prefixes in the request path through the scanner (M2-04-R1)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'web/.env': 'VITE_API=/v2\n',
      'web/src/a.ts': "fetch(`${import.meta.env.VITE_API}/users`);\nfetch(`${import.meta.env.VITE_UNSET}/api/items`);\nconst API = window.config.api;\nfetch(API + '/orders');\n",
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('uses a defined env prefix and turns an unknown prefix into a suffix match', () => {
    const records = JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as { line: number; url?: string; baseURLUnresolved?: boolean }[];
    expect(records.map((r) => [r.line, r.url, r.baseURLUnresolved ?? false])).toEqual([
      [1, '/v2/users', false],
      [2, '/api/items', true],
      [4, '/orders', true],
    ]);
  });
});
