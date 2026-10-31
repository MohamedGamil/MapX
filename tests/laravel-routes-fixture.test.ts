import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normUri, scanFixture, score, type Label, type ReportedRoute, type Score } from '../scripts/eval/score-routes.ts';

// M1-01: Laravel route fixture + scorer. FLOORS only ever rise: each M1 task that improves
// extraction raises them, so a regression on any pattern fails here.
const FIXTURE = resolve(__dirname, 'fixtures/laravel-routes');
const labels = (JSON.parse(readFileSync(resolve(FIXTURE, 'labels.json'), 'utf8')) as { labels: Label[] }).labels;

const FLOORS = {
  // Raised by M1-02 … M1-09 (2026-10-30): every labelled route, handler and parameter name.
  uriRecall: 1,
  handlerRecall: 1,
  precision: 1,
  maxFalsePositives: 0,
  strictParams: true,
  patterns: Object.fromEntries(
    Object.entries(
      labels.reduce<Record<string, Label[]>>((acc, l) => ({ ...acc, [l.pattern]: [...(acc[l.pattern] ?? []), l] }), {}),
    )
      .filter(([, ls]) => ls.some((l) => l.expect === 'live' || l.expect === 'conditional'))
      .map(([name, ls]) => [name, { uriFound: ls.length, handlerFound: ls.filter((l) => l.handler).length }]),
  ) as Record<string, { uriFound: number; handlerFound: number }>,
};

describe('Laravel route fixture labels', () => {
  it('covers every declaration form, mount and negative case with at least 40 labels', () => {
    expect(labels.length).toBeGreaterThanOrEqual(40);
    const patterns = new Set(labels.map((l) => l.pattern));
    for (const p of ['uses-array', 'class-array', 'string-handler', 'controller-group', 'match', 'resource', 'api-resource',
      'dynamic-path', 'closure', 'require-mount', 'provider-mount', 'conditional', 'overridden', 'unmounted',
      // M1-03-R1: lexing (strings, comments, heredocs), brace-less groups, interpolation, provider reachability.
      'string-lexing', 'not-a-route', 'braceless-group', 'legacy-group-mount', 'interpolated-path', 'rsp-mount', 'rsp-unmounted',
      // M1-07-R1: evaluated mount forms, brace-less conditionals, commented-out withRouting.
      'then-mount', 'glob-mount', 'separator-mount', 'module-path', 'braceless-if', 'unmounted-entry',
      // M1-05-R1: resource options arrays, nesting and shallow, Route::resources, action arrays without `uses`.
      'resource-options', 'resource-excluded', 'nested-resource', 'nested-wrong', 'resources-array', 'action-array',
      // M1-05-R2: singletons and route-level prefix keys.
      'singleton', 'singleton-excluded', 'route-prefix', 'route-prefix-wrong',
      // M1-05-R3: implicit binding fields ({post:slug}) reported as {post}.
      'binding-field',
      // M1-07-R2: RouteServiceProvider mounts walked like other providers; evaluated prefixes, names and domains.
      'rsp-glob', 'rsp-require', 'rsp-load-routes-from', 'rsp-variable-mount', 'rsp-dynamic-prefix', 'rsp-property-prefix', 'rsp-raw-prefix',
      // M1-03-R2: require_once and cycles, '/' under a prefix, single-action controllers, a resource
      // name that can't be evaluated, compound and property assignments, a partly dynamic prefix.
      'require-once', 'require-once-wrong', 'require-cycle', 'trailing-slash', 'trailing-slash-overridden', 'invokable',
      'dynamic-resource', 'rsp-compound-assignment', 'rsp-compound-assignment-wrong', 'rsp-property-assignment',
      'rsp-property-assignment-wrong', 'rsp-partly-dynamic'])
      expect(patterns, p).toContain(p);
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
    for (const l of labels) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(l.method);
      expect(l.uri.startsWith('/')).toBe(false);
      if (l.handler !== null) expect(l.handler).toMatch(/^[A-Z]\w+@\w+$/);
      if (l.name !== undefined || l.domain !== undefined || l.dynamic !== undefined) expect(['live', 'conditional']).toContain(l.expect);
    }
    // M1-07-R2: name, domain and dynamic attributes are labelled.
    expect(labels.filter((l) => l.name !== undefined || l.domain !== undefined || l.dynamic !== undefined).length).toBeGreaterThanOrEqual(2);
  });
});

describe('route scorer', () => {
  const L = (p: Partial<Label>): Label => ({ id: 'X', pattern: 'p', method: 'GET', uri: 'a/{id}', handler: 'C@m', expect: 'live', ...p });
  const R = (p: Partial<ReportedRoute>): ReportedRoute => ({ method: 'GET', path: '/a/{slug}', handlerSymbol: 'App\\C@m', ...p });

  it('ignores parameter names unless strict, and matches handlers by short class', () => {
    expect(normUri('/a/{id}/b/')).toBe('a/{}/b');
    expect(normUri('a/{blog-category}', true)).toBe('a/{blog-category}');
    const s = score([L({})], [R({})]);
    expect(s.totals).toMatchObject({ uriFound: 1, handlerFound: 1, exactParams: 0, unlabelled: 0, precision: 1 });
  });

  it('accepts a method set and counts unlabelled live routes against precision', () => {
    const s = score([L({ method: 'POST' })], [R({ method: 'GET|POST' }), R({ path: '/other' })]);
    expect(s.totals.uriFound).toBe(1);
    expect(s.totals.unlabelled).toBe(1);
    expect(s.totals.precision).toBe(0.5);
  });

  it('scores negatives: live losing or unmounted routes are false positives, flagged ones are not', () => {
    const neg = [L({ expect: 'overridden', handler: 'C@old' }), L({ id: 'Y', uri: 'ghost', expect: 'unreachable', handler: 'G@m' })];
    const bad = score(neg, [R({ handlerSymbol: 'C@old' }), R({ path: '/ghost', handlerSymbol: 'G@m' })]);
    expect(bad.totals.falsePositives).toBe(2);
    const good = score(neg, [
      R({ handlerSymbol: 'C@old', metadata: { overridden: true } }),
      R({ path: '/ghost', handlerSymbol: 'G@m', metadata: { reachable: false } }),
    ]);
    expect(good.totals).toMatchObject({ falsePositives: 0, flagged: 2, unlabelled: 0 });
  });

  // Review 2026-10-31: a negative label was credited when its route was not reported at all.
  it('does not credit an overridden or unreachable label whose route is absent', () => {
    const neg = [L({ expect: 'overridden', handler: 'C@old' }), L({ id: 'Y', uri: 'ghost', expect: 'unreachable', handler: 'G@m' })];
    const s = score(neg, []);
    expect(s.totals).toMatchObject({ falsePositives: 0, flagged: 0 });
    expect(s.misses).toHaveLength(2);
    // A flagged route with another handler does not count either.
    expect(score([neg[0]!], [R({ handlerSymbol: 'C@other', metadata: { overridden: true } })]).totals.flagged).toBe(0);
  });

  it('scores absent labels: any reported route is a false positive, live or not', () => {
    const l = L({ expect: 'absent', uri: 'in-comment' });
    expect(score([l], []).totals).toMatchObject({ flagged: 1, falsePositives: 0 });
    expect(score([l], [R({ path: '/in-comment', metadata: { reachable: false } })]).totals).toMatchObject({ flagged: 0, falsePositives: 1 });
  });

  it('M1-07-R2: checks labelled name, domain and dynamic against the matched route', () => {
    const l = L({ name: 'ops.status', domain: 'ops.example.com', dynamic: true });
    expect(score([l], [R({ metadata: { name: 'ops.status', domain: 'ops.example.com', dynamic: true } })]).totals)
      .toMatchObject({ attributesLabelled: 3, attributesFound: 3, attributeRecall: 1 });
    const wrong = score([l], [R({ metadata: { name: 'status' } })]);
    expect(wrong.totals).toMatchObject({ attributesLabelled: 3, attributesFound: 0, attributeRecall: 0 });
    expect(wrong.misses).toHaveLength(3);
    // dynamic: false holds for a route with no dynamic flag; no attribute labels means recall 1.
    expect(score([L({ dynamic: false })], [R({})]).totals.attributesFound).toBe(1);
    expect(score([L({})], [R({})]).totals.attributeRecall).toBe(1);
  });

  it('requires conditional routes to be flagged', () => {
    const l = L({ expect: 'conditional' });
    expect(score([l], [R({})]).totals.flagged).toBe(0);
    expect(score([l], [R({ metadata: { conditional: true } })]).totals.flagged).toBe(1);
  });
});

describe('route extraction on the fixture (real scan)', () => {
  let result: Score;
  beforeAll(() => {
    result = score(labels, scanFixture(FIXTURE), FLOORS.strictParams);
  }, 120000);

  it('does not regress below the recorded floors', () => {
    const t = result.totals;
    expect(t.uriRecall, result.misses.join('\n')).toBeGreaterThanOrEqual(FLOORS.uriRecall);
    expect(t.handlerRecall, result.misses.join('\n')).toBeGreaterThanOrEqual(FLOORS.handlerRecall);
    expect(t.precision, result.unlabelledRoutes.join('\n')).toBeGreaterThanOrEqual(FLOORS.precision);
    expect(t.falsePositives).toBeLessThanOrEqual(FLOORS.maxFalsePositives);
    expect(t.exactParams).toBe(t.uriFound);
    expect(t.attributesFound, result.misses.join('\n')).toBe(t.attributesLabelled);
    expect(t.flagged, 'negatives and conditional mounts flagged').toBe(labels.filter((l) => l.expect !== 'live').length);
    for (const [name, floor] of Object.entries(FLOORS.patterns)) {
      expect(result.patterns[name]!.uriFound, `${name} uri`).toBeGreaterThanOrEqual(floor.uriFound);
      expect(result.patterns[name]!.handlerFound, `${name} handler`).toBeGreaterThanOrEqual(floor.handlerFound);
    }
  });
});
