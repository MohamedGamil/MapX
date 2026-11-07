// Scores MapX graph edges (and a few symbols) against a labelled fixture (docs/baton M3-01).
// Copies the fixture (or each of its `roots`, as separate projects) to a temp dir, runs the real
// CLI (init + scan) and reads .mapx/mapx.db.
//   npx tsx scripts/eval/score-edges.ts <fixture-dir> [--json] [--min-recall R | pattern=R]...
//     [--max-fp N | pattern=N]... [--min-precision P]
// A bare number applies to the totals; `pattern=value` applies to one pattern. Each key may be
// given once; recall and precision are in [0, 1], false positives an integer >= 0.
// Exit code 1 when a threshold is missed; 2 on usage or scan errors.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/** An edge as the store holds it (edges table); files are fixture-relative POSIX paths. */
export interface StoredEdge {
  source_file: string;
  source_symbol: string | null;
  target_file: string;
  target_symbol: string | null;
  edge_type: string;
}
export interface StoredSymbol {
  file_path: string;
  name: string;
  kind: string;
  scope: string | null;
  metadata: Record<string, unknown>;
}
export interface ExpectedSymbol {
  file: string;
  name: string;
  kind: string;
  /** Each listed key must be an array on the stored symbol containing every listed value. */
  metadata?: Record<string, string[]>;
}
export interface EdgeLabel {
  id: string;
  pattern: string;
  version: string;
  /** `absent`: a negative, this edge must not exist (a stored match is a false positive). */
  expect?: 'present' | 'absent';
  edge?: StoredEdge;
  symbol?: ExpectedSymbol;
  note?: string;
}
export interface ExpectedFile {
  /** Edge types counted for precision; other types are ignored (default DEFAULT_SCORED_TYPES). */
  scoredTypes?: string[];
  /**
   * Sub-folders scanned as separate projects (each with its own package.json, so framework
   * detection runs as in a real app); stored paths are prefixed with `<root>/`. Default: the
   * whole fixture as one project.
   */
  roots?: string[];
  labels: EdgeLabel[];
}
interface Counts {
  labelled: number;
  found: number;
  negatives: number;
  falsePositives: number;
}
export interface PatternScore extends Counts {
  recall: number;
  versions: Record<string, Counts>;
}
export interface EdgeScore {
  patterns: Record<string, PatternScore>;
  totals: Counts & {
    recall: number;
    /** Distinct stored edges of a scored type between fixture files. */
    reported: number;
    /** Reported edges that match a positive label. */
    correct: number;
    /** Reported edges that match no label at all. */
    unlabelled: number;
    precision: number;
  };
  scoredTypes: string[];
  misses: string[];
  falsePositiveEdges: string[];
  unlabelledEdges: string[];
}

export const DEFAULT_SCORED_TYPES = ['call', 'render', 'navigate'];
const ROOT = resolve(import.meta.dirname, '../..');

export const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
export const edgeKey = (e: StoredEdge) =>
  `${normPath(e.source_file)}#${e.source_symbol ?? '-'} -${e.edge_type}-> ${normPath(e.target_file)}#${e.target_symbol ?? '-'}`;
/** Files by path; edge type and both symbols exactly (null only matches null). */
export const sameEdge = (a: StoredEdge, b: StoredEdge) => edgeKey(a) === edgeKey(b);

function symbolMatches(want: ExpectedSymbol, s: StoredSymbol): boolean {
  if (normPath(s.file_path) !== normPath(want.file) || s.name !== want.name || s.kind !== want.kind) return false;
  for (const [key, values] of Object.entries(want.metadata ?? {})) {
    const got = s.metadata[key];
    if (!Array.isArray(got) || !values.every((v) => got.includes(v))) return false;
  }
  return true;
}

export function scoreEdges(
  labels: EdgeLabel[],
  edges: StoredEdge[],
  symbols: StoredSymbol[] = [],
  scoredTypes: string[] = DEFAULT_SCORED_TYPES,
): EdgeScore {
  const patterns: Record<string, PatternScore> = {};
  const misses: string[] = [];
  const falsePositiveEdges: string[] = [];
  const reported = new Map<string, StoredEdge>();
  for (const e of edges) if (scoredTypes.includes(e.edge_type)) reported.set(edgeKey(e), e);
  const all = new Map<string, StoredEdge>();
  for (const e of edges) all.set(edgeKey(e), e);
  const correct = new Set<string>();
  const labelledKeys = new Set<string>();

  for (const l of labels) {
    const p = (patterns[l.pattern] ??= { labelled: 0, found: 0, negatives: 0, falsePositives: 0, recall: 1, versions: {} });
    const v = (p.versions[l.version] ??= { labelled: 0, found: 0, negatives: 0, falsePositives: 0 });
    if (l.expect === 'absent') {
      p.negatives++;
      v.negatives++;
      if (!l.edge) continue;
      const key = edgeKey(l.edge);
      labelledKeys.add(key);
      // A negative of any edge type counts, scored or not: the label names the exact edge.
      if (all.has(key)) {
        p.falsePositives++;
        v.falsePositives++;
        falsePositiveEdges.push(`${l.id} ${key}`);
      }
      continue;
    }
    p.labelled++;
    v.labelled++;
    if (l.symbol) {
      const want = l.symbol;
      if (symbols.some((s) => symbolMatches(want, s))) {
        p.found++;
        v.found++;
      } else misses.push(`${l.id} ${l.pattern} symbol ${want.file}#${want.name} (${want.kind}${want.metadata ? ` ${JSON.stringify(want.metadata)}` : ''})`);
      continue;
    }
    if (!l.edge) {
      misses.push(`${l.id} ${l.pattern} has neither an edge nor a symbol`);
      continue;
    }
    const key = edgeKey(l.edge);
    labelledKeys.add(key);
    if (all.has(key)) {
      p.found++;
      v.found++;
      if (reported.has(key)) correct.add(key);
    } else misses.push(`${l.id} ${l.pattern} ${key}`);
  }
  for (const p of Object.values(patterns)) p.recall = p.labelled ? p.found / p.labelled : 1;
  const unlabelled = [...reported.keys()].filter((k) => !labelledKeys.has(k)).sort();
  const sum = (k: keyof Counts) => Object.values(patterns).reduce((s, p) => s + p[k], 0);
  const t = { labelled: sum('labelled'), found: sum('found'), negatives: sum('negatives'), falsePositives: sum('falsePositives') };
  return {
    patterns,
    totals: {
      ...t,
      recall: t.labelled ? t.found / t.labelled : 1,
      reported: reported.size,
      correct: correct.size,
      unlabelled: unlabelled.length,
      // Nothing reported means nothing was wrong; recall carries the failure.
      precision: reported.size ? correct.size / reported.size : 1,
    },
    scoredTypes,
    misses,
    falsePositiveEdges,
    unlabelledEdges: unlabelled,
  };
}

/** Scans one project folder; returns edges whose both ends are its files, and every symbol. */
function scanProject(dir: string, prefix: string): { edges: StoredEdge[]; symbols: StoredSymbol[] } {
  const work = mkdtempSync(join(tmpdir(), 'mapx-score-edges-'));
  try {
    cpSync(dir, work, { recursive: true });
    const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
    const run = (...args: string[]) =>
      execFileSync(process.execPath, ['--import', tsx, join(ROOT, 'src/main.ts'), ...args], {
        cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1' },
      });
    run('init', work, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    run('scan', work);
    const db = new Database(join(work, '.mapx', 'mapx.db'), { readonly: true });
    try {
      const at = (p: string) => prefix + normPath(p);
      const edges = (db.prepare(
        `SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges
         WHERE source_file IN (SELECT path FROM files) AND target_file IN (SELECT path FROM files)`,
      ).all() as StoredEdge[]).map((e) => ({ ...e, source_file: at(e.source_file), target_file: at(e.target_file) }));
      const symbols = (db.prepare('SELECT file_path, name, kind, scope, metadata FROM symbols').all() as
        Array<Omit<StoredSymbol, 'metadata'> & { metadata: string | null }>).map((s) => {
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(s.metadata ?? '{}') ?? {}; } catch { /* malformed metadata is empty */ }
        return { ...s, file_path: at(s.file_path), metadata };
      });
      return { edges, symbols };
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Scans the fixture (each of `roots` separately when given) and returns fixture-relative edges and symbols. */
export function scanEdgeFixture(fixture: string, roots?: string[]): { edges: StoredEdge[]; symbols: StoredSymbol[] } {
  if (!roots?.length) return scanProject(fixture, '');
  const edges: StoredEdge[] = [];
  const symbols: StoredSymbol[] = [];
  for (const root of roots) {
    const part = scanProject(join(fixture, root), `${normPath(root).replace(/\/+$/, '')}/`);
    edges.push(...part.edges);
    symbols.push(...part.symbols);
  }
  return { edges, symbols };
}

export function loadExpected(fixture: string): ExpectedFile {
  return JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as ExpectedFile;
}

export const THRESHOLD_FLAGS = ['min-recall', 'max-fp', 'min-precision'] as const;
type ThresholdFlag = (typeof THRESHOLD_FLAGS)[number];

/** Rejects unknown flags (including the unsupported `--name=value` form) and a missing fixture. */
export function parseArgs(args: string[]): { fixture: string; json: boolean } {
  let fixture: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') continue;
    if ((THRESHOLD_FLAGS as readonly string[]).includes(a.slice(2)) && a.startsWith('--')) { i++; continue; }
    if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    if (fixture !== undefined) throw new Error(`unexpected argument ${a}`);
    fixture = a;
  }
  if (fixture === undefined) throw new Error('missing <fixture-dir>');
  return { fixture, json: args.includes('--json') };
}

/**
 * `--name 0.5` → totals threshold; `--name pattern=0.5` → per-pattern threshold. Each key once;
 * recall/precision in [0, 1], false positives an integer >= 0. `--min-precision` is totals only.
 */
export function parseThresholds(args: string[], name: ThresholdFlag): { total: number | null; patterns: Record<string, number> } {
  let total: number | null = null;
  const patterns: Record<string, number> = {};
  args.forEach((a, i) => {
    if (a !== `--${name}`) return;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    const eq = value.lastIndexOf('=');
    const raw = (eq >= 0 ? value.slice(eq + 1) : value).trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) throw new Error(`--${name} ${value}: not a number`);
    if (name === 'max-fp' ? !Number.isInteger(n) || n < 0 : n < 0 || n > 1)
      throw new Error(`--${name} ${value}: ${name === 'max-fp' ? 'expected an integer >= 0' : 'expected a number in [0, 1]'}`);
    if (eq >= 0) {
      const pattern = value.slice(0, eq);
      if (name === 'min-precision') throw new Error('--min-precision applies to the totals only');
      if (!pattern) throw new Error(`--${name} ${value}: missing pattern name`);
      if (pattern in patterns) throw new Error(`--${name} ${pattern} given twice`);
      patterns[pattern] = n;
    } else {
      if (total !== null) throw new Error(`--${name} given twice`);
      total = n;
    }
  });
  return { total, patterns };
}

export function thresholdFailures(result: EdgeScore, args: string[]): string[] {
  const failures: string[] = [];
  const minRecall = parseThresholds(args, 'min-recall');
  if (minRecall.total !== null && result.totals.recall < minRecall.total)
    failures.push(`recall ${result.totals.recall.toFixed(3)} below ${minRecall.total}`);
  for (const [name, min] of Object.entries(minRecall.patterns)) {
    const p = result.patterns[name];
    if (!p) failures.push(`unknown pattern ${name}`);
    else if (p.recall < min) failures.push(`${name} recall ${p.recall.toFixed(3)} below ${min}`);
  }
  const maxFp = parseThresholds(args, 'max-fp');
  if (maxFp.total !== null && result.totals.falsePositives > maxFp.total)
    failures.push(`false positives ${result.totals.falsePositives} > ${maxFp.total}`);
  for (const [name, max] of Object.entries(maxFp.patterns)) {
    const p = result.patterns[name];
    if (!p) failures.push(`unknown pattern ${name}`);
    else if (p.falsePositives > max) failures.push(`${name} false positives ${p.falsePositives} > ${max}`);
  }
  const minPrecision = parseThresholds(args, 'min-precision');
  if (minPrecision.total !== null && result.totals.precision < minPrecision.total)
    failures.push(`precision ${result.totals.precision.toFixed(3)} below ${minPrecision.total}`);
  return failures;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
function main() {
  const args = process.argv.slice(2);
  let failures: string[];
  let result: EdgeScore;
  try {
    const { fixture } = parseArgs(args);
    const expected = loadExpected(fixture);
    for (const flag of THRESHOLD_FLAGS) parseThresholds(args, flag); // usage errors before the scan
    const { edges, symbols } = scanEdgeFixture(resolve(fixture), expected.roots);
    result = scoreEdges(expected.labels, edges, symbols, expected.scoredTypes ?? DEFAULT_SCORED_TYPES);
    failures = thresholdFailures(result, args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error('Usage: score-edges.ts <fixture-dir> [--json] [--min-recall R|pattern=R]... [--max-fp N|pattern=N]... [--min-precision P]');
    process.exit(2);
  }
  const t = result.totals;
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    const versions = [...new Set(Object.values(result.patterns).flatMap((p) => Object.keys(p.versions)))].sort();
    console.log(`pattern                  found/labelled  ${versions.map((v) => v.padStart(7)).join(' ')}  recall  negatives  FP`);
    for (const [name, p] of Object.entries(result.patterns)) {
      const perVersion = versions.map((v) => (p.versions[v] ? `${p.versions[v]!.found}/${p.versions[v]!.labelled}` : '-').padStart(7));
      console.log(`${name.padEnd(24)} ${`${p.found}/${p.labelled}`.padStart(14)}  ${perVersion.join(' ')}  ${pct(p.recall).padStart(6)}  ${String(p.negatives).padStart(9)}  ${String(p.falsePositives).padStart(2)}`);
    }
    console.log(`\nRecall ${pct(t.recall)} (${t.found}/${t.labelled}), precision ${pct(t.precision)} (${t.correct}/${t.reported} ${result.scoredTypes.join('/')} edges), false positives ${t.falsePositives}/${t.negatives} negatives, unlabelled edges ${t.unlabelled}`);
    for (const m of result.misses) console.log(`  miss: ${m}`);
    for (const f of result.falsePositiveEdges) console.log(`  false positive: ${f}`);
    for (const u of result.unlabelledEdges) console.log(`  unlabelled: ${u}`);
  }
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
