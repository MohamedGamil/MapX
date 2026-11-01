import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkFloors, describeFailure, FLOORS_FILE, readFloors, validateFloors, type Floors } from '../scripts/eval/run-eval.ts';

// M4-01: `npm run eval` checks every scorer against scripts/eval/floors.json, the single record of
// floors that the fixture tests also read, and CI runs it as its own job.
const ROOT = resolve(__dirname, '..');
const RUN_EVAL = join(ROOT, 'scripts/eval/run-eval.ts');
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');

function runEval(floors: unknown, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mapx-eval-'));
  try {
    const file = join(dir, 'floors.json');
    writeFileSync(file, JSON.stringify(floors));
    execFileSync(process.execPath, [TSX, RUN_EVAL, '--floors', file, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    return { code: 0, stdout: '', stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('floors.json', () => {
  it('validates and bounds the three fixtures', () => {
    const floors = readFloors(FLOORS_FILE);
    expect(validateFloors(floors)).toEqual([]);
    expect(Object.fromEntries(Object.entries(floors).map(([k, f]) => [k, f.fixture]))).toEqual({
      routes: 'tests/fixtures/laravel-routes', http: 'tests/fixtures/vue-http', edges: 'tests/fixtures/vue-sfc',
    });
    expect(floors.routes!.min).toMatchObject({ uriRecall: 1, handlerRecall: 1, precision: 1 });
    expect(floors.http!.min).toMatchObject({ callSiteRecall: 1, pairingRecall: 1 });
    expect(floors.edges!.min).toMatchObject({ recall: 1 });
  });

  it('rejects unknown scorers, metrics, patterns and out-of-range floors', () => {
    const http = { fixture: 'tests/fixtures/vue-http' };
    expect(validateFloors({ grpc: http } as Floors)).toEqual([expect.stringMatching(/^unknown scorer grpc/)]);
    expect(validateFloors({ http: { ...http, min: { callSiteRecal: 1 } } })).toEqual(['http: unknown metric min.callSiteRecal']);
    expect(validateFloors({ http: { ...http, min: { callSiteRecall: 1.5 } } })).toEqual(['http: min.callSiteRecall = 1.5 is not in [0, 1]']);
    expect(validateFloors({ http: { ...http, max: { wrongPairs: 0.5 } } })).toEqual(['http: max.wrongPairs = 0.5 is not a non-negative integer']);
    expect(validateFloors({ http: { ...http, max: { wrongPairs: '0' as unknown as number } } })).toEqual(['http: max.wrongPairs is not a number']);
    expect(validateFloors({ http: { ...http, patterns: { fetchh: { min: { found: 1 } } } } })).toEqual(['http: unknown pattern fetchh']);
    expect(validateFloors({ edges: { fixture: 'tests/fixtures/vue-sfc', patterns: { '*': { min: { precision: 1 } } } } }))
      .toEqual(['edges.*: unknown metric min.precision']);
    expect(validateFloors({ http: { ...http, strictParams: true, min: { urlRecall: 1 } } })).toEqual(['http: unknown key strictParams']);
    expect(validateFloors({ http: { fixture: 'tests/fixtures/none', min: { urlRecall: 1 } } })).toEqual([expect.stringMatching(/^http: cannot read the labels/)]);
    expect(validateFloors({})).toEqual(['no scorers']);
    // Review 2026-11-01: malformed bounds were accepted and checked nothing.
    const bad = (f: unknown) => validateFloors({ http: { ...http, ...(f as object) } } as Floors);
    expect(bad({ min: 1 })).toEqual(['http: no floors', 'http: min is not an object']);
    expect(bad({ min: null, max: { wrongPairs: 0 } })).toEqual(['http: min is not an object']);
    expect(bad({ patterns: 5, min: { urlRecall: 1 } })).toEqual(['http: patterns is not an object']);
    expect(bad({ patterns: { '*': 1 }, min: { urlRecall: 1 } })).toEqual(['http.*: not an object']);
    expect(bad({})).toEqual(['http: no floors']);
    expect(validateFloors({ routes: { fixture: 'tests/fixtures/laravel-routes', strictParams: 'false' as unknown as boolean, min: { precision: 1 } } }))
      .toEqual(['routes: strictParams is not a boolean']);
    expect(validateFloors({ http: null } as unknown as Floors)).toEqual(['http: not an object']);
  });
});

describe('checkFloors', () => {
  const result = {
    totals: { recall: 0.9, precision: 1, falsePositives: 2 },
    patterns: { a: { recall: 1, falsePositives: 0 }, b: { recall: 0.5, falsePositives: 2 } },
  };

  it('checks totals against min and max', () => {
    const checks = checkFloors(result, { fixture: 'x', min: { recall: 0.9, precision: 1 }, max: { falsePositives: 1 } });
    expect(checks.filter((c) => !c.ok).map(describeFailure)).toEqual(['falsePositives 2 > 1']);
    expect(checks.map((c) => c.metric)).toEqual(['recall', 'precision', 'falsePositives']);
  });

  it('applies the * pattern bounds to every pattern, a named pattern overriding per metric', () => {
    const checks = checkFloors(result, {
      fixture: 'x',
      patterns: { '*': { min: { recall: 1 }, max: { falsePositives: 0 } }, b: { max: { falsePositives: 2 } } },
    });
    expect(checks.filter((c) => !c.ok).map(describeFailure)).toEqual(['b recall 0.5 < 1']);
    expect(checks.filter((c) => c.scope === 'b').map((c) => `${c.kind}.${c.metric}=${c.floor}`)).toEqual(['min.recall=1', 'max.falsePositives=2']);
  });

  it('never prints a missed ratio floor as equal to its value', () => {
    const [c] = checkFloors({ totals: { recall: 0.99996 }, patterns: {} }, { fixture: 'x', min: { recall: 1 } });
    expect(describeFailure(c!)).toBe('recall 0.99996 < 1');
  });

  it('fails a floor whose metric is missing from the result', () => {
    const checks = checkFloors({ totals: {}, patterns: {} }, { fixture: 'x', min: { recall: 0 } });
    expect(checks.map((c) => c.ok)).toEqual([false]);
  });
});

describe('npm run eval (CLI)', () => {
  it('exits 2 on an invalid floors file before scanning', () => {
    const r = runEval({ http: { fixture: 'tests/fixtures/vue-http', min: { pairingRecal: 1 } } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('http: unknown metric min.pairingRecal');
  });

  it('exits 2 on an unknown argument', () => {
    const r = runEval({ http: { fixture: 'tests/fixtures/vue-http' } }, '--min-recall', '1');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown argument --min-recall');
  });

  it('scores the real fixture and exits 1 naming only the floor it misses', () => {
    // The HTTP scorer counts one reported call no label covers (totals.unlabelled 1, measured at M4-01), so max.unlabelled 0 fails.
    const r = runEval({ http: { fixture: 'tests/fixtures/vue-http', min: { callSiteRecall: 1 }, max: { unlabelled: 0 } } });
    expect(r.code).toBe(1);
    expect(r.stderr.trim().split('\n')).toEqual(['FAIL http: unlabelled 1 > 0']);
    expect(r.stdout).toMatch(/ok {3}callSiteRecall +1 {2}>= 1/);
    expect(r.stdout).toMatch(/FAIL unlabelled +1 {2}<= 0/);
  }, 120000);
});

describe('CI workflow', () => {
  it('has an Eval job that runs npm run eval after lint', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    // The job block: from its key at two-space indent to the next job key.
    const job = ci.match(/^ {2}eval:\n((?: {4,}.*\n|\n)+)/m)?.[1] ?? '';
    expect(job).toMatch(/^ {4}name: Eval$/m);
    expect(job).toMatch(/^ {4}needs: lint$/m);
    expect(job).toMatch(/^ {8}run: npm ci --legacy-peer-deps$/m);
    expect(job).toMatch(/^ {8}run: npm run eval$/m);
    expect(ci).not.toMatch(/\t/);
  });
});
