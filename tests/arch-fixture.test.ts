import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, loadArchitectureConfig } from '../src/arch/config.js';
import { combine, elementMatches, loadExpected, rowMatches, scoreApp, type ExpectedRow, type ReportedFinding } from '../scripts/eval/score-arch.js';

// M5-01: the labelled architecture-rules fixture and its scorer (AR-08 chain, AR-09 kinds, AR-10 baseline).
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');
const expected = loadExpected(FIXTURE);
const rows = expected.rows;
const LANGUAGES = { php: 'php', ts: 'typescript', python: 'python', go: 'go' } as const;

describe('the fixture', () => {
  it('has at least 60 labelled rows with unique ids, each naming files and symbols that exist', () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(Object.keys(expected.apps), r.id).toContain(r.app);
      for (const end of [r.from, r.to]) {
        if (!end) continue;
        const path = join(FIXTURE, r.app, end.file);
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
    expect(baseline.entries).toHaveLength(2);
    const skipped = rows.filter((r) => r.app === 'php' && r.kind === 'skipped');
    const stale = rows.filter((r) => r.app === 'php' && r.rule === 'stale-baseline');
    expect(skipped).toHaveLength(1);
    expect(stale).toEqual([expect.objectContaining({ kind: 'error' })]);
    expect(baseline.entries[0].source.endsWith(skipped[0]!.from!.symbol!)).toBe(true);
    expect(baseline.entries[0].target.endsWith(skipped[0]!.to!.symbol!)).toBe(true);
    expect(baseline.entries[1].source.endsWith(stale[0]!.from!.symbol!)).toBe(true);
    const ws = rows.filter((r) => r.app === 'workspace');
    // workspace-03 was added by M5-04: the route file's import of the API controller (Backend → PublicApi).
    expect(ws.map((r) => [r.kind, r.edgeType])).toEqual([['allowed', 'http'], ['violation', 'http'], ['violation', 'import']]);
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
    target: r.to && { file: r.to.file, element: r.to.symbol && `App\\Y\\${r.to.symbol}` },
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

describe('the real-scan score (M5-04 evaluator, in-process until mapx check exists)', () => {
  // Rows later tasks own: the baseline (M5-06: php-07 skipped, php-26 stale entry) and @internal
  // markers (M5-10/M5-11: internal-element). Every other labelled row is found, and nothing else is.
  const LATER = (r: (typeof rows)[number]) => r.kind === 'skipped' || r.rule === 'stale-baseline' || r.rule === 'internal-element';

  it('score-arch.ts finds every row but those later tasks own, with no false positive beyond the baselined one', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', resolve(__dirname, '../scripts/eval/score-arch.ts'), FIXTURE, '--json'], { encoding: 'utf8', cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    const score = JSON.parse(out);
    expect(score.apps).toHaveLength(Object.keys(expected.apps).length);
    expect(score.apps.every((a: any) => a.report)).toBe(true);
    const misses = score.apps.flatMap((a: any) => a.misses).sort();
    expect(misses).toEqual(rows.filter(LATER).map((r) => r.id).sort());
    expect(score.apps.flatMap((a: any) => a.negativeHits)).toEqual([]);
    // Recall 1 for uncovered, warning and error rows; precision 1 for all but violation, whose one
    // extra finding is php-07 reported as a violation until M5-06 applies the baseline.
    for (const kind of ['uncovered', 'warning']) expect(score.kinds[kind], kind).toMatchObject({ recall: 1, precision: 1 });
    expect(score.kinds.error).toMatchObject({ matched: 1, reported: 1 }); // the + cycle; the stale entry is M5-06's
    const violation = score.kinds.violation;
    const later = rows.filter((r) => r.kind === 'violation' && LATER(r)).length;
    expect(violation.matched).toBe(violation.expected - later);
    expect(violation.reported).toBe(violation.matched + 1);
    // …and that one is php-07: the PHP app's only unmatched violation is Order → SqlOrderRepository.
    const php = score.apps.find((a: any) => a.app === 'php');
    expect(php.kinds.violation.reported - php.kinds.violation.matched).toBe(1);
    expect(php.misses).toContain('php-07');
    expect(score.failures).toEqual([]);
  }, 300_000);
});
