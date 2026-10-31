import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectConstants, constantsAnywhere, constantsAt, evaluate, expandDotenv, fileBindings, fileConstants, parseDotenv, visibleConstants,
} from '../src/frameworks/http/url-resolver.js';
import { cleanup, init, mapx, workspace } from './helpers/e2e.js';
import { urlBranches } from '../src/frameworks/http/client-calls.js';

// M2-04: request URLs from literals, concatenation, templates and string constants.
describe('URL evaluation', () => {
  it('resolves file-local constants in templates, unknown substitutions become {}', () => {
    const consts = fileConstants("const BASE = 'settings/x';\nconst other = 3;\n");
    expect(evaluate('`${BASE}/${id}`', consts)).toEqual({ value: 'settings/x/{}', known: true });
    expect(evaluate("BASE + '/' + id", consts)).toEqual({ value: 'settings/x/{}', known: true });
    expect(evaluate("'/a/' + user.id + '/b'", consts).value).toBe('/a/{}/b');
  });

  it('resolves constants imported from another module, including aliases', () => {
    const files = [
      { path: 'app/src/api/constants.ts', content: "export const LEGACY = 'legacy/items';\nconst HIDDEN = 'no';\n" },
      { path: 'app/src/svc.ts', content: "import { LEGACY as L, HIDDEN } from '@/api/constants';\n" },
    ];
    const index = collectConstants(files);
    const visible = visibleConstants('app/src/svc.ts', files[1]!.content, index, new Set(files.map((f) => f.path)));
    expect(evaluate('`${L}/${id}`', visible).value).toBe('legacy/items/{}');
    expect(visible.has('HIDDEN')).toBe(false);
  });

  it('resolves each branch of a conditional URL on its own', () => {
    const consts = fileConstants("const U = 'v1/users';");
    expect(urlBranches("admin ? U : 'v1/people'").map((b) => evaluate(b, consts).value)).toEqual(['v1/users', 'v1/people']);
  });

  it('leaves a URL with no literal part unresolved', () => {
    expect(evaluate('url', new Map()).known).toBe(false);
    expect(evaluate('`${url}`', new Map()).known).toBe(false);
  });
});

// M2-04-R1: defects found by the independent M2 review.
describe('URL resolution defects (M2-04-R1)', () => {
  it('only takes literals that are the whole initialiser as constants', () => {
    const consts = fileConstants("const BASE = '/api' + VERSION;\nconst V = 'v1'.toUpperCase();\nconst NEXT = '/n'\n  + suffix;\nconst OK = '/ok';\nconst T = `/t`;\n");
    expect([...consts.keys()]).toEqual(['OK', 'T']);
    expect(evaluate("BASE + '/users'", consts).value).toBe('{}/users');
  });
});

// M2-04-R2: a URL constant resolves to the declaration in scope, or to nothing; .env values are
// read and expanded as Vite reads them.
describe('scoped URL constants (M2-04-R2)', () => {
  /** The constants a call at the `marker` comment sees. */
  const at = (content: string, marker: string, file = 'src/a.js') => constantsAt(fileBindings(file, content), content.indexOf(marker));

  it('resolves two functions declaring `const url` each to its own value', () => {
    const src = [
      "function a() { const url = '/tags'; return api.get(url); /*A*/ }",
      'function b() {',
      "  const url = '/statuses';",
      '  return api.get(url); /*B*/',
      '}',
      "const obj = { c() { const url = '/c'; return api.get(url); /*C*/ }, d() { const url = '/d'; return api.get(url); /*D*/ } };",
    ].join('\n');
    expect(['A', 'B', 'C', 'D'].map((m) => at(src, `/*${m}*/`).get('url'))).toEqual(['/tags', '/statuses', '/c', '/d']);
    expect(at(src, 'const obj').has('url')).toBe(false);
  });

  it('lets an inner declaration shadow a top-level or imported constant, and only inside its scope', () => {
    const src = "const path = '/posts';\nfunction a() { const path = '/health'; return api.get(path); /*A*/ }\nfunction b() { return api.get(path); /*B*/ }\n";
    expect(at(src, '/*A*/').get('path')).toBe('/health');
    expect(at(src, '/*B*/').get('path')).toBe('/posts');
    expect(fileConstants(src)).toEqual(new Map([['path', '/posts']]));
    const files = [
      { path: 'app/src/c.ts', content: "export const LIST = '/list';\n" },
      { path: 'app/src/u.ts', content: "import { LIST } from './c';\nfunction a() { const LIST = '/mine'; return api.get(LIST); /*A*/ }\nfunction b() { return api.get(LIST); /*B*/ }\n" },
    ];
    const index = collectConstants(files);
    const set = new Set(files.map((f) => f.path));
    const content = files[1]!.content;
    expect(visibleConstants('app/src/u.ts', content, index, set, content.indexOf('/*A*/')).get('LIST')).toBe('/mine');
    expect(visibleConstants('app/src/u.ts', content, index, set, content.indexOf('/*B*/')).get('LIST')).toBe('/list');
  });

  it('leaves a name unresolved when the binding in scope has no literal value', () => {
    const src = [
      "const url = '/outer';",
      'function param(url) { return api.get(url); /*P*/ }',
      "function computed() { const url = base + '/x'; return api.get(url); /*C*/ }",
      "function mutable() { let url = '/m'; return api.get(url); /*L*/ }",
      'function destructured(props) { const { url } = props; return api.get(url); /*D*/ }',
      'const arrow = (url) => api.get(url) /*R*/;',
      'const bare = url => api.get(url) /*S*/;',
      'export default { m({ url }) { return api.get(url); /*M*/ }, n(id: number, url: string) { return api.get(url); /*N*/ } };',
      'function outer() { return api.get(url); /*O*/ }',
    ].join('\n');
    for (const m of ['P', 'C', 'L', 'D', 'R', 'S', 'M', 'N']) expect(at(src, `/*${m}*/`, 'src/a.ts').has('url'), m).toBe(false);
    expect(at(src, '/*O*/', 'src/a.ts').get('url')).toBe('/outer');
    expect(evaluate('url', at(src, '/*P*/', 'src/a.ts')).known).toBe(false);
  });

  it('ignores commented-out declarations and declarations in SFC templates', () => {
    expect(fileConstants("// const url = '/old';\n/* const url = '/older'; */\nconst url = '/new';\n").get('url')).toBe('/new');
    const sfc = "<template><p>const url = '/t'</p></template>\n<script>\nfunction f() { const url = '/s'; return api.get(url); /*F*/ }\n</script>\n";
    expect(at(sfc, '/*F*/', 'src/V.vue').get('url')).toBe('/s');
    expect(fileConstants(sfc, 'src/V.vue').has('url')).toBe(false);
  });

  it('treats bindings of one scope that disagree as unknown', () => {
    const sfc = "<script>\nconst url = '/a';\n</script>\n<script setup>\nconst url = '/b';\napi.get(url); /*X*/\n</script>\n";
    expect(at(sfc, '/*X*/', 'src/V.vue').has('url')).toBe(false);
  });

  it('uses a constant from anywhere in the file for a position-less baseURL only when every binding agrees', () => {
    const agree = fileBindings('src/a.js', "function a() { const BASE = '/x'; }\nfunction b() { const BASE = '/x'; }\n");
    const disagree = fileBindings('src/a.js', "function a() { const BASE = '/x'; }\nfunction b(BASE) { }\n");
    expect(constantsAnywhere(agree).get('BASE')).toBe('/x');
    expect(constantsAnywhere(disagree).has('BASE')).toBe(false);
  });
});

describe('dotenv quoting and expansion as Vite reads them (M2-04-R2)', () => {
  const ENV = [
    'VITE_API_URL="/api" # base for the http client',
    "VITE_SINGLE='/single' # c",
    'VITE_HASH=/x#y',
    'VITE_PLAIN=/plain # note',
    'VITE_BILLING=${VITE_API_URL}/billing',
    'VITE_BARE=$VITE_API_URL/bare',
    "VITE_QUOTED_EXPANSION='${VITE_API_URL}/q' # quoted",
    'VITE_DEFAULT=${VITE_NOT_SET:-/fallback}/d',
    'VITE_CHAIN=${VITE_BILLING}/v1',
    'VITE_ESCAPED=\\$VITE_API_URL',
    'VITE_MULTI="a',
    'b"',
    'VITE_EMPTY=',
    // M2-04-R3: nested defaults, as dotenv-expand reads them
    'VITE_DEEP=${VITE_NOPE:-${VITE_NOPE2:-/deep}}',
    'VITE_DEEP_SET=${VITE_NOPE:-${VITE_API_URL}/x}',
    'VITE_DEEP_ALT=${VITE_API_URL:+${VITE_SINGLE}/alt}',
    '',
  ].join('\n');
  const lookup = (vars: Map<string, string>) => (key: string) => vars.get(key);
  const resolveAll = (text: string) => {
    const vars = parseDotenv(text);
    return Object.fromEntries([...vars].map(([k, v]) => [k, expandDotenv(v, lookup(vars), k)]));
  };

  it('strips quotes before a trailing comment and expands ${VAR}', () => {
    const vars = parseDotenv(ENV);
    expect(vars.get('VITE_API_URL')).toBe('/api');
    expect(vars.get('VITE_SINGLE')).toBe('/single');
    expect(vars.get('VITE_HASH')).toBe('/x');
    expect(expandDotenv(vars.get('VITE_BILLING')!, lookup(vars))).toBe('/api/billing');
    expect(expandDotenv(vars.get('VITE_CHAIN')!, lookup(vars))).toBe('/api/billing/v1');
    expect(expandDotenv(vars.get('VITE_DEEP')!, lookup(vars), 'VITE_DEEP')).toBe('/deep');
    expect(expandDotenv(vars.get('VITE_DEEP_SET')!, lookup(vars), 'VITE_DEEP_SET')).toBe('/api/x');
  });

  it('matches Vite loadEnv on the same file', async () => {
    const { loadEnv } = await import('vite');
    const dir = mkdtempSync(join(tmpdir(), 'mapx-dotenv-'));
    try {
      writeFileSync(join(dir, '.env'), ENV);
      // The process env would override file values in Vite; none of these keys may be set.
      expect(Object.keys(process.env).filter((k) => ENV.includes(`${k}=`))).toEqual([]);
      expect(resolveAll(ENV)).toEqual(loadEnv('development', dir, 'VITE_'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a value unknown when it references a variable no env file defines', () => {
    const vars = parseDotenv('A=${UNSET}/x\nB=${A}/y\nC=${UNSET:+/alt}\nD=${D}/self\nE=${UNSET-/e}\n');
    expect(expandDotenv(vars.get('A')!, lookup(vars), 'A')).toBeUndefined();
    expect(expandDotenv(vars.get('B')!, lookup(vars), 'B')).toBeUndefined();
    expect(expandDotenv(vars.get('C')!, lookup(vars), 'C')).toBeUndefined();
    expect(expandDotenv(vars.get('D')!, lookup(vars), 'D')).toBe('/self');
    expect(expandDotenv(vars.get('E')!, lookup(vars), 'E')).toBe('/e');
    expect(expandDotenv('${H X}/x', lookup(vars))).toBeUndefined();
    expect(expandDotenv('${A:=x}/x', lookup(vars))).toBeUndefined();
  });
});

describe('scoped constants and env expansion through the scanner (M2-04-R2)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'web/.env': 'VITE_HOST=/v2\n',
      'web/.env.development': 'VITE_API="${VITE_HOST}/api" # dev\nVITE_LOST=${VITE_UNDEFINED}/lost\n',
      'web/src/a.ts': [
        "import axios from 'axios';",
        'const api = axios.create({ baseURL: import.meta.env.VITE_API });',
        'const lost = axios.create({ baseURL: import.meta.env.VITE_LOST });',
        "const url = '/outer';",
        "export function one() { const url = '/one'; return api.get(url); }",
        "export function two() { const url = '/two'; return api.get(url); }",
        'export function three(url: string) { return api.get(url); }',
        'export function four() { return api.get(url); }',
        "export function five() { return lost.get('/x'); }",
        "export function six() { const BASE = '/fac'; const fac = axios.create({ baseURL: BASE }); return fac.get('/items'); }",
        // M2-04-R3: a top-level BASE, then function-local ones
        "const BASE = '/wrong';",
        "export function seven() { const BASE = '/api/v7'; const c = axios.create({ baseURL: BASE }); return c.get('/z'); }",
        "export function eight(BASE: string) { const d = axios.create({ baseURL: BASE }); return d.get('/q'); }",
        '',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('resolves each call to the constant in its scope, or leaves it unresolved', () => {
    const records = JSON.parse(readFileSync(join(root, '.mapx', 'http-calls.json'), 'utf8')) as Record<string, unknown>[];
    expect(records.map((r) => [r.line, r.url ?? null, r.baseURLUnresolved ?? false])).toEqual([
      [5, '/v2/api/one', false],
      [6, '/v2/api/two', false],
      [7, null, false],
      [8, '/v2/api/outer', false],
      [9, '/x', true],
      // A baseURL constant declared inside a function still resolves when the file agrees on it.
      [10, '/fac/items', false],
      // The local BASE, never the top-level '/wrong'; a parameter BASE leaves the base unresolved.
      [12, '/api/v7/z', false],
      [13, '/q', true],
    ]);
    // The call offset is internal: the D008 record shape is unchanged.
    expect(records.some((r) => 'offset' in r)).toBe(false);
    expect(records.some((r) => 'baseURLAt' in ((r.client ?? {}) as object))).toBe(false);
  });
});
