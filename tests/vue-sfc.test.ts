import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  loadExpected, parseArgs, parseThresholds, scanEdgeFixture, scoreEdges, thresholdFailures,
  type EdgeLabel, type EdgeScore, type StoredEdge, type StoredSymbol,
} from '../scripts/eval/score-edges.ts';
import { findNestedManifestScopes } from '../src/frameworks/utils.ts';
import { ignoredSymbolsForFile } from '../src/parsers/ignored-symbols.ts';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.ts';

// M3-01: Vue SFC edge fixture + scorer (contract: docs/baton/iterations/M3-01.md, "Edge contract").
// FLOORS only ever rise: each of M3-02 … M3-06 raises the patterns it implements (ideally to their
// labelled count, see `labelledCount`) and lowers the false positives it removes.
const FIXTURE = resolve(__dirname, 'fixtures/vue-sfc');
const expected = loadExpected(FIXTURE);
const labels = expected.labels;

const PATTERNS = [
  'template-handler', 'template-binding-call', 'component-local', 'component-global', 'v-model-component',
  'options-this-call', 'mixin-method', 'script-setup-macro', 'script-setup-call', 'component-symbol', 'composable',
  'vuex-map-helpers', 'vuex-dispatch', 'pinia', 'router',
] as const;
type Pattern = (typeof PATTERNS)[number];

const labelledCount = (pattern: Pattern) => labels.filter((l) => l.pattern === pattern && l.expect !== 'absent').length;

const FLOORS: {
  /** Minimum found (edges + symbols) per pattern. Baseline 2026-10-31 (M3-01). */
  found: Record<Pattern, number>;
  /** Maximum false positives (negatives that exist) per pattern; omitted = 0. */
  falsePositives: Partial<Record<Pattern, number>>;
  minPrecision: number;
} = {
  found: {
    'template-handler': labelledCount('template-handler'), // M3-02
    'template-binding-call': labelledCount('template-binding-call'), // M3-02
    'component-local': labelledCount('component-local'), // M3-02
    'component-global': labelledCount('component-global'), // M3-02
    'v-model-component': labelledCount('v-model-component'), // M3-02
    'component-symbol': labelledCount('component-symbol'), // M3-02
    'options-this-call': labelledCount('options-this-call'), // already works (same-file this.x())
    'mixin-method': labelledCount('mixin-method'), // M3-03: through the component's own mixins array
    'script-setup-macro': 0, // M3-04
    'script-setup-call': labelledCount('script-setup-call'), // already works (local emit constant)
    // M3-02: setup-level useX() calls owned by the component (rule 2) and {{ format() }} (rule 4). Still by unique
    // name: persist, addReply (script calls to destructured composable functions, M3-04).
    composable: labelledCount('composable'),
    'vuex-map-helpers': 2, // M3-05 (both `created` calls; vue2's picks tickets' FETCH_ALL by name, not by namespace)
    'vuex-dispatch': 0, // M3-05
    pinia: 0, // M3-05
    router: 0, // M3-06
  },
  falsePositives: {
    composable: 1, // generic: formatter.format() inside format() resolves to itself
    pinia: 2, // M3-05: session.touch() → presence store; cart.checkout() → CartView's own checkout()
  },
  /** Baseline 0.625 (15/24, M3-01); 0.708 (17/24) after M3-03; 0.957 (66/69) after M3-02. */
  minPrecision: 0.9,
};

const ALLOWED_EDGE_TYPES = new Set(expected.scoredTypes ?? []);
const read = (file: string) => readFileSync(resolve(FIXTURE, file), 'utf8');
const componentName = (file: string) => basename(file, '.vue');
/** A label symbol is a .vue file's component symbol, or an identifier written in that file. */
function symbolIsReal(file: string, symbol: string | null) {
  if (symbol === null) return false;
  if (file.endsWith('.vue') && symbol === componentName(file)) return true;
  return new RegExp(`\\b${symbol.replace(/[$]/g, '\\$')}\\b`).test(read(file));
}

describe('Vue SFC fixture labels', () => {
  const positives = labels.filter((l) => l.expect !== 'absent' && l.edge);
  const negatives = labels.filter((l) => l.expect === 'absent');

  it('has at least 30 positive edges and 3 negatives, with unique ids', () => {
    expect(positives.length).toBeGreaterThanOrEqual(30);
    expect(negatives.length).toBeGreaterThanOrEqual(3);
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
  });

  it('covers every pattern in both Vue 2.7 and Vue 3.x', () => {
    expect(new Set(labels.map((l) => l.pattern))).toEqual(new Set(PATTERNS));
    for (const p of PATTERNS)
      for (const version of ['vue2', 'vue3'])
        expect(labels.some((l) => l.pattern === p && l.version === version && l.expect !== 'absent'), `${p} ${version}`).toBe(true);
  });

  it('every label is well-formed and points at existing files and symbol names', () => {
    expect(expected.roots).toEqual(['vue2', 'vue3']);
    for (const l of labels) {
      expect(['vue2', 'vue3'], l.id).toContain(l.version);
      expect([undefined, 'present', 'absent'], `${l.id} expect`).toContain(l.expect);
      expect(Boolean(l.edge) !== Boolean(l.symbol), `${l.id}: exactly one of edge or symbol`).toBe(true);
      if (l.symbol) {
        expect(l.expect, `${l.id}: symbol labels are positive`).not.toBe('absent');
        expect(l.symbol.file.startsWith(`${l.version}/`), l.id).toBe(true);
        expect(existsSync(resolve(FIXTURE, l.symbol.file)), `${l.id} ${l.symbol.file}`).toBe(true);
        expect(l.symbol.name, l.id).toBe(componentName(l.symbol.file));
        expect(l.symbol.kind, l.id).toBe('class');
        for (const values of Object.values(l.symbol.metadata ?? {}))
          for (const v of values) expect(read(l.symbol.file), `${l.id} ${v}`).toContain(v);
        continue;
      }
      const e = l.edge!;
      expect(ALLOWED_EDGE_TYPES.has(e.edge_type), `${l.id} ${e.edge_type}`).toBe(true);
      for (const [file, symbol] of [[e.source_file, e.source_symbol], [e.target_file, e.target_symbol]] as const) {
        expect(file.startsWith(`${l.version}/src/`), `${l.id} ${file}`).toBe(true);
        expect(existsSync(resolve(FIXTURE, file)), `${l.id} ${file}`).toBe(true);
        expect(symbolIsReal(file, symbol), `${l.id} ${file}#${symbol}`).toBe(true);
      }
      // Contract: render and route edges end at a component symbol.
      if (e.edge_type !== 'call') expect(e.target_symbol, l.id).toBe(componentName(e.target_file));
    }
  });

  it('no edge is labelled twice, or both positive and negative', () => {
    const key = (e: StoredEdge) => JSON.stringify(e);
    const pos = positives.map((l) => key(l.edge!));
    expect(new Set(pos).size, 'duplicate positive edge').toBe(pos.length);
    const neg = negatives.map((l) => key(l.edge!));
    expect(new Set(neg).size, 'duplicate negative edge').toBe(neg.length);
    for (const n of negatives) expect(pos.includes(key(n.edge!)), n.id).toBe(false);
  });
});

describe('edge scorer', () => {
  const E = (p: Partial<StoredEdge> = {}): StoredEdge => ({
    source_file: 'v/src/A.vue', source_symbol: 'A', target_file: 'v/src/A.vue', target_symbol: 'save', edge_type: 'call', ...p,
  });
  const L = (p: Partial<EdgeLabel> = {}): EdgeLabel => ({ id: 'X', pattern: 'p', version: 'v', edge: E(), ...p });

  it('matches edge type and both symbols exactly, files by path', () => {
    expect(scoreEdges([L()], [E({ source_file: './v/src/A.vue' })]).totals).toMatchObject({ found: 1, recall: 1, precision: 1 });
    expect(scoreEdges([L()], [E({ edge_type: 'render' })]).totals.found).toBe(0);
    expect(scoreEdges([L()], [E({ target_symbol: 'methods.save' })]).totals.found).toBe(0);
    expect(scoreEdges([L()], [E({ source_symbol: null })]).totals.found).toBe(0);
    expect(scoreEdges([L()], [E({ target_file: 'v/src/B.vue' })]).totals.found).toBe(0);
  });

  it('counts an existing negative as a false positive and not as correct', () => {
    const neg = L({ id: 'N', expect: 'absent', edge: E({ target_file: 'v/src/B.vue' }) });
    const s = scoreEdges([L(), neg], [E(), E({ target_file: 'v/src/B.vue' })]);
    expect(s.totals).toMatchObject({ found: 1, negatives: 1, falsePositives: 1, reported: 2, correct: 1, unlabelled: 0, precision: 0.5 });
    expect(s.falsePositiveEdges).toHaveLength(1);
    expect(scoreEdges([neg], []).totals).toMatchObject({ falsePositives: 0, negatives: 1, labelled: 0, recall: 1 });
  });

  it('ignores unscored edge types for precision and counts unlabelled scored edges against it', () => {
    const s = scoreEdges([L()], [E(), E({ edge_type: 'import', target_symbol: './B.vue' }), E({ target_symbol: 'load' })]);
    expect(s.totals).toMatchObject({ reported: 2, correct: 1, unlabelled: 1, precision: 0.5 });
    expect(s.unlabelledEdges).toEqual(['v/src/A.vue#A -call-> v/src/A.vue#load']);
    // Scored types come from the fixture: with only `render` scored, the call edges do not count.
    expect(scoreEdges([], [E()], [], ['render']).totals).toMatchObject({ reported: 0, precision: 1 });
  });

  it('de-duplicates repeated edges', () => {
    expect(scoreEdges([L()], [E(), E(), E()]).totals).toMatchObject({ reported: 1, correct: 1, precision: 1 });
  });

  it('matches symbol labels by file, name, kind and a metadata subset', () => {
    const sym = (metadata: Record<string, unknown>): StoredSymbol => ({ file_path: 'v/src/A.vue', name: 'A', kind: 'class', scope: null, metadata });
    const label = L({ edge: undefined, symbol: { file: 'v/src/A.vue', name: 'A', kind: 'class', metadata: { props: ['id'] } } });
    expect(scoreEdges([label], [], [sym({ props: ['id', 'name'] })]).totals.found).toBe(1);
    expect(scoreEdges([label], [], [sym({ props: ['name'] })]).totals.found).toBe(0);
    expect(scoreEdges([label], [], [{ ...sym({ props: ['id'] }), kind: 'function' }]).totals.found).toBe(0);
  });

  it('reports recall per pattern and per version', () => {
    const s = scoreEdges([L({ pattern: 'a', version: 'vue2' }), L({ id: 'Y', pattern: 'a', version: 'vue3', edge: E({ target_symbol: 'x' }) })], [E()]);
    expect(s.patterns.a).toMatchObject({ labelled: 2, found: 1, recall: 0.5 });
    expect(s.patterns.a!.versions).toEqual({
      vue2: { labelled: 1, found: 1, negatives: 0, falsePositives: 0 },
      vue3: { labelled: 1, found: 0, negatives: 0, falsePositives: 0 },
    });
  });

  it('reports a label with neither an edge nor a symbol as a miss', () => {
    const s = scoreEdges([L({ edge: undefined })], [E()]);
    expect(s.totals).toMatchObject({ labelled: 1, found: 0 });
    expect(s.misses).toEqual(['X p has neither an edge nor a symbol']);
  });

  it('rejects malformed, repeated and unknown options instead of ignoring them', () => {
    expect(parseArgs(['fx', '--json', '--min-recall', '0.5', '--max-fp', 'a=1'])).toEqual({ fixture: 'fx', json: true });
    expect(() => parseArgs(['fx', '--min-recal', '0.9'])).toThrow(/unknown option --min-recal/);
    expect(() => parseArgs(['fx', '--min-recall=0.9'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--json'])).toThrow(/missing <fixture-dir>/);
    expect(() => parseArgs(['fx', 'other'])).toThrow(/unexpected argument/);
    expect(() => parseThresholds(['--max-fp', 'x=abc'], 'max-fp')).toThrow(/not a number/);
    expect(() => parseThresholds(['--min-recall', 'p='], 'min-recall')).toThrow(/not a number/);
    expect(() => parseThresholds(['--min-recall', ''], 'min-recall')).toThrow(/not a number/);
    expect(() => parseThresholds(['--min-recall'], 'min-recall')).toThrow(/needs a value/);
    expect(() => parseThresholds(['--min-recall', '1.5'], 'min-recall')).toThrow(/\[0, 1\]/);
    expect(() => parseThresholds(['--max-fp', '0.5'], 'max-fp')).toThrow(/integer/);
    expect(() => parseThresholds(['--min-recall', '0.9', '--min-recall', '0.1'], 'min-recall')).toThrow(/twice/);
    expect(() => parseThresholds(['--max-fp', 'a=1', '--max-fp', 'a=2'], 'max-fp')).toThrow(/twice/);
    expect(() => parseThresholds(['--min-precision', 'p=0.9'], 'min-precision')).toThrow(/totals only/);
    expect(() => parseThresholds(['--max-fp', '=1'], 'max-fp')).toThrow(/missing pattern/);
  });

  it('applies total and per-pattern thresholds', () => {
    expect(parseThresholds(['--min-recall', '0.5', '--min-recall', 'pinia=1', '--max-fp', 'mixin-method=2'], 'min-recall'))
      .toEqual({ total: 0.5, patterns: { pinia: 1 } });
    const s: EdgeScore = scoreEdges([L({ pattern: 'a' }), L({ id: 'N', pattern: 'b', expect: 'absent' })], [E()]);
    expect(thresholdFailures(s, ['--min-recall', '1', '--max-fp', 'a=0'])).toEqual([]);
    expect(thresholdFailures(s, ['--max-fp', '0'])).toEqual(['false positives 1 > 0']);
    expect(thresholdFailures(s, ['--max-fp', 'b=0', '--min-recall', 'zzz=1'])).toEqual(['unknown pattern zzz', 'b false positives 1 > 0']);
  });
});

describe('Vue SFC edges on the fixture (real scan)', () => {
  let result: EdgeScore;
  beforeAll(() => {
    const { edges, symbols } = scanEdgeFixture(FIXTURE, expected.roots);
    result = scoreEdges(labels, edges, symbols, expected.scoredTypes);
  }, 120000);

  it('does not regress below the recorded floors', () => {
    const misses = result.misses.join('\n');
    for (const p of PATTERNS) {
      expect(FLOORS.found[p], `${p}: floor above its labelled count`).toBeLessThanOrEqual(labelledCount(p));
      expect(result.patterns[p]!.found, `${p} found\n${misses}`).toBeGreaterThanOrEqual(FLOORS.found[p]);
      expect(result.patterns[p]!.falsePositives, `${p} false positives\n${result.falsePositiveEdges.join('\n')}`)
        .toBeLessThanOrEqual(FLOORS.falsePositives[p] ?? 0);
    }
    expect(result.totals.precision, result.unlabelledEdges.join('\n')).toBeGreaterThanOrEqual(FLOORS.minPrecision);
  });

  // M3-07: vue2/package.json and vue3/package.json activate Vue detection for their own folders,
  // so one scan of the fixture root equals the per-app scans that `roots` asks for.
  it('scans the whole fixture as one project with the same edges, symbols and score as per root', () => {
    const perRoot = scanEdgeFixture(FIXTURE, expected.roots);
    const whole = scanEdgeFixture(FIXTURE);
    const sorted = (rows: object[]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(sorted(whole.edges)).toEqual(sorted(perRoot.edges));
    expect(sorted(whole.symbols)).toEqual(sorted(perRoot.symbols));
    expect(scoreEdges(labels, whole.edges, whole.symbols, expected.scoredTypes)).toEqual(result);
    // Vue detection really ran: the router files yield route edges in both apps.
    for (const app of ['vue2', 'vue3'])
      expect(whole.edges.some((e) => e.edge_type === 'route' && e.source_file === `${app}/src/router/index.js`), app).toBe(true);
  }, 240000);
});

describe('framework detection from a package.json below the repo root (M3-07)', () => {
  // A Vue app in frontend/ next to a PHP backend; the only package.json is frontend's.
  const files: Record<string, string> = {
    'frontend/package.json': JSON.stringify({ name: 'shop-frontend', private: true, dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' } }),
    'frontend/src/i18n.js': 'export function t(key) {\n  return key;\n}\n',
    'frontend/src/title.js': "import { t } from './i18n';\n\nexport function pageTitle() {\n  return t('shop.title');\n}\n",
    'frontend/src/router/index.js': "import { createRouter, createWebHistory } from 'vue-router';\n\nconst routes = [\n  { path: '/about', name: 'About', component: () => import('../views/AboutView.vue') },\n];\n\nexport default createRouter({ history: createWebHistory(), routes });\n",
    'frontend/src/views/AboutView.vue': "<template>\n  <h1>About</h1>\n</template>\n\n<script>\nexport default { name: 'AboutView' };\n</script>\n",
    // `t` is on the vue-router ignore list; the backend's own t() functions must survive (the PHP
    // parser never applies ignore lists; the JS build script shows the scoping).
    'backend/src/helpers.php': "<?php\n\nfunction t($text)\n{\n    return $text;\n}\n",
    'backend/tools/i18n.js': "function t(key) {\n  return key;\n}\n\nmodule.exports = { t };\n",
    // Looks like a Vue route table, but no Vue manifest covers backend/.
    'backend/tools/routes.js': "const routes = [\n  { path: '/admin', component: () => import('./AdminPanel.vue') },\n];\n\nmodule.exports = routes;\n",
    'backend/tools/AdminPanel.vue': "<template>\n  <h1>Admin</h1>\n</template>\n",
  };
  // More than 10 files, so the default scan parses in worker threads; --no-parallel covers the main thread.
  for (let i = 1; i <= 4; i++) files[`backend/src/Util${i}.php`] = `<?php\n\nfunction util${i}()\n{\n    return ${i};\n}\n`;

  it.each([['worker threads', []], ['main thread', ['--no-parallel']]])('activates Vue for frontend/ only (%s)', (_mode, flags) => {
    const root = workspace(files);
    try {
      init(root);
      mapx(root, 'scan', ...flags);
      expect(JSON.parse(readFileSync(join(root, '.mapx', 'frameworks.json'), 'utf8'))).toContain('vue-router');
      const routes = query<StoredEdge>(root, "SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges WHERE edge_type = 'route'");
      expect(routes).toEqual([{
        source_file: 'frontend/src/router/index.js', source_symbol: null,
        target_file: 'frontend/src/views/AboutView.vue', target_symbol: 'AboutView', edge_type: 'route',
      }]);
      const t = query<{ file_path: string }>(root, "SELECT file_path FROM symbols WHERE name = 't' ORDER BY file_path");
      expect(t.map((s) => s.file_path)).toEqual(['backend/src/helpers.php', 'backend/tools/i18n.js']);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('finds manifest folders from the scanned files, below the repo root only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mapx-scopes-'));
    const pkg = (dir: string, deps: Record<string, string>) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ dependencies: deps }));
    };
    try {
      pkg('', { vue: '^3' }); // the repo root itself is detect()'s job
      pkg('apps/web', { vue: '^3' });
      pkg('apps/web/legacy', { vue: '^2' }); // covered by apps/web
      pkg('apps/api', { express: '^4' });
      pkg('apps/admin/node_modules/x', { vue: '^3' }); // no scanned file there
      pkg('tools', { 'vue-router': '^4' });
      const files = ['index.js', 'apps/web/src/main.js', 'apps/web/legacy/old.js', 'apps/api/server.js', 'apps/admin/app.js', 'tools/a/b/c.js'];
      expect(await findNestedManifestScopes(root, '', files, 'package.json', ['vue', 'vue-router'])).toEqual(['apps/web', 'tools']);
      // A repo registered at apps/ sees only manifests below apps/.
      expect(await findNestedManifestScopes(root, 'apps', files.filter((f) => f.startsWith('apps/')), 'package.json', ['vue'])).toEqual(['apps/web']);
      expect(await findNestedManifestScopes(root, 'apps/web', ['apps/web/src/main.js'], 'package.json', ['vue'])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies a scoped ignore list only to files under its folders', () => {
    const vue = new Set(['t']);
    const other = new Set(['x']);
    const scoped = [{ scopes: ['frontend'], symbols: vue }, { scopes: [''], symbols: other }];
    expect(ignoredSymbolsForFile(scoped, 'frontend/src/a.js')).toEqual(new Set(['t', 'x']));
    expect(ignoredSymbolsForFile(scoped, 'backend/a.php')).toBe(other);
    expect(ignoredSymbolsForFile(scoped, 'frontend-old/a.js')).toBe(other);
    expect(ignoredSymbolsForFile([{ scopes: ['frontend'], symbols: vue }], 'backend/a.php')).toBeUndefined();
    expect(ignoredSymbolsForFile(undefined, 'a.js')).toBeUndefined();
  });
});
