import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError, loadArchitectureConfig } from '../src/arch/config.js';
import { combine, elementMatches, loadExpected, loadExpectedExternals, loadExpectedSmells, rowMatches, scoreApp, scoreSmells, type ReportedSmell, type ExpectedRow, type ReportedFinding } from '../scripts/eval/score-arch.js';

// M5-01: the labelled architecture-rules fixture and its scorer (AR-08 chain, AR-09 kinds, AR-10 baseline).
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');
const expected = loadExpected(FIXTURE);
const rows = expected.rows;
const externals = loadExpectedExternals(FIXTURE);
const smellLabels = loadExpectedSmells(FIXTURE)!;
const LANGUAGES = { php: 'php', ts: 'typescript', python: 'python', go: 'go' } as const;

describe('the fixture', () => {
  it('has at least 60 labelled rows with unique ids, each naming files and symbols that exist', () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(Object.keys(expected.apps), r.id).toContain(r.app);
      for (const end of [r.from, r.to]) {
        if (!end) continue;
        // An external target (M5-24) has no file: it names `<ecosystem>:<name>`, a labelled external of the app.
        if (end.external !== undefined) {
          expect(end.file, r.id).toBeUndefined();
          expect(externals.some((x) => x.app === r.app && `${x.ecosystem}:${x.package ?? x.specifier}` === end.external), `${r.id}: ${end.external}`).toBe(true);
          continue;
        }
        const path = join(FIXTURE, r.app, end.file!);
        expect(existsSync(path), `${r.id}: ${end.file}`).toBe(true);
        if (end.symbol) expect(readFileSync(path, 'utf8'), `${r.id}: ${end.symbol} in ${end.file}`).toMatch(new RegExp(`\\b${end.symbol}\\b`));
      }
    }
  });

  it('covers every rule of the AR-08 chain at least twice per tier-1 language', () => {
    for (const app of Object.keys(LANGUAGES)) {
      const mine = rows.filter((r) => r.app === app);
      const count = (pred: (r: ExpectedRow) => boolean) => mine.filter(pred).length;
      expect(count((r) => r.rule === 'disallowed-layer' && (r.kind === 'violation' || r.kind === 'skipped')), `${app} disallowed-layer`).toBeGreaterThanOrEqual(2);
      expect(count((r) => r.rule === 'internal-element' && r.kind === 'violation'), `${app} internal-element`).toBeGreaterThanOrEqual(2);
      expect(count((r) => r.rule === 'private-layer' && r.kind === 'violation'), `${app} private-layer`).toBeGreaterThanOrEqual(2);
      expect(count((r) => r.rule === 'uncovered' && r.kind === 'uncovered'), `${app} uncovered`).toBeGreaterThanOrEqual(2);
      expect(count((r) => r.kind === 'none'), `${app} same-layer`).toBeGreaterThanOrEqual(2);
      expect(count((r) => r.kind === 'allowed'), `${app} allowed`).toBeGreaterThanOrEqual(2);
      // The '+' rule: an allowance reached only through "+Domain" (Application → Shared).
      expect(mine.some((r) => r.kind === 'allowed' && /\+Domain also grants/.test(r.note ?? '')), `${app} transitive`).toBe(true);
      expect(mine.find((r) => r.rule === 'multi-layer')?.kind, `${app} multi-layer`).toBe('warning');
      expect(mine.find((r) => r.rule === 'empty-layer')?.layer, `${app} empty-layer`).toBe('Reporting');
    }
  });

  it('has the + cycle, the baseline with one matched and one stale entry, and the two-repo http case', () => {
    expect(rows.filter((r) => r.app === 'php-broken-cycle')).toEqual([expect.objectContaining({ kind: 'error', rule: 'plus-cycle', layer: 'Application' })]);
    const baseline = JSON.parse(readFileSync(join(FIXTURE, 'php/.mapx/architecture.baseline.json'), 'utf8'));
    const skipped = rows.filter((r) => r.app === 'php' && r.kind === 'skipped');
    const stale = rows.filter((r) => r.app === 'php' && r.rule === 'stale-baseline');
    expect(skipped).toHaveLength(1);
    expect(stale).toEqual([expect.objectContaining({ kind: 'error' })]);
    // The accepted dependency is a Deptrac element pair, covering every edge type between the two
    // classes (M5-06 review); the stale one is an edge-typed entry.
    const pairs = Object.entries(baseline.skip_violations as Record<string, string[]>);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]![0].endsWith(skipped[0]!.from!.symbol!)).toBe(true);
    expect(pairs[0]![1]).toHaveLength(1);
    expect(pairs[0]![1][0]!.endsWith(skipped[0]!.to!.symbol!)).toBe(true);
    expect(baseline.entries).toHaveLength(1);
    expect(baseline.entries[0].source.endsWith(stale[0]!.from!.symbol!)).toBe(true);
    const ws = rows.filter((r) => r.app === 'workspace');
    // workspace-03 was added by M5-04: the route file's import of the API controller (Backend → PublicApi).
    // workspace-x01 and x02 (M5-24): the route files use the Route facade, a package in no layer;
    // out of scope since D039 (M5-24-R4), as the configuration has no package selector.
    expect(ws.map((r) => [r.kind, r.edgeType])).toEqual([['allowed', 'http'], ['violation', 'http'], ['violation', 'import'], ['none', 'import'], ['none', 'import']]);
    expect(expected.apps['workspace']!.repos).toEqual(['frontend', 'backend']);
  });

  it('each app configuration loads with the M5-02 loader; the broken copy fails on its + cycle', () => {
    for (const app of Object.keys(expected.apps)) {
      if (app === 'php-broken-cycle') continue;
      const config = loadArchitectureConfig(join(FIXTURE, app));
      expect(config, app).not.toBeNull();
    }
    try {
      loadArchitectureConfig(join(FIXTURE, 'php-broken-cycle'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.map((i) => i.message)).toEqual(['"+" allowances form a cycle: Application → Domain → Application']);
    }
  });
});

describe('the scorer', () => {
  const php = rows.filter((r) => r.app === 'php');
  const violation = php.find((r) => r.rule === 'disallowed-layer' && r.kind === 'violation')!;
  const asFinding = (r: ExpectedRow, over: Partial<ReportedFinding> = {}): ReportedFinding => ({
    kind: r.kind, rule: r.rule, edgeType: r.edgeType, layer: r.layer,
    source: r.from && { file: r.from.file, element: r.from.symbol && `App\\X\\${r.from.symbol}` },
    target: r.to && (r.to.external !== undefined
      ? { file: '', element: r.to.external.slice(r.to.external.indexOf(':') + 1), external: { ecosystem: r.to.external.slice(0, r.to.external.indexOf(':')) } }
      : { file: r.to.file, element: r.to.symbol && `App\\Y\\${r.to.symbol}` }),
    ...over,
  });

  it('a missing report scores recall 0 for every kind, not an error', () => {
    const score = scoreApp('php', php, null);
    expect(score.report).toBe(false);
    for (const [kind, k] of Object.entries(score.kinds)) {
      expect(k.matched, kind).toBe(0);
      expect(k.recall, kind).toBe(k.expected ? 0 : 1);
      expect(k.precision, kind).toBeNull();
    }
  });

  it('matches kind and rule exactly, and both ends', () => {
    expect(rowMatches(violation, asFinding(violation))).toBe(true);
    expect(rowMatches(violation, asFinding(violation, { kind: 'skipped' }))).toBe(false);
    expect(rowMatches(violation, asFinding(violation, { rule: 'private-layer' }))).toBe(false);
    expect(rowMatches(violation, asFinding(violation, { edgeType: 'import' }))).toBe(false);
    expect(rowMatches(violation, asFinding(violation, { target: { file: violation.to!.file, element: 'App\\Y\\Other' } }))).toBe(false);
    expect(rowMatches(violation, asFinding(violation, { source: { file: 'app/Elsewhere.php', element: `App\\X\\${violation.from!.symbol}` } }))).toBe(false);
  });

  it('counts a finding on an allowed or same-layer row as a false positive', () => {
    const allowed = php.find((r) => r.kind === 'allowed')!;
    const none = php.find((r) => r.kind === 'none')!;
    const fp = (r: ExpectedRow) => asFinding({ ...r, kind: 'violation', rule: 'disallowed-layer' });
    const score = scoreApp('php', php, { findings: [asFinding(violation), fp(allowed), fp(none)] });
    expect(score.kinds.violation).toMatchObject({ reported: 3, matched: 1 });
    expect(score.kinds.violation.precision).toBeCloseTo(1 / 3);
    expect(score.negativeHits).toEqual([allowed.id, none.id]);
  });

  it('scores a perfect report as recall and precision 1, counting one dependency once whatever edge types carry it', () => {
    const positives = php.filter((r) => r.kind !== 'allowed' && r.kind !== 'none');
    const findings = positives.flatMap((r) => [asFinding(r), ...(r.edgeType ? [asFinding(r, { edgeType: undefined })] : [])]);
    const score = combine([scoreApp('php', php, { findings })]);
    for (const [kind, k] of Object.entries(score.kinds)) {
      expect(k.recall, kind).toBe(1);
      if (k.expected) expect(k.precision, kind).toBe(1);
    }
  });

  it('a duplicate on another edge type, reported first, does not hide the matching finding (review 2026-11-02)', () => {
    const positives = php.filter((r) => r.kind !== 'allowed' && r.kind !== 'none');
    const other = (t?: string) => (t === 'import' ? 'call' : 'import');
    const findings = positives.flatMap((r) => [...(r.edgeType ? [asFinding(r, { edgeType: other(r.edgeType) })] : []), asFinding(r)]);
    const score = combine([scoreApp('php', php, { findings })]);
    for (const [kind, k] of Object.entries(score.kinds)) {
      expect(k.recall, kind).toBe(1);
      if (k.expected) expect(k.precision, kind).toBe(1);
    }
  });

  it('matches element names across languages by their last segment', () => {
    for (const element of ['App\\Domain\\Order', 'app.domain.order.Order', 'src/domain/Order.ts#Order', 'example.com/shop/domain.Order', 'Order']) {
      expect(elementMatches(element, 'Order'), element).toBe(true);
    }
    expect(elementMatches('App\\Domain\\OrderId', 'Order')).toBe(false);
    expect(elementMatches(undefined, 'Order')).toBe(false);
    expect(elementMatches(undefined, undefined)).toBe(true);
  });
});

// M5-16-R1: the smells block (expected-smells.json), labelled apart from the findings.
describe('the smell labels', () => {
  it('have unique ids, known apps, and files that exist; every complete kind is a known rule smell', () => {
    expect(new Set(smellLabels.rows.map((r) => r.id)).size).toBe(smellLabels.rows.length);
    // Every app of the findings, and the apps that only label smells (scanned by the scorer too).
    expect(Object.keys(smellLabels.complete).sort()).toEqual([...Object.keys(expected.apps), ...Object.keys(smellLabels.apps ?? {})].sort());
    expect(Object.keys(smellLabels.apps ?? {}).every((a) => !(a in expected.apps) && existsSync(join(FIXTURE, a)))).toBe(true);
    for (const r of smellLabels.rows) {
      expect(smellLabels.complete[r.app], r.id).toContain(r.type);
      expect(r.evidence.length, r.id).toBeGreaterThan(10);
      for (const f of r.files ?? []) expect(existsSync(join(FIXTURE, r.app, f)), `${r.id}: ${f}`).toBe(true);
    }
    // Every scored kind has at least one positive row (no kind is scored on its absence alone), and each row
    // cites the line (`path:N`) of the source or configuration that makes it true.
    expect([...new Set(smellLabels.rows.map((r) => r.type))].sort()).toEqual([
      'architecture-config', 'baseline-debt', 'deprecated-usage', 'dev-dependency-in-prod', 'layer-cycle', 'layer-skip', 'layer-violation', 'orphan-element', 'undeclared-dependency', 'vendor-leak',
    ]);
    for (const r of smellLabels.rows) {
      const cited = [...r.evidence.matchAll(/([\w.\-]+\/[^\s`]+?):(\d+) `/g)];
      expect(cited.length, `${r.id}: evidence cites no source line`).toBeGreaterThan(0);
      for (const [, file, n] of cited) {
        const lines = readFileSync(join(FIXTURE, file!), 'utf8').split('\n');
        expect(lines[Number(n) - 1]?.trim().length, `${r.id}: ${file}:${n} is a line of the fixture`).toBeGreaterThan(0);
      }
    }
  });

  it('are scored per kind over the apps that label the kind as complete: a miss lowers recall, an extra lowers precision', () => {
    const labels = { version: 1, complete: { a: ['layer-cycle', 'orphan-element'], b: ['layer-cycle'] }, rows: [
      { id: 'a2', app: 'a', type: 'layer-cycle', layers: ['P', 'Q'], evidence: 'x' },
      { id: 'a1', app: 'a', type: 'layer-cycle', layers: ['X', 'Y'], evidence: 'x' },
      { id: 'a3', app: 'a', type: 'dead-allowance', layers: ['P', 'Q'], evidence: 'x' }, // not complete for a: not scored
    ] };
    const smell = (type: string, layers: string[], source = 'rules'): ReportedSmell => ({ type, source, description: type, involvedLayers: layers });
    const score = scoreSmells(labels, new Map([
      ['a', [smell('layer-cycle', ['Y', 'X']), smell('orphan-element', []), smell('dead-allowance', ['P', 'Q'])]],
      ['b', [smell('layer-cycle', ['M', 'N']), smell('layer-cycle', ['M', 'N'], 'inferred-roles')]],
    ]));
    expect(score.kinds['layer-cycle']).toEqual({ expected: 2, reported: 2, matched: 1, recall: 0.5, precision: 0.5 });
    expect(score.kinds['orphan-element']).toMatchObject({ expected: 0, reported: 1, matched: 0, recall: 1, precision: 0 });
    expect(score.kinds['dead-allowance']).toBeUndefined();
    expect(score.misses).toEqual(['a: a2']);
    expect(score.extras).toEqual(['a: orphan-element orphan-element', 'b: layer-cycle layer-cycle']);
  });
});

// M5-16-R1 review: the smells' floor is 1.0 on the labelled rows, and the registered command enforces it.
describe('the smell floor', () => {
  const score = (fixture: string) => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../scripts/eval/score-arch.ts'), fixture, '--app', 'ts-smells', '--json'], { encoding: 'utf8', cwd: resolve(__dirname, '..') });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };

  it('a missed row and an unlabelled smell each fail the run; the labelled fixture passes', () => {
    const copy = mkdtempSync(join(tmpdir(), 'mapx-smell-floor-'));
    try {
      cpSync(FIXTURE, copy, { recursive: true });
      const ok = score(copy);
      expect(ok.status).toBe(0);
      expect(ok.out.failures).toEqual([]);
      expect(ok.out.smells.kinds['layer-skip']).toMatchObject({ expected: 1, matched: 1, recall: 1, precision: 1 });
      // A smell with no row (precision < 1 on a complete kind): the skip row is removed.
      const file = join(copy, 'expected-smells.json');
      const labels = JSON.parse(readFileSync(file, 'utf8')) as { rows: Array<{ id: string; layers?: string[] }> };
      const skip = labels.rows.find((r) => r.id === 'ts-smells-skip')!;
      writeFileSync(file, JSON.stringify({ ...labels, rows: labels.rows.filter((r) => r !== skip) }));
      const extra = score(copy);
      expect(extra.status).toBe(1);
      expect(extra.out.failures.join('\n')).toContain('smell not labelled ts-smells: layer-skip');
      // A row no smell matches (recall < 1): the skip row names layers the scan does not report.
      writeFileSync(file, JSON.stringify({ ...labels, rows: labels.rows.map((r) => (r === skip ? { ...r, layers: ['Controller', 'Repository'] } : r)) }));
      const missed = score(copy);
      expect(missed.status).toBe(1);
      expect(missed.out.failures.join('\n')).toContain('smell missed ts-smells: ts-smells-skip');
      expect(missed.out.smells.kinds['layer-skip']).toMatchObject({ expected: 1, matched: 0, recall: 0 });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('the real-scan score (`mapx check`, M5-04 evaluator, M5-06 baseline, M5-11 internal markers)', () => {
  // Every labelled row is found, and nothing else is (M5-11 found the last ones: internal-element).
  it('score-arch.ts finds every row, and nothing else', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../scripts/eval/score-arch.ts'), FIXTURE, '--json'], { encoding: 'utf8', cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    const score = JSON.parse(out);
    expect(score.apps).toHaveLength(Object.keys(expected.apps).length); // the smell-only app has no findings to score
    expect(score.apps.every((a: any) => a.report)).toBe(true);
    expect(score.apps.flatMap((a: any) => a.misses)).toEqual([]);
    expect(score.apps.flatMap((a: any) => a.negativeHits)).toEqual([]);
    // Recall and precision 1 for every kind: violations (internal-element included), skipped
    // (php-07), uncovered, warning and error rows (the + cycle and php-26's stale baseline entry, M5-06).
    for (const kind of ['violation', 'skipped', 'uncovered', 'warning', 'error']) expect(score.kinds[kind], kind).toMatchObject({ recall: 1, precision: 1 });
    // No false positive: the baseline's pair skips both edges of php-07 (import and instantiation).
    const violation = score.kinds.violation;
    expect(violation.reported).toBe(violation.matched);
    expect(violation.expected).toBe(rows.filter((r) => r.kind === 'violation').length);
    // M5-24: findings on packages outside the workspace, per ecosystem: uncovered, vendor-confinement
    // and dev-dependency rows all found, nothing else reported.
    for (const eco of ['npm', 'composer', 'pypi', 'go']) {
      const k = score.externalFindings[eco];
      expect(k, eco).toMatchObject({ recall: 1, precision: 1 });
      for (const category of ['uncovered', 'vendor-confinement', 'dev-dependency']) {
        expect(k.categories[category].expected, `${eco} ${category}`).toBeGreaterThan(0);
        expect(k.categories[category].matched, `${eco} ${category}`).toBe(k.categories[category].expected);
      }
    }
    // M5-16-R1: the smells, per kind. Every labelled row is found and no other smell of a complete kind is
    // reported: recall and precision 1 for each of the ten kinds, each with at least one labelled row.
    expect(score.smells.misses).toEqual([]);
    expect(score.smells.extras).toEqual([]);
    expect(Object.keys(score.smells.kinds).sort()).toEqual([...new Set(smellLabels.rows.map((r) => r.type))].sort());
    for (const kind of Object.keys(score.smells.kinds)) {
      expect(score.smells.kinds[kind], kind).toMatchObject({ recall: 1, precision: 1 });
      expect(score.smells.kinds[kind].expected, kind).toBe(smellLabels.rows.filter((r) => r.type === kind).length);
      expect(score.smells.kinds[kind].expected, kind).toBeGreaterThan(0);
    }
    expect(score.failures).toEqual([]);
  }, 300_000);
});
