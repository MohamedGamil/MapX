import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import { cleanup, init, mapx, mapxResult, workspace } from './helpers/e2e';
import { fingerprint, loadCompareReport, normalizeElement, parseBaseline, renderBaseline } from '../src/arch/baseline';
import { ConfigError } from '../src/arch/config';
import { exitCode } from '../src/arch/check';
import type { ArchReport, Finding } from '../src/arch/report';

// M5-06 (AR-10): baselines (generate, match, stale entries, Deptrac element pairs) and the
// `--compare <report.json>` ratchet, end to end: temp workspaces, the real CLI from source, and
// the JSON report.
//
// Synthetic PHP app, labelled. Layers by path: App may use Domain, Domain nothing, Infra Domain.
//   App\App\PlaceOrder → App\Domain\Order        allowed (import, instantiation)
//   App\App\PlaceOrder → App\Support\Clock       uncovered (Support is in no layer)
//   App\Domain\Order   → App\Infra\Repo          violation, import       ┐ the three violations
//   App\Domain\Order   → App\Infra\Repo          violation, instantiation│ a baseline freezes
//   App\Domain\Money   → App\Infra\Mailer        violation, import       ┘ (an unused `use`)
const APP: Record<string, string> = {
  'composer.json': '{"name":"acme/baseline","autoload":{"psr-4":{"App\\\\":"app/"}}}\n',
  'app/App/PlaceOrder.php': '<?php\nnamespace App\\App;\n\nuse App\\Domain\\Order;\nuse App\\Support\\Clock;\n\nclass PlaceOrder {\n  public function run() { new Clock(); return new Order(); }\n}\n',
  'app/Domain/Order.php': '<?php\nnamespace App\\Domain;\n\nuse App\\Infra\\Repo;\n\nclass Order {\n  public function save() { return new Repo(); }\n}\n',
  'app/Domain/Money.php': '<?php\nnamespace App\\Domain;\n\nuse App\\Infra\\Mailer;\n\nclass Money {}\n',
  'app/Infra/Repo.php': '<?php\nnamespace App\\Infra;\n\nclass Repo {}\n',
  'app/Infra/Mailer.php': '<?php\nnamespace App\\Infra;\n\nclass Mailer {}\n',
  'app/Support/Clock.php': '<?php\nnamespace App\\Support;\n\nclass Clock {}\n',
  '.mapx/architecture.jsonc': JSON.stringify({
    layers: [
      { name: 'App', selectors: [{ path: 'app/App/**' }] },
      { name: 'Domain', selectors: [{ path: 'app/Domain/**' }] },
      { name: 'Infra', selectors: [{ path: 'app/Infra/**' }] },
    ],
    rules: { App: ['Domain'], Domain: [], Infra: ['Domain'] },
  }),
};
// The fingerprints' inputs, in the baseline's order: an import's end is its importing file (a
// file-level end), whatever symbols the file declares; the instantiation's is the class.
const VIOLATIONS = [
  ['disallowed-layer', 'App\\Domain\\Order', 'App\\Infra\\Repo', 'instantiation'],
  ['disallowed-layer', 'app/Domain/Money.php', 'App\\Infra\\Mailer', 'import'],
  ['disallowed-layer', 'app/Domain/Order.php', 'App\\Infra\\Repo', 'import'],
] as const;
const fp = (v: readonly [string, string, string, string]) => fingerprint(v[0], v[1], v[2], v[3]);
const FPS = VIOLATIONS.map(fp).sort();
const DEFAULT = '.mapx/architecture.baseline.json';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(JSON.parse(readFileSync(resolve(__dirname, '../schemas/arch-report.schema.json'), 'utf8')));

const temps: string[] = [];
function scanned(files: Record<string, string>): string {
  const root = workspace(files);
  temps.push(root);
  init(root);
  mapx(root, 'scan');
  return root;
}
/** A folder outside every workspace, for base reports and baselines given on the command line. */
const outside = mkdtempSync(join(tmpdir(), 'mapx-arch-baseline-out-'));
temps.push(outside);

/** `mapx check --format json` and its parsed report (written to a file outside the workspace). */
function check(root: string, ...args: string[]): { status: number | null; report: ArchReport; stdout: string; stderr: string } {
  const out = join(outside, `report-${Math.random().toString(36).slice(2)}.json`);
  const r = mapxResult(root, 'check', '--format', 'json', '-o', out, '--report-skipped', ...args);
  let report: ArchReport;
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { throw new Error(`no report (exit ${r.status}): ${r.stderr}`); }
  expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  return { ...r, report };
}
const of = (report: ArchReport, kind: Finding['kind']) => report.findings.filter((f) => f.kind === kind);
const fps = (findings: Finding[]) => findings.map((f) => f.fingerprint).sort();

afterAll(() => { for (const t of temps) cleanup(t); });

describe('baseline: generate, match, stale entries (AR-10)', () => {
  let root = '';
  beforeAll(() => { root = scanned(APP); }, 120_000);

  it('generate → re-run: 0 violations and N skipped, the same fingerprints', () => {
    const before = check(root);
    expect(before.status).toBe(1);
    expect(fps(of(before.report, 'violation'))).toEqual(FPS);

    const gen = mapxResult(root, 'check', '--generate-baseline');
    expect(gen.status).toBe(0);
    expect(gen.stdout).toContain(`Wrote 3 baseline entries to ${DEFAULT}.`);

    const after = check(root);
    expect(after.status).toBe(0);
    expect(after.report.counts).toMatchObject({ violation: 0, skipped: 3, error: 0 });
    expect(fps(of(after.report, 'skipped'))).toEqual(FPS);
    expect(of(after.report, 'skipped').every((f) => f.skippedBy === 'baseline')).toBe(true);
    // The layer matrix counts them as skipped, not as violations.
    expect(after.report.layerEdges.find((e) => e.from === 'Domain' && e.to === 'Infra')).toMatchObject({ violations: 0, skipped: 3 });
    // Hidden by default, counted in the table's summary.
    const table = mapxResult(root, 'check');
    expect(table.status).toBe(0);
    expect(table.stdout).toMatch(/Violations: 0 .*Skipped: 3/);
    expect(table.stdout).not.toContain('App\\Domain\\Order →');
    // Listed on request, with the reason for the skip (review of M5-06).
    expect(mapxResult(root, 'check', '--report-skipped').stdout).toContain('- disallowed-layer [baseline]  App\\Domain\\Order → App\\Infra\\Repo (import)');
  });

  it('the baseline is sorted and byte-stable: twice in one workspace, and from a separate scan elsewhere', () => {
    const first = readFileSync(join(root, DEFAULT), 'utf8');
    const doc = JSON.parse(first);
    expect(doc.version).toBe(1);
    expect(doc.entries.map((e: Record<string, string>) => [e.rule, e.source, e.target, e.edgeType])).toEqual(VIOLATIONS.map((v) => [...v]));
    for (const e of doc.entries) expect(Object.keys(e)).toEqual(['fingerprint', 'rule', 'source', 'target', 'edgeType']);
    expect(doc.entries.map((e: { fingerprint: string }) => e.fingerprint)).toEqual(VIOLATIONS.map(fp));
    expect(first.endsWith('}\n')).toBe(true);

    // Regenerating while the baseline is in force still lists every violation, byte for byte.
    expect(mapxResult(root, 'check', '--generate-baseline').status).toBe(0);
    expect(readFileSync(join(root, DEFAULT), 'utf8')).toBe(first);
    // Another directory, another scan: the same bytes (no path, time or machine in the file).
    const other = scanned(APP);
    const elsewhere = join(outside, 'elsewhere.baseline.json');
    const r = mapxResult(other, 'check', '--generate-baseline', elsewhere);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`\`mapx check\` reads ${DEFAULT}: pass \`--baseline ${elsewhere}\``);
    expect(readFileSync(elsewhere, 'utf8')).toBe(first);
    expect(check(other, '--baseline', elsewhere).report.counts).toMatchObject({ violation: 0, skipped: 3 });
    // A relative file is relative to the current directory, and the hint names it so, as
    // --baseline reads it (review of M5-06: the hint was relative to the workspace).
    const rel = mapxResult(outside, 'check', other, '--generate-baseline', 'rel.baseline.json');
    expect(rel.status).toBe(0);
    expect(rel.stdout).toContain('pass `--baseline rel.baseline.json`');
    expect(readFileSync(join(outside, 'rel.baseline.json'), 'utf8')).toBe(first);
    expect(mapxResult(outside, 'check', other, '--baseline', 'rel.baseline.json').status).toBe(0);
  }, 120_000);

  it('a moved line still matches: the fingerprint has no line number', () => {
    const order = join(root, 'app/Domain/Order.php');
    writeFileSync(order, readFileSync(order, 'utf8').replace('<?php\n', '<?php\n// moved\n\n\n\n\n'));
    const r = check(root, '--sync');
    expect(r.status).toBe(0);
    expect(fps(of(r.report, 'skipped'))).toEqual(FPS);
    expect(of(r.report, 'skipped').find((f) => f.edgeType === 'instantiation')!.source!.line).toBe(12); // 7, moved by 5
  });

  it('deleting the offending import gives one stale-entry error, exit 3', () => {
    const money = join(root, 'app/Domain/Money.php');
    writeFileSync(money, readFileSync(money, 'utf8').replace('use App\\Infra\\Mailer;\n', ''));
    const r = check(root, '--sync');
    expect(r.status).toBe(3);
    expect(r.report.counts).toMatchObject({ violation: 0, skipped: 2, error: 1 });
    expect(of(r.report, 'error')).toEqual([expect.objectContaining({
      rule: 'stale-baseline', severity: 'error', edgeType: 'import', fingerprint: fp(VIOLATIONS[1]),
      source: { element: 'app/Domain/Money.php', file: 'app/Domain/Money.php' },
      target: { element: 'App\\Infra\\Mailer', file: 'app/Infra/Mailer.php' },
    })]);
    const table = mapxResult(root, 'check');
    expect(table.status).toBe(3);
    expect(table.stdout).toContain(`${DEFAULT}: the baseline entry disallowed-layer app/Domain/Money.php → App\\Infra\\Mailer (import) matches no violation; delete it`);
    // Regenerating drops the stale entry: the baseline only shrinks.
    expect(mapxResult(root, 'check', '--generate-baseline').stdout).toContain('Wrote 2 baseline entries');
    expect(mapxResult(root, 'check').status).toBe(0);
  });

  it('Deptrac element pairs (skip_violations) match every rule and edge type; an unmatched pair is stale', () => {
    const pairs = join(outside, 'pairs.json');
    writeFileSync(pairs, JSON.stringify({ skip_violations: { 'App\\Domain\\Order': ['App\\Infra\\Repo'] } }));
    const r = check(root, '--baseline', pairs);
    expect(r.status).toBe(0);
    expect(of(r.report, 'skipped').map((f) => f.edgeType).sort()).toEqual(['import', 'instantiation']);

    writeFileSync(pairs, JSON.stringify({ skip_violations: { 'App\\Domain\\Order': ['App\\Infra\\Repo', 'App\\Infra\\Mailer'] } }));
    const stale = check(root, '--baseline', pairs);
    expect(stale.status).toBe(3);
    expect(of(stale.report, 'error')).toEqual([expect.objectContaining({ rule: 'stale-baseline', source: { element: 'App\\Domain\\Order', file: 'app/Domain/Order.php' }, target: { element: 'App\\Infra\\Mailer', file: 'app/Infra/Mailer.php' } })]);
  });

  it('a view has its own default baseline', () => {
    mkdirSync(join(root, '.mapx/architecture'), { recursive: true });
    writeFileSync(join(root, '.mapx/architecture/strict.jsonc'), readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8').replace('"App":["Domain"]', '"App":[]'));
    expect(check(root, '--view', 'strict').report.counts.violation).toBe(4); // App → Domain twice, Order → Repo twice
    expect(mapxResult(root, 'check', '--view', 'strict', '--generate-baseline').stdout).toContain('Wrote 4 baseline entries to .mapx/architecture/strict.baseline.json.');
    expect(check(root, '--view', 'strict').status).toBe(0);
    expect(check(root).report.counts.skipped).toBe(2); // the main baseline is untouched
  });

  it('a view that extends a configuration naming a baseline still has its own (review of M5-06)', () => {
    const main = join(root, '.mapx/architecture.jsonc');
    writeFileSync(main, JSON.stringify({ ...JSON.parse(readFileSync(main, 'utf8')), baseline: DEFAULT }));
    writeFileSync(join(root, '.mapx/architecture/inherit.jsonc'), JSON.stringify({ extends: '../architecture.jsonc' }));
    const before = readFileSync(join(root, DEFAULT), 'utf8');
    const gen = mapxResult(root, 'check', '--view', 'inherit', '--generate-baseline');
    expect(gen.status).toBe(0);
    expect(gen.stdout).toContain('Wrote 2 baseline entries to .mapx/architecture/inherit.baseline.json.');
    expect(readFileSync(join(root, DEFAULT), 'utf8')).toBe(before);
    expect(check(root, '--view', 'inherit').report.counts).toMatchObject({ violation: 0, skipped: 2 });
    expect(check(root).report.counts).toMatchObject({ violation: 0, skipped: 2 });
  });

  it('a baseline generated in the workspace outside .mapx/ is flagged, and the hint points under .mapx/ (review of M5-06)', () => {
    const r = mapxResult(root, 'check', '--generate-baseline', 'arch-baseline.json');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('arch-baseline.json is inside the workspace');
    expect(r.stderr).toContain('`mapx check --generate-baseline .mapx/arch-baseline.json`, then `--baseline .mapx/arch-baseline.json`');
    expect(r.stdout).not.toContain('pass `--baseline arch-baseline.json`');
    expect(mapxResult(root, 'check', '--baseline', 'arch-baseline.json').status).toBe(4); // why: a new JSON file
    rmSync(join(root, 'arch-baseline.json'));
    // Following the hint works.
    const ok = mapxResult(root, 'check', '--generate-baseline', '.mapx/arch-baseline.json');
    expect(ok.stderr).toBe('');
    expect(ok.stdout).toContain('pass `--baseline .mapx/arch-baseline.json`');
    expect(mapxResult(root, 'check', '--baseline', '.mapx/arch-baseline.json').status).toBe(0);
  });

  it('exit 3: a missing or invalid baseline, and options --generate-baseline does not take', () => {
    const bad = join(outside, 'bad.json');
    const cases: Array<[string, string | null, RegExp]> = [
      ['missing', null, /baseline file not found/],
      ['not json', '{', /not valid JSON/],
      ['mismatched fingerprint', JSON.stringify({ version: 1, entries: [{ fingerprint: '0000000000000000', rule: 'disallowed-layer', source: 'A', target: 'B', edgeType: 'import' }] }), /is not the fingerprint of its rule/],
      ['incomplete entry', JSON.stringify({ entries: [{ rule: 'disallowed-layer', source: 'A' }] }), /needs a fingerprint, or all of rule, source, target and edgeType/],
    ];
    for (const [name, content, message] of cases) {
      rmSync(bad, { force: true });
      if (content !== null) writeFileSync(bad, content);
      const r = check(root, '--baseline', bad);
      expect(r.status, name).toBe(3);
      expect(r.report.findings.map((f) => f.message).join('\n'), name).toMatch(message);
    }
    // A configuration that names a baseline needs it.
    writeFileSync(join(root, '.mapx/architecture/named.jsonc'), JSON.stringify({ extends: '../architecture.jsonc', baseline: '.mapx/none.json' }));
    const named = check(root, '--view', 'named');
    expect(named.status).toBe(3);
    expect(named.report.findings[0]!.message).toBe('.mapx/none.json: baseline file not found; create it with `mapx check --generate-baseline`');
    // `--generate-baseline [file]` takes the next word: a directory or a non-JSON name is refused
    // before anything is evaluated or written (review of M5-06).
    for (const word of ['app', root]) {
      const r = mapxResult(outside, 'check', '--generate-baseline', word);
      expect(r.status, word).toBe(3);
      expect(r.stderr, word).toContain('--generate-baseline writes a .json file');
    }
    for (const extra of [['--rule', 'disallowed-layer'], ['--layer', 'Domain'], ['--compare', bad]]) {
      expect(mapxResult(root, 'check', '--generate-baseline', ...extra).status, extra[0]).toBe(3);
    }
  });
});

describe('--compare <base report>: the ratchet without a committed baseline', () => {
  let root = '';
  let base = '';
  beforeAll(() => {
    root = scanned(APP);
    base = join(outside, 'base.json');
    // CI on the merge base: the JSON report, with every kind a later run may need to forgive.
    const r = mapxResult(root, 'check', '--format', 'json', '-o', base, '--report-uncovered', '--report-skipped');
    expect(r.status).toBe(1);
  }, 120_000);

  it('an unchanged head exits 0: its violations are skipped by the comparison', () => {
    const r = check(root, '--compare', base);
    expect(r.status).toBe(0);
    expect(r.report.counts).toMatchObject({ violation: 0, skipped: 3 });
    expect(of(r.report, 'skipped').every((f) => f.skippedBy === 'compare')).toBe(true);
    // Known uncovered dependencies do not fail --fail-on-uncovered either; without --compare they do.
    expect(mapxResult(root, 'check', '--compare', base, '--fail-on-uncovered').status).toBe(0);
    expect(mapxResult(root, 'check', '--fail-on-uncovered').status).toBe(1); // the violations first
  });

  it('a head with one new violation fails on that one only (and a fixed one is no error)', () => {
    const head = join(outside, 'head');
    cpSync(root, head, { recursive: true });
    temps.push(head);
    // The injected violation: Domain → Infra, a fingerprint the base report does not have.
    writeFileSync(join(head, 'app/Domain/Audit.php'), '<?php\nnamespace App\\Domain;\n\nuse App\\Infra\\Mailer;\n\nclass Audit {}\n');
    // …and a base violation paid off at the same time.
    const money = join(head, 'app/Domain/Money.php');
    writeFileSync(money, readFileSync(money, 'utf8').replace('use App\\Infra\\Mailer;\n', ''));
    const r = check(head, '--sync', '--compare', base);
    expect(r.status).toBe(1);
    expect(of(r.report, 'violation')).toEqual([expect.objectContaining({
      rule: 'disallowed-layer', edgeType: 'import', fingerprint: fingerprint('disallowed-layer', 'app/Domain/Audit.php', 'App\\Infra\\Mailer', 'import'),
      source: expect.objectContaining({ element: 'App\\Domain\\Audit', file: 'app/Domain/Audit.php' }),
    })]);
    expect(r.report.counts).toMatchObject({ violation: 1, skipped: 2, error: 0 });
    // Without the comparison all three fail.
    expect(check(head).report.counts.violation).toBe(3);
  }, 120_000);

  it('exit 3: a missing base report, or a file that is not one', () => {
    expect(check(root, '--compare', join(outside, 'nope.json')).report.findings[0]!.message).toContain('report not found');
    expect(mapxResult(root, 'check', '--compare', join(outside, 'nope.json')).status).toBe(3);
    const notReport = join(outside, 'not-report.json');
    writeFileSync(notReport, JSON.stringify({ version: 1, entries: [] }));
    expect(mapxResult(root, 'check', '--compare', notReport).status).toBe(3);
  });

  it('exit 3: a base report of another view, or narrowed by a filter the head does not share (review of M5-06)', () => {
    expect(JSON.parse(readFileSync(base, 'utf8')).selection).toEqual({ view: null, layer: null, rule: null });
    mkdirSync(join(root, '.mapx/architecture'), { recursive: true });
    writeFileSync(join(root, '.mapx/architecture/other.jsonc'), JSON.stringify({ extends: '../architecture.jsonc' }));
    const view = check(root, '--view', 'other', '--compare', base);
    expect(view.status).toBe(3);
    expect(view.report.findings[0]!.message).toContain('the base report checked view none, this check view "other"');
    const narrowed = join(outside, 'base-layer.json');
    expect(mapxResult(root, 'check', '--format', 'json', '-o', narrowed, '--layer', 'App').status).toBe(0);
    expect(JSON.parse(readFileSync(narrowed, 'utf8')).selection).toEqual({ view: null, layer: 'App', rule: null });
    const r = check(root, '--compare', narrowed);
    expect(r.status).toBe(3);
    expect(r.report.findings[0]!.message).toContain('narrowed by --layer "App"');
    expect(mapxResult(root, 'check', '--layer', 'App', '--compare', narrowed).status).toBe(0);
    // A narrower head against a whole base is fine.
    expect(mapxResult(root, 'check', '--layer', 'Domain', '--compare', base).status).toBe(0);
  });
});

describe('fingerprints of file-level ends and of repos (review of M5-06)', () => {
  it('TypeScript: a symbol added to either end of a baselined import keeps it matched', () => {
    const root = scanned({
      'package.json': '{"name":"ts-baseline"}\n',
      'src/domain/order.ts': "import { Repo } from '../infra/repo';\n\nexport class Order {\n  save() { return new Repo(); }\n}\n",
      'src/infra/repo.ts': 'export class Repo {}\n',
      '.mapx/architecture.jsonc': JSON.stringify({
        layers: [{ name: 'Domain', selectors: [{ path: 'src/domain/**' }] }, { name: 'Infra', selectors: [{ path: 'src/infra/**' }] }],
        rules: { Domain: [], Infra: ['Domain'] },
      }),
    });
    const before = check(root);
    expect(before.status).toBe(1);
    const imports = of(before.report, 'violation').filter((f) => f.edgeType === 'import');
    expect(imports).toHaveLength(1);
    expect(imports[0]!.identity).toEqual({ source: 'src/domain/order.ts', target: 'src/infra/repo.ts' });
    expect(imports[0]!.source!.element).toBe('src/domain/order.ts#Order'); // shown as the file's only class
    expect(mapxResult(root, 'check', '--generate-baseline').status).toBe(0);
    const fpsBefore = fps(of(before.report, 'violation'));

    appendFileSync(join(root, 'src/domain/order.ts'), 'export function helper() { return 1; }\n');
    appendFileSync(join(root, 'src/infra/repo.ts'), 'export const VERSION = 1;\n');
    const after = check(root, '--sync');
    expect(after.status).toBe(0);
    expect(after.report.counts).toMatchObject({ violation: 0, error: 0 });
    expect(fps(of(after.report, 'skipped'))).toEqual(fpsBefore);
    // Shown as the file now: it has two top-level declarations.
    expect(of(after.report, 'skipped').find((f) => f.edgeType === 'import')!.source!.element).toBe('src/domain/order.ts');
  }, 120_000);

  it('two repos with the same names: a baseline of one does not skip the other\'s violation', () => {
    const clean = '<?php\nnamespace App\\Domain;\n\nclass Order {}\n';
    const dirty = '<?php\nnamespace App\\Domain;\n\nuse App\\Infra\\Repo;\n\nclass Order { public function save() { return new Repo(); } }\n';
    const repo = '<?php\nnamespace App\\Infra;\n\nclass Repo {}\n';
    const root = workspace({
      'a/composer.json': '{"name":"acme/a"}\n', 'a/app/Domain/Order.php': dirty, 'a/app/Infra/Repo.php': repo,
      'b/composer.json': '{"name":"acme/b"}\n', 'b/app/Domain/Order.php': clean, 'b/app/Infra/Repo.php': repo,
      '.mapx/architecture.jsonc': JSON.stringify({
        layers: [{ name: 'Domain', selectors: [{ path: '*/app/Domain/**' }] }, { name: 'Infra', selectors: [{ path: '*/app/Infra/**' }] }],
        rules: { Domain: [], Infra: ['Domain'] },
      }),
    }, ['a', 'b']);
    temps.push(root);
    init(root);
    mapx(root, 'workspaces', 'add', 'a');
    mapx(root, 'workspaces', 'add', 'b');
    mapx(root, 'scan');
    expect(mapxResult(root, 'check', '--generate-baseline').stdout).toContain('Wrote 2 baseline entries');
    const entries = JSON.parse(readFileSync(join(root, DEFAULT), 'utf8')).entries;
    expect(entries.map((e: Record<string, string>) => [e.source, e.sourceRepo, e.targetRepo])).toEqual([
      ['App\\Domain\\Order', 'a', 'a'], ['a/app/Domain/Order.php', 'a', 'a'],
    ]);
    expect(entries[0].fingerprint).toBe(fingerprint('disallowed-layer', 'App\\Domain\\Order', 'App\\Infra\\Repo', 'instantiation', 'a', 'a'));

    writeFileSync(join(root, 'b/app/Domain/Order.php'), dirty);
    const r = check(root, '--sync');
    expect(r.status).toBe(1);
    expect(of(r.report, 'violation').map((f) => [f.source!.file, f.edgeType]).sort()).toEqual([['b/app/Domain/Order.php', 'import'], ['b/app/Domain/Order.php', 'instantiation']]);
    expect(of(r.report, 'skipped').map((f) => f.source!.file)).toEqual(['a/app/Domain/Order.php', 'a/app/Domain/Order.php']);
  }, 120_000);
});

describe('baseline.ts units', () => {
  const finding = (over: Partial<Finding>): Finding => ({ kind: 'violation', rule: 'disallowed-layer', severity: 'error', fingerprint: '', message: '', ...over });

  it('accepts a UTF-8 BOM, as the configuration loader does', () => {
    expect(parseBaseline('\uFEFF{"version":1,"entries":[{"fingerprint":"aaaaaaaaaaaaaaaa"}]}', 'b.json').entries).toEqual([{ fingerprint: 'aaaaaaaaaaaaaaaa' }]);
  });

  it('parses readable-key entries (the fixture form) and fingerprints them, and dedupes repeats', () => {
    const b = parseBaseline(JSON.stringify({ version: 1, entries: [
      { rule: 'disallowed-layer', source: 'A', target: 'B', edgeType: 'import' },
      { fingerprint: fingerprint('disallowed-layer', 'A', 'B', 'import') },
    ] }), 'b.json');
    expect(b.entries).toEqual([{ rule: 'disallowed-layer', source: 'A', target: 'B', edgeType: 'import', fingerprint: fingerprint('disallowed-layer', 'A', 'B', 'import') }]);
  });

  it('hand-written Windows paths match the store\'s POSIX paths; PHP names keep their backslashes', () => {
    expect(normalizeElement('src\\domain\\Order.ts#Order.save')).toBe('src/domain/Order.ts#Order.save');
    expect(normalizeElement('app\\Support\\helpers.php')).toBe('app/Support/helpers.php');
    expect(normalizeElement('App\\Domain\\Order')).toBe('App\\Domain\\Order');
    const b = parseBaseline(JSON.stringify({
      entries: [{ fingerprint: fingerprint('disallowed-layer', 'src/a.ts', 'src/b/c.ts#C', 'import'), rule: 'disallowed-layer', source: 'src\\a.ts', target: 'src\\b\\c.ts#C', edgeType: 'import' }],
      skip_violations: { 'App\\Domain\\Order': ['lib\\x.py'] },
    }), 'b.json');
    expect(b.entries[0]).toMatchObject({ source: 'src/a.ts', target: 'src/b/c.ts#C' });
    expect(b.pairs).toEqual([{ source: 'App\\Domain\\Order', target: 'lib/x.py' }]);
  });

  it('rejects unknown keys, bad fingerprints, non-string values and a wrong version, each with its pointer', () => {
    let err: unknown;
    try {
      parseBaseline(JSON.stringify({ version: 2, entires: [], entries: [{ fingerprint: 'XYZ' }, { rule: 1, source: 'a', target: 'b', edgeType: 'c' }], skip_violations: { A: 'B' } }), 'b.json');
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.pointer)).toEqual(['/entires', '/version', '/entries/0/fingerprint', '/entries/1/rule', '/skip_violations/A']);
  });

  it('renders violations only, sorted by code units (not locale), one entry per fingerprint', () => {
    const v = (s: string, t: string, e = 'import') => finding({ source: { element: s, file: '' }, target: { element: t, file: '' }, edgeType: e, fingerprint: fingerprint('disallowed-layer', s, t, e) });
    const text = renderBaseline([v('b', 'x'), v('B', 'x'), v('a', 'x', 'call'), v('a', 'x', 'call'), finding({ kind: 'uncovered', rule: 'uncovered', source: { element: 'z', file: '' }, target: { element: 'y', file: '' }, edgeType: 'import', fingerprint: 'f' })]);
    expect(JSON.parse(text).entries.map((e: { source: string }) => e.source)).toEqual(['B', 'a', 'b']);
  });

  it('exitCode: a known fingerprint does not fail --fail-on warn or --fail-on-uncovered; configuration errors always fail', () => {
    const counts = { violation: 0, skipped: 0, uncovered: 1, allowed: 0, warning: 1, error: 0 };
    const report: ArchReport = { version: 1, counts, layers: [], layerEdges: [], configErrors: [], findings: [
      finding({ kind: 'warning', rule: 'multi-layer', severity: 'warn', fingerprint: 'w' }),
      finding({ kind: 'uncovered', rule: 'uncovered', severity: 'info', fingerprint: 'u' }),
    ] };
    expect(exitCode(report, { failOn: 'warn' })).toBe(1);
    expect(exitCode(report, { failOn: 'warn', failOnUncovered: true, known: new Set(['w', 'u']) })).toBe(0);
    expect(exitCode(report, { failOnUncovered: true, known: new Set(['w']) })).toBe(2);
    const stale = { ...report, findings: [finding({ kind: 'error', rule: 'stale-baseline', fingerprint: 's' })] };
    expect(exitCode(stale, { known: new Set(['s']) })).toBe(3);
  });

  it('loadCompareReport reads every finding\'s fingerprint and rejects a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mapx-arch-compare-'));
    temps.push(dir);
    const p = join(dir, 'r.json');
    writeFileSync(p, JSON.stringify({ version: 1, findings: [{ fingerprint: 'aaaaaaaaaaaaaaaa' }, { fingerprint: 'bbbbbbbbbbbbbbbb' }] }));
    expect([...loadCompareReport(p)]).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    writeFileSync(p, JSON.stringify({ version: 1, findings: [{ fingerprint: 'nope' }] }));
    expect(() => loadCompareReport(p)).toThrow(ConfigError);
    // A UTF-8 BOM is fine; a base error about the baseline forgives nothing (review of M5-06).
    writeFileSync(p, '\uFEFF' + JSON.stringify({ version: 1, findings: [
      { kind: 'violation', rule: 'disallowed-layer', fingerprint: 'aaaaaaaaaaaaaaaa' },
      { kind: 'error', rule: 'stale-baseline', fingerprint: 'cccccccccccccccc' },
    ] }));
    expect([...loadCompareReport(p)]).toEqual(['aaaaaaaaaaaaaaaa']);
  });
});
