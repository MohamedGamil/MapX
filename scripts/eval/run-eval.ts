// Scores the labelled fixtures against the floors recorded in scripts/eval/floors.json (M4-01).
// Usage:
//   npx tsx scripts/eval/run-eval.ts [--json] [--floors <file>]     (npm run eval)
// Each scorer (routes, http, edges) runs its own scan and score functions; every floor is checked
// on the scorer's totals or per pattern. When GITHUB_STEP_SUMMARY is set a Markdown summary is
// appended to it. Exit code 1 when a floor is missed; 2 on usage, floors-file or scan errors.
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanFixture, score, type Label, type Score } from './score-routes.ts';
import { scanHttpFixture, scoreHttp, type HttpLabel, type HttpScore } from './score-http.ts';
import { DEFAULT_SCORED_TYPES, loadExpected, scanEdgeFixture, scoreEdges, type EdgeScore } from './score-edges.ts';

const ROOT = resolve(import.meta.dirname, '../..');
export const FLOORS_FILE = resolve(import.meta.dirname, 'floors.json');

export interface Bounds {
  min?: Record<string, number>;
  max?: Record<string, number>;
}
export interface ScorerFloors extends Bounds {
  /** Fixture directory, relative to the repository root. */
  fixture: string;
  /** routes only: compare parameter names (score-routes `--strict-params`). */
  strictParams?: boolean;
  /** Per-pattern bounds; `*` applies to every pattern and a named pattern overrides it per metric. */
  patterns?: Record<string, Bounds>;
}
export type Floors = Record<string, ScorerFloors>;

interface Result {
  totals: Record<string, number>;
  patterns: Record<string, Record<string, unknown>>;
}
interface Scorer {
  totals: readonly string[];
  patternMetrics: readonly string[];
  /** Pattern names of the fixture's labels, read before any scan. */
  patterns(fixture: string): string[];
  run(fixture: string, floors: ScorerFloors): Result;
}

type Numeric<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T] & string;
const keys = <T>() => <const K extends readonly Numeric<T>[]>(k: K) => k;
const labelsOf = <T>(fixture: string) => (JSON.parse(readFileSync(join(fixture, 'labels.json'), 'utf8')) as { labels: T[] }).labels;
const unique = (xs: string[]) => [...new Set(xs)];

export const SCORERS: Record<string, Scorer> = {
  routes: {
    totals: keys<Score['totals']>()(['uriRecall', 'handlerRecall', 'attributeRecall', 'precision', 'falsePositives', 'unlabelled',
      'reported', 'labelled', 'uriFound', 'handlerLabelled', 'handlerFound', 'exactParams', 'flagged', 'attributesLabelled', 'attributesFound']),
    patternMetrics: keys<Score['patterns'][string]>()(['labelled', 'uriFound', 'handlerLabelled', 'handlerFound', 'exactParams',
      'flagged', 'falsePositives', 'attributesLabelled', 'attributesFound']),
    patterns: (fixture) => unique(labelsOf<Label>(fixture).map((l) => l.pattern)),
    run: (fixture, floors) => score(labelsOf<Label>(fixture), scanFixture(fixture), floors.strictParams ?? false) as unknown as Result,
  },
  http: {
    totals: keys<HttpScore['totals']>()(['callSiteRecall', 'urlRecall', 'pairingRecall', 'pairingPrecision', 'unlabelled', 'reported',
      'labelled', 'found', 'urlResolved', 'pairLabelled', 'pairedCorrect', 'unmatchedLabelled', 'unmatchedCorrect', 'wrongPairs']),
    patternMetrics: keys<HttpScore['patterns'][string]>()(['labelled', 'found', 'urlResolved', 'pairLabelled', 'pairedCorrect',
      'unmatchedLabelled', 'unmatchedCorrect', 'wrongPairs']),
    patterns: (fixture) => unique(labelsOf<HttpLabel>(fixture).map((l) => l.pattern)),
    run: (fixture) => scoreHttp(labelsOf<HttpLabel>(fixture), scanHttpFixture(fixture)) as unknown as Result,
  },
  edges: {
    totals: keys<EdgeScore['totals']>()(['recall', 'precision', 'falsePositives', 'unlabelled', 'reported', 'correct', 'labelled', 'found', 'negatives']),
    patternMetrics: keys<EdgeScore['patterns'][string]>()(['recall', 'falsePositives', 'labelled', 'found', 'negatives']),
    patterns: (fixture) => unique(loadExpected(fixture).labels.map((l) => l.pattern)),
    run: (fixture) => {
      const expected = loadExpected(fixture);
      const { edges, symbols } = scanEdgeFixture(fixture, expected.roots);
      return scoreEdges(expected.labels, edges, symbols, expected.scoredTypes ?? DEFAULT_SCORED_TYPES) as unknown as Result;
    },
  },
};

const isRatio = (metric: string) => /recall|precision/i.test(metric);

/** Reads a floors file; `$`-prefixed keys are comments. */
export function readFloors(file: string): Floors {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('$'))) as Floors;
}

/**
 * Every problem with a floors file, checked before any scan: an unknown scorer, metric or pattern,
 * a missing fixture, a ratio floor outside [0, 1] or a count that is not a non-negative integer.
 */
export function validateFloors(floors: Floors, root = ROOT): string[] {
  const errors: string[] = [];
  const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  const checkBounds = (where: string, bounds: Bounds, allowed: readonly string[]) => {
    for (const key of Object.keys(bounds)) if (key !== 'min' && key !== 'max') errors.push(`${where}: unknown key ${key}`);
    for (const side of ['min', 'max'] as const) {
      if (bounds[side] === undefined) continue;
      if (!isObject(bounds[side])) {
        errors.push(`${where}: ${side} is not an object`);
        continue;
      }
      for (const [metric, value] of Object.entries(bounds[side]!)) {
        if (!allowed.includes(metric)) errors.push(`${where}: unknown metric ${side}.${metric}`);
        else if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${where}: ${side}.${metric} is not a number`);
        else if (isRatio(metric) ? value < 0 || value > 1 : value < 0 || !Number.isInteger(value))
          errors.push(`${where}: ${side}.${metric} = ${value} is not ${isRatio(metric) ? 'in [0, 1]' : 'a non-negative integer'}`);
      }
    }
  };
  if (!Object.keys(floors).length) errors.push('no scorers');
  for (const [name, f] of Object.entries(floors)) {
    const scorer = SCORERS[name];
    if (!scorer) {
      errors.push(`unknown scorer ${name} (known: ${Object.keys(SCORERS).join(', ')})`);
      continue;
    }
    if (!isObject(f)) {
      errors.push(`${name}: not an object`);
      continue;
    }
    if (typeof f.fixture !== 'string') {
      errors.push(`${name}: fixture missing`);
      continue;
    }
    for (const key of Object.keys(f))
      if (!['fixture', 'min', 'max', 'patterns', ...(name === 'routes' ? ['strictParams'] : [])].includes(key)) errors.push(`${name}: unknown key ${key}`);
    if (f.strictParams !== undefined && typeof f.strictParams !== 'boolean') errors.push(`${name}: strictParams is not a boolean`);
    if (f.patterns !== undefined && !isObject(f.patterns)) errors.push(`${name}: patterns is not an object`);
    const bounded = (b: Bounds | undefined) => Object.keys(b?.min ?? {}).length + Object.keys(b?.max ?? {}).length > 0;
    if (!bounded(f) && !Object.values(isObject(f.patterns) ? f.patterns : {}).some((b) => isObject(b) && bounded(b)))
      errors.push(`${name}: no floors`);
    checkBounds(name, { min: f.min, max: f.max }, scorer.totals);
    let known: string[];
    try {
      known = scorer.patterns(resolve(root, f.fixture));
    } catch (err) {
      errors.push(`${name}: cannot read the labels of ${f.fixture}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const [pattern, bounds] of Object.entries(isObject(f.patterns) ? f.patterns : {})) {
      if (pattern !== '*' && !known.includes(pattern)) errors.push(`${name}: unknown pattern ${pattern}`);
      if (!isObject(bounds)) {
        errors.push(`${name}.${pattern}: not an object`);
        continue;
      }
      checkBounds(`${name}.${pattern}`, bounds, scorer.patternMetrics);
    }
  }
  return errors;
}

export interface Check {
  /** `totals` or a pattern name. */
  scope: string;
  metric: string;
  kind: 'min' | 'max';
  floor: number;
  value: number;
  ok: boolean;
}

/** Every floor of one scorer checked against its result. */
export function checkFloors(result: Result, floors: ScorerFloors): Check[] {
  const checks: Check[] = [];
  const check = (scope: string, values: Record<string, unknown>, bounds: Bounds) => {
    for (const kind of ['min', 'max'] as const)
      for (const [metric, floor] of Object.entries(bounds[kind] ?? {})) {
        const value = values[metric];
        const v = typeof value === 'number' ? value : Number.NaN;
        checks.push({ scope, metric, kind, floor, value: v, ok: kind === 'min' ? v >= floor : v <= floor });
      }
  };
  check('totals', result.totals, floors);
  const patterns = floors.patterns ?? {};
  const all = patterns['*'];
  for (const name of Object.keys(result.patterns)) {
    const own = patterns[name];
    if (!all && !own) continue;
    check(name, result.patterns[name]!, {
      min: { ...all?.min, ...own?.min },
      max: { ...all?.max, ...own?.max },
    });
  }
  return checks;
}

const fmt = (metric: string, x: number) => (isRatio(metric) ? x.toFixed(4).replace(/\.?0+$/, '') || '0' : String(x));
/** The value as printed beside its floor: full precision when four decimals would print them equal. */
const fmtValue = (c: Check) => (c.value !== c.floor && fmt(c.metric, c.value) === fmt(c.metric, c.floor) ? String(c.value) : fmt(c.metric, c.value));
export const describeFailure = (c: Check) =>
  `${c.scope === 'totals' ? '' : `${c.scope} `}${c.metric} ${fmtValue(c)} ${c.kind === 'min' ? '<' : '>'} ${fmt(c.metric, c.floor)}`;

function parseArgs(args: string[]): { json: boolean; floorsFile: string } {
  let json = false;
  let floorsFile = FLOORS_FILE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--floors') {
      const v = args[++i];
      if (!v || v.startsWith('--')) throw new Error('--floors needs a value');
      // `npm run eval` runs from the package root; INIT_CWD is where it was invoked.
      floorsFile = resolve(process.env.INIT_CWD ?? process.cwd(), v);
    } else throw new Error(`unknown argument ${a}`);
  }
  return { json, floorsFile };
}

function main() {
  let floors: Floors;
  let json: boolean;
  try {
    const opts = parseArgs(process.argv.slice(2));
    json = opts.json;
    floors = readFloors(opts.floorsFile);
    const errors = validateFloors(floors);
    if (errors.length) throw new Error(`invalid floors file ${opts.floorsFile}:\n  ${errors.join('\n  ')}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error('Usage: run-eval.ts [--json] [--floors <file>]');
    process.exit(2);
  }

  const report: Record<string, { checks: Check[]; failures: string[]; seconds: number }> = {};
  const scanErrors: string[] = [];
  for (const [name, f] of Object.entries(floors)) {
    const started = Date.now();
    let result: Result;
    try {
      result = SCORERS[name]!.run(resolve(ROOT, f.fixture), f);
    } catch (err) {
      scanErrors.push(`${name}: scan failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const checks = checkFloors(result, f);
    report[name] = { checks, failures: checks.filter((c) => !c.ok).map(describeFailure), seconds: (Date.now() - started) / 1000 };
  }
  const failures = Object.entries(report).flatMap(([name, r]) => r.failures.map((f) => `${name}: ${f}`));

  if (json) console.log(JSON.stringify({ ok: !failures.length && !scanErrors.length, scorers: report, failures, scanErrors }, null, 2));
  else {
    for (const [name, r] of Object.entries(report)) {
      const totals = r.checks.filter((c) => c.scope === 'totals');
      const perPattern = r.checks.filter((c) => c.scope !== 'totals');
      console.log(`\n${name} (${floors[name]!.fixture}, ${r.seconds.toFixed(1)} s)`);
      for (const c of totals)
        console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.metric.padEnd(18)} ${fmtValue(c).padStart(7)}  ${c.kind === 'min' ? '>=' : '<='} ${fmt(c.metric, c.floor)}`);
      if (perPattern.length) {
        const patterns = new Set(perPattern.map((c) => c.scope));
        const failed = new Set(perPattern.filter((c) => !c.ok).map((c) => c.scope));
        console.log(`  ${failed.size ? 'FAIL' : 'ok  '} per-pattern floors: ${patterns.size - failed.size}/${patterns.size} patterns hold`);
        for (const c of perPattern.filter((x) => !x.ok)) console.log(`       ${describeFailure(c)}`);
      }
      const raisable = r.checks.filter((c) => c.ok && c.value !== c.floor && c.scope === 'totals');
      for (const c of raisable) console.log(`  note: ${c.metric} is ${fmtValue(c)}; its ${c.kind} floor ${fmt(c.metric, c.floor)} can be ${c.kind === 'min' ? 'raised' : 'lowered'}`);
    }
    console.log(failures.length ? `\n${failures.length} floor(s) missed` : '\nAll floors hold');
  }
  for (const f of failures) console.error(`FAIL ${f}`);
  for (const e of scanErrors) console.error(e);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rows = Object.entries(report).flatMap(([name, r]) => r.checks.filter((c) => c.scope === 'totals' || !c.ok).map((c) =>
      `| ${name} | ${c.scope === 'totals' ? '' : c.scope} | ${c.metric} | ${fmtValue(c)} | ${c.kind === 'min' ? '≥' : '≤'} ${fmt(c.metric, c.floor)} | ${c.ok ? 'ok' : '**FAIL**'} |`));
    appendFileSync(summaryFile, ['## Fixture accuracy (npm run eval)', '', '| Scorer | Pattern | Metric | Value | Floor | |', '| --- | --- | --- | --- | --- | --- |', ...rows, '',
      ...scanErrors.map((e) => `**${e.split('\n')[0]}**`), failures.length ? `${failures.length} floor(s) missed.` : 'All floors hold.', ''].join('\n'));
  }
  process.exitCode = scanErrors.length ? 2 : failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
