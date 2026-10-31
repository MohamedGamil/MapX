import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normUrl, scanHttpFixture, scoreHttp, workspacePath, type HttpCallRecord, type HttpLabel, type HttpScore } from '../scripts/eval/score-http.ts';
import { normUri, type Label } from '../scripts/eval/score-routes.ts';

// M2-02: Vue 2.7 / Vue 3 HTTP client fixture, labels and scorer (contract D008). FLOORS only ever
// rise: M2-03 … M2-06 raise them as extraction, URL resolution and pairing land.
const FIXTURE = resolve(__dirname, 'fixtures/vue-http');
const labels = (JSON.parse(readFileSync(resolve(FIXTURE, 'labels.json'), 'utf8')) as { labels: HttpLabel[] }).labels;
const routeLabels = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/laravel-routes/labels.json'), 'utf8')) as { labels: Label[] }).labels;

// Raised by M2-03 (call sites), M2-04/M2-05 (URLs) and M2-06 (pairing).
const FLOORS = { callSiteRecall: 1, urlRecall: 1, pairingRecall: 1, pairingPrecision: 1 };

describe('vue-http fixture labels', () => {
  it('covers every client pattern with at least 30 labels, including unmatched calls', () => {
    expect(labels.length).toBeGreaterThanOrEqual(30);
    const patterns = new Set(labels.map((l) => l.pattern));
    for (const p of ['axios-direct', 'fetch', 'axios-instance', 'factory', 'alias', 'constant-local', 'constant-imported',
      'template', 'split-line', 'conditional', 'env-base', 'configured-receiver', 'unserved', 'overridden-route', 'unmounted-route',
      // M2-04-R2: shadowed constants, a quoted .env value with a comment, ${VAR} expansion
      'constant-scoped', 'env-quoted', 'env-expanded',
      // M2-06-R1: no literal segment, hosts, fetch methods, source dirs named public/, JSX
      'no-literal', 'foreign-host', 'env-host', 'fetch-method', 'source-dir', 'jsx'])
      expect(patterns, p).toContain(p);
    expect(labels.filter((l) => l.route === null).length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
  });

  it('names the expected handler of every routed label (M2-06-R1)', () => {
    for (const l of labels.filter((x) => x.route)) expect(l.handler, l.id).not.toBeUndefined();
    expect(labels.find((l) => l.id === 'L08')?.handler).toBe('PostController@newDup');
  });

  it('points every label at a marked line of an existing file', () => {
    for (const l of labels) {
      const lines = readFileSync(resolve(FIXTURE, l.file), 'utf8').split('\n');
      expect(lines[l.line - 1], l.id).toContain(l.id);
    }
  });

  it('pairs only with live routes of the Laravel fixture', () => {
    const live = new Set(
      routeLabels.filter((r) => r.expect === 'live' || r.expect === 'conditional').map((r) => `${r.method} ${normUri(r.uri)}`),
    );
    for (const l of labels.filter((x) => x.route)) {
      const [method, path] = l.route!.split(' ');
      expect(live, `${l.id} ${l.route}`).toContain(`${method} ${normUri(path!)}`);
    }
    // Negatives: the unmounted route is not live, and unserved URLs match no route at all.
    expect(live).not.toContain('GET ghost');
  });
});

describe('http scorer', () => {
  const L = (p: Partial<HttpLabel>): HttpLabel => ({ id: 'X', pattern: 'p', file: 'vue2/src/a.js', line: 10, method: 'GET', url: '/api/a/{}', route: 'GET /api/a/{id}', ...p });
  const R = (p: Partial<HttpCallRecord>): HttpCallRecord => ({ file: 'frontend-vue2/src/a.js', line: 10, method: 'GET', rawUrl: 'a', url: '/api/a/{x}', route: { method: 'GET', path: '/api/a/{slug}', handlerFile: 'c.php' }, ...p });

  it('normalises URLs and maps fixture paths into the workspace', () => {
    expect(normUrl('api/a/${id}/')).toBe('/api/a/{}');
    expect(normUrl('https://example.test/api/a/{x}')).toBe('/api/a/{}');
    expect(workspacePath('vue3/src/x.ts')).toBe('frontend-vue3/src/x.ts');
  });

  it('scores a correct pair, treating {id} and {slug} alike', () => {
    expect(scoreHttp([L({})], [R({})]).totals).toMatchObject({ found: 1, urlResolved: 1, pairedCorrect: 1, wrongPairs: 0, pairingPrecision: 1 });
  });

  it('counts a pair on a label expecting no route as wrong', () => {
    const s = scoreHttp([L({ route: null })], [R({})]);
    expect(s.totals).toMatchObject({ wrongPairs: 1, unmatchedCorrect: 0, pairingPrecision: 0 });
  });

  it('matches by file, method and the exact call line only', () => {
    expect(scoreHttp([L({})], [R({ line: 11 })]).totals.found).toBe(0);
    expect(scoreHttp([L({})], [R({ method: 'POST' })]).totals.found).toBe(0);
    expect(scoreHttp([L({})], [R({ file: 'frontend-vue3/src/a.js' })]).totals.found).toBe(0);
    expect(scoreHttp([L({})], [R({})]).totals.found).toBe(1);
  });

  it('gives two labels on one line (conditional URL) one record each, never a neighbour', () => {
    const labels = [L({ id: 'A', url: '/api/a' }), L({ id: 'B', url: '/api/b' }), L({ id: 'C', line: 11, url: '/api/c' })];
    const s = scoreHttp(labels, [R({ url: '/api/a' }), R({ line: 11, url: '/api/c' })]);
    expect(s.totals.found).toBe(2);
    expect(s.misses.some((m) => m.startsWith('B '))).toBe(true);
  });

  it('treats no records as zero recall, not an error', () => {
    const s = scoreHttp([L({}), L({ id: 'Y', route: null })], []);
    expect(s.totals).toMatchObject({ callSiteRecall: 0, pairingRecall: 0, pairingPrecision: 1 });
  });

  it('counts the right route with the wrong handler as a wrong pair (M2-06-R1)', () => {
    const route = (handlerSymbol?: string) => ({ method: 'GET', path: '/api/a/{slug}', handlerFile: 'c.php', ...(handlerSymbol ? { handlerSymbol } : {}) });
    const label = L({ handler: 'PostController@show' });
    expect(scoreHttp([label], [R({ route: route('App\\Http\\Controllers\\PostController@show') })]).totals).toMatchObject({ pairedCorrect: 1, wrongPairs: 0 });
    const wrong = scoreHttp([label], [R({ route: route('App\\Http\\Controllers\\OldController@show') })]);
    expect(wrong.totals).toMatchObject({ pairedCorrect: 0, wrongPairs: 1, pairingPrecision: 0 });
    expect(wrong.misses[0]).toContain('OldController@show');
    // A closure route has no handler symbol: the label says null.
    expect(scoreHttp([L({ handler: null })], [R({ route: route() })]).totals.pairedCorrect).toBe(1);
    expect(scoreHttp([L({ handler: null })], [R({ route: route('X@y') })]).totals.wrongPairs).toBe(1);
  });
});

// M2-03 AC2, proven before only by a unit test and a manual run: without the fixture's
// settings.http, exactly the two configured-receiver calls disappear from a real scan.
describe('configured receivers on the fixture (M2-03 AC2, real scan)', () => {
  it('drops exactly L28 and L29 when apiService is not configured', () => {
    const s = scoreHttp(labels, scanHttpFixture(FIXTURE, { config: false }));
    expect(s.misses.filter((m) => m.endsWith('not extracted')).map((m) => m.split(' ')[0])).toEqual(['L28', 'L29']);
    expect(s.totals.found).toBe(labels.length - 2);
  }, 120000);
});

describe('http pairing on the fixture (real scan)', () => {
  let result: HttpScore;
  beforeAll(() => {
    result = scoreHttp(labels, scanHttpFixture(FIXTURE));
  }, 120000);

  it('does not regress below the recorded floors', () => {
    const t = result.totals;
    expect(t.callSiteRecall, result.misses.join('\n')).toBeGreaterThanOrEqual(FLOORS.callSiteRecall);
    expect(t.urlRecall).toBeGreaterThanOrEqual(FLOORS.urlRecall);
    expect(t.pairingRecall).toBeGreaterThanOrEqual(FLOORS.pairingRecall);
    expect(t.pairingPrecision).toBeGreaterThanOrEqual(FLOORS.pairingPrecision);
  });

  it('builds the workspace from the shared Laravel fixture', () => {
    expect(existsSync(resolve(__dirname, 'fixtures/laravel-routes/routes/api.php'))).toBe(true);
  });
});
