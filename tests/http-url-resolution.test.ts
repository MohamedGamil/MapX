import { describe, it, expect } from 'vitest';
import { collectConstants, evaluate, fileConstants, visibleConstants } from '../src/frameworks/http/url-resolver.js';
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
