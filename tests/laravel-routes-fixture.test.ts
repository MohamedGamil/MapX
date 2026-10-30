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
      'dynamic-path', 'closure', 'require-mount', 'provider-mount', 'conditional', 'overridden', 'unmounted'])
      expect(patterns, p).toContain(p);
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
    for (const l of labels) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(l.method);
      expect(l.uri.startsWith('/')).toBe(false);
      if (l.handler !== null) expect(l.handler).toMatch(/^[A-Z]\w+@\w+$/);
    }
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
    expect(t.flagged, 'negatives and conditional mounts flagged').toBe(labels.filter((l) => l.expect !== 'live').length);
    for (const [name, floor] of Object.entries(FLOORS.patterns)) {
      expect(result.patterns[name]!.uriFound, `${name} uri`).toBeGreaterThanOrEqual(floor.uriFound);
      expect(result.patterns[name]!.handlerFound, `${name} handler`).toBeGreaterThanOrEqual(floor.handlerFound);
    }
  });
});
