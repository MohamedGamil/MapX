// Scores architecture-rule findings against the labelled fixture tests/fixtures/arch-rules (M5-01;
// docs/research/deptrac AR-08, AR-09, AR-10). For each app it copies the fixture to a temp
// directory, runs the real CLI (init, workspaces for the two-repo app, scan, then `check` once the
// CLI has it, M5-05; until then the evaluator in-process, M5-04) and reads the findings report at .mapx/architecture-report.json (AR-09's
// ArchReport). A missing report means no findings: recall 0, not an error.
//   npx tsx scripts/eval/score-arch.ts <fixture> [--json] [--app <name>] [--min-recall R] [--min-precision P]
// Findings on targets outside the workspace (M5-24) are also scored per ecosystem (`externalFindings`):
// uncovered, vendor-confinement and dev-dependency rows.
// Smells (M5-16-R1) are scored from expected-smells.json, a separate block of labels: per smell kind,
// recall and precision over the apps whose labels are complete for that kind (`smells` in --json).
// The smells' floor is 1.0 on the labelled rows: any missed row or unlabelled smell of a complete kind is a
// failure (exit 1) with or without thresholds. Exit code 1 when a threshold is missed; 2 on usage or scan errors.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScorerArgs } from './args.ts';
import { runArchitecture } from '../../src/arch/report.ts';
import { Store } from '../../src/core/store.ts';
import { currentSmells } from '../../src/core/architecture-analyzer.ts';

/** The finding kinds scored (AR-09). `allowed` and `none` label negatives. */
export const SCORED_KINDS = ['violation', 'skipped', 'uncovered', 'warning', 'error'] as const;
export type ScoredKind = typeof SCORED_KINDS[number];

export interface End {
  file?: string;
  symbol?: string;
  /** An external target (M5-24): `<ecosystem>:<name>`, as `npm:pg`, `composer:ext-pdo` or `go:C`; no file. */
  external?: string;
}
export interface ExpectedRow {
  id: string;
  app: string;
  language: string;
  rule?: string;
  kind: ScoredKind | 'allowed' | 'none';
  from?: End;
  to?: End;
  edgeType?: string;
  /** For layer-level findings (`empty-layer`, `plus-cycle`). */
  layer?: string;
  /**
   * The row's label when `visibility.nativeMarkers` is on (M5-11); `kind` and `rule` label the
   * fixture's own configuration, which this scorer runs.
   */
  native?: { kind: ScoredKind | 'allowed' | 'none'; rule?: string; edgeTypes?: string[] };
  /** Every edge type that carries the dependency, where labelled (M5-11); `edgeType` is the one matched. */
  edgeTypes?: string[];
  /** For a row on an external target (M5-24): `vendor-confinement` or `dev-dependency`; an uncovered row is `uncovered`. */
  category?: string;
  note?: string;
}
export interface ExpectedFindings {
  version: number;
  apps: Record<string, { language: string; repos: string[] | null }>;
  rows: ExpectedRow[];
}

/** The parts of a reported finding (AR-09 `Finding`) the scorer reads. */
export interface ReportedFinding {
  kind: string;
  rule?: string;
  source?: { element?: string; file?: string; layer?: string };
  target?: { element?: string; file?: string; layer?: string; external?: { ecosystem: string } };
  edgeType?: string;
  /** Layer-level findings may name their layer here instead of in `source.layer`. */
  layer?: string;
}
export interface ArchReport { findings?: ReportedFinding[] }

export interface KindScore { expected: number; reported: number; matched: number; recall: number; precision: number | null }
/** Findings on external targets (M5-24) of one ecosystem: matched rows per category. */
export interface ExternalFindingScore { expected: number; reported: number; matched: number; categories: Record<string, { expected: number; matched: number }> }
export interface AppScore {
  app: string;
  report: boolean;
  kinds: Record<ScoredKind, KindScore>;
  /** Findings on targets outside the workspace (M5-24), per ecosystem. */
  external: Record<string, ExternalFindingScore>;
  /** Reported findings on rows labelled allowed or none (each also a false positive of its kind). */
  negativeHits: string[];
  misses: string[];
}

/**
 * An element name ends with the labelled symbol: `App\Domain\Order`, `app.domain.order.Order`,
 * `src/domain/Order.ts#Order` and `Order::run` all name `Order`.
 */
export function elementMatches(element: string | undefined, symbol: string | undefined): boolean {
  if (!symbol) return true;
  if (!element) return false;
  if (element === symbol) return true;
  return new RegExp(`(^|[\\\\./#:@])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(::\\w+|\\.\\w+\\(?\\)?)?$`).test(element);
}

const endMatches = (end: End | undefined, side: ReportedFinding['target']) =>
  !end || (end.external !== undefined
    ? !!side?.external && `${side.external.ecosystem}:${side.element}` === end.external
    : side?.file === end.file && elementMatches(side?.element, end.symbol));

/**
 * Does a reported finding match a labelled row? Kind and rule match exactly; the files (and the
 * symbols, when labelled) of both ends match; a labelled edge type must be the finding's; a
 * layer-level row matches the finding's layer.
 */
export function rowMatches(row: ExpectedRow, f: ReportedFinding, kind = row.kind): boolean {
  if (f.kind !== kind) return false;
  if ((f.rule ?? undefined) !== (row.rule ?? undefined)) return false;
  if (!endMatches(row.from, f.source) || !endMatches(row.to, f.target)) return false;
  if (row.edgeType && f.edgeType && f.edgeType !== row.edgeType) return false;
  if (row.layer && (f.layer ?? f.source?.layer) !== row.layer) return false;
  return true;
}

/**
 * Findings that describe the same dependency (kind, rule, both ends) count once, whatever edge
 * types carry it: an import and a call between the same two classes are one finding to score.
 * A row matches a group when any of its findings matches, so a duplicate on another edge type,
 * reported first, cannot hide the one that carries the labelled edge type (review 2026-11-02).
 */
function group(findings: ReportedFinding[]): ReportedFinding[][] {
  const groups = new Map<string, ReportedFinding[]>();
  for (const f of findings) {
    const key = JSON.stringify([f.kind, f.rule ?? '', f.source?.file ?? '', f.source?.element ?? '', f.target?.file ?? '', f.target?.element ?? '', f.layer ?? f.source?.layer ?? '']);
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.values()];
}

/** One app: per-kind recall and precision of `report` against its labelled rows. */
export function scoreApp(app: string, rows: ExpectedRow[], report: ArchReport | null): AppScore {
  const groups = group(report?.findings ?? []);
  const kinds = Object.fromEntries(SCORED_KINDS.map((k) => [k, { expected: 0, reported: 0, matched: 0, recall: 0, precision: null as number | null }])) as Record<ScoredKind, KindScore>;
  const negativeHits: string[] = [];
  const misses: string[] = [];
  const used = new Set<ReportedFinding[]>();
  const external: Record<string, ExternalFindingScore> = {};
  const eco = (name: string) => (external[name] ??= { expected: 0, reported: 0, matched: 0, categories: {} });
  for (const row of rows) {
    if (row.kind === 'allowed' || row.kind === 'none') continue;
    const k = kinds[row.kind];
    k.expected++;
    const hit = groups.find((g) => !used.has(g) && g.some((f) => rowMatches(row, f)));
    if (hit) { used.add(hit); k.matched++; } else misses.push(row.id);
    if (row.to?.external !== undefined) {
      const e = eco(row.to.external.split(':')[0]!);
      const c = (e.categories[row.category ?? row.kind] ??= { expected: 0, matched: 0 });
      e.expected++;
      c.expected++;
      if (hit) { e.matched++; c.matched++; }
    }
  }
  for (const g of groups) {
    const f = g[0]!;
    if (!(SCORED_KINDS as readonly string[]).includes(f.kind)) continue;
    kinds[f.kind as ScoredKind].reported++;
    if (f.target?.external) eco(f.target.external.ecosystem).reported++;
    if (used.has(g)) continue;
    // A finding on a negative row: the dependency is allowed (or same-layer), whatever the rule says.
    const negative = rows.find((r) => (r.kind === 'allowed' || r.kind === 'none') && endMatches(r.from, f.source) && endMatches(r.to, f.target));
    if (negative) negativeHits.push(negative.id);
  }
  for (const k of Object.values(kinds)) {
    k.recall = k.expected ? k.matched / k.expected : 1;
    k.precision = k.reported ? k.matched / k.reported : null;
  }
  return { app, report: !!report, kinds, external, negativeHits, misses };
}

// ─── Smells (M5-16-R1) ──────────────────────────────────────────────────────────────────────────

/**
 * A labelled smell (expected-smells.json). `files` and `layers` are the smell's involved files and
 * layers (compared as sets, when given); `contains` is a text its description must contain (it names
 * a package or an edge). `evidence` says why the label holds, from the fixture's source.
 */
export interface ExpectedSmell {
  id: string;
  app: string;
  type: string;
  files?: string[];
  layers?: string[];
  contains?: string;
  evidence: string;
}
export interface ExpectedSmells {
  version: number;
  /** Apps used only for smells: scanned like the others, but with no rows in expected-findings.json. */
  apps?: Record<string, { language: string; repos: string[] | null }>;
  /** Per app, the smell kinds whose labels are complete: every smell of the kind is a row, or none exists. Only these are scored. */
  complete: Record<string, string[]>;
  rows: ExpectedSmell[];
}
/** The parts of a computed smell the scorer reads. */
export interface ReportedSmell { type: string; source?: string; description: string; involvedFiles?: string[]; involvedLayers?: string[] }
export interface SmellKindScore { expected: number; reported: number; matched: number; recall: number; precision: number | null }
export interface SmellScore { kinds: Record<string, SmellKindScore>; misses: string[]; extras: string[] }

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

/** Does a computed smell match a labelled one? Type, then every given identity part. */
export function smellMatches(row: ExpectedSmell, s: ReportedSmell): boolean {
  return s.type === row.type
    && (!row.files || sameSet(row.files, s.involvedFiles ?? []))
    && (!row.layers || sameSet(row.layers, s.involvedLayers ?? []))
    && (!row.contains || s.description.includes(row.contains));
}

/**
 * Recall and precision per smell kind. For each app, only the kinds it labels as complete count:
 * its labelled rows are the expected smells, and its rule-derived smells of those kinds the reported
 * ones. A row and a smell pair off one to one.
 */
export function scoreSmells(labels: ExpectedSmells, reported: Map<string, ReportedSmell[]>): SmellScore {
  const kinds: Record<string, SmellKindScore> = {};
  const kind = (t: string) => (kinds[t] ??= { expected: 0, reported: 0, matched: 0, recall: 1, precision: null });
  const misses: string[] = [];
  const extras: string[] = [];
  for (const [app, complete] of Object.entries(labels.complete)) {
    const smells = (reported.get(app) ?? []).filter((s) => s.source === 'rules' && complete.includes(s.type));
    const used = new Set<ReportedSmell>();
    for (const t of complete) kind(t);
    for (const row of labels.rows.filter((r) => r.app === app && complete.includes(r.type))) {
      kind(row.type).expected++;
      const hit = smells.find((s) => !used.has(s) && smellMatches(row, s));
      if (hit) { used.add(hit); kind(row.type).matched++; } else misses.push(`${app}: ${row.id}`);
    }
    for (const s of smells) {
      kind(s.type).reported++;
      if (!used.has(s)) extras.push(`${app}: ${s.type} ${s.description}`);
    }
  }
  for (const k of Object.values(kinds)) {
    k.recall = k.expected ? k.matched / k.expected : 1;
    k.precision = k.reported ? k.matched / k.reported : null;
  }
  return { kinds, misses, extras };
}

export function loadExpectedSmells(fixture: string): ExpectedSmells | null {
  const path = join(fixture, 'expected-smells.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ExpectedSmells : null;
}

/** The smells of a scanned copy, as `mapx arch --smells` lists them (the configuration and baseline applied). */
function readSmells(root: string, repos: string[] | null): ReportedSmell[] {
  const store = new Store(join(root, '.mapx/mapx.db'));
  try {
    const primary = root.split(/[\\/]/).pop()!;
    const names = [primary, ...(repos ?? [])];
    return currentSmells(store, root, names, { primary, repoPaths: Object.fromEntries((repos ?? []).map((r) => [r, r])) }) as ReportedSmell[];
  } finally {
    store.close();
  }
}

export interface ArchScore {
  apps: AppScore[];
  kinds: Record<ScoredKind, KindScore>;
  /** Findings on external targets (M5-24) per ecosystem, every app together, with recall and precision. */
  externalFindings: Record<string, ExternalFindingScore & { recall: number; precision: number | null }>;
}

// ─── External-reference attribution (M5-20 npm, M5-21 Composer; M5-22, M5-23 add their rows) ──

/** A labelled external reference (expected-externals.json): identity, and its attribution once labelled. */
export interface ExpectedExternal {
  app: string; file: string; line: number; sourceSymbol: string | null; specifier: string; symbol: string | null; kind: string; ecosystem: string;
  package?: string | null; origin?: string | null; direct?: boolean | null; dev?: boolean | null; attribution?: string | null;
}
/** An external_refs row as scanned, in the labels' shape. */
export type ScannedExternal = Omit<ExpectedExternal, 'app'>;
export interface ExternalScore {
  expected: number; reported: number; matched: number; recall: number; precision: number | null;
  /**
   * Expected and matched rows per class: builtin, direct-prod, direct-dev, transitive-prod,
   * transitive-dev, unlisted (in no manifest, dev unknown: no lockfile, or none holds it), unknown
   * (no input names the package: a PHP name no autoload prefix or naming convention covers, M5-21;
   * a Go import no module of the build list provides, M5-23), ambient (Go's cgo `C`, M5-23).
   */
  classes: Record<string, { expected: number; matched: number }>;
  misses: string[];
  extras: string[];
}

const externalIdentity = (r: ScannedExternal) => [r.file, r.line, r.sourceSymbol, r.specifier, r.symbol, r.kind].join(' | ');
const externalAttributed = (app: string, r: ScannedExternal) =>
  `${app}: ${externalIdentity(r)} → ${r.package} ${r.origin} direct=${r.direct} dev=${r.dev} ${r.attribution}`;
/** The class of a labelled row, for the per-class breakdown. */
export function externalClass(r: ScannedExternal): string {
  if (r.origin !== 'package') return r.origin ?? 'none';
  if (r.package === null) return 'unknown';
  if (!r.direct && (r.dev === null || r.dev === undefined)) return 'unlisted';
  return `${r.direct ? 'direct' : 'transitive'}-${r.dev ? 'dev' : 'prod'}`;
}

/**
 * Attribution scores per ecosystem, for the ecosystems whose rows carry attribution labels (`origin`
 * present). A scanned row counts as reported for its ecosystem whatever its attribution, so an
 * unlabelled or unattributed row lowers precision; a match needs the identity and every attribution
 * field equal.
 */
export function scoreExternals(labels: ExpectedExternal[], scanned: Map<string, ScannedExternal[]>): Record<string, ExternalScore> {
  const ecosystems = [...new Set(labels.filter((l) => 'origin' in l).map((l) => l.ecosystem))].sort();
  const out: Record<string, ExternalScore> = {};
  for (const eco of ecosystems) {
    const expected = labels.filter((l) => l.ecosystem === eco && scanned.has(l.app));
    const reported = [...scanned].flatMap(([app, rows]) => rows.filter((r) => r.ecosystem === eco).map((r) => externalAttributed(app, r)));
    const pool = new Map<string, number>();
    for (const r of reported) pool.set(r, (pool.get(r) ?? 0) + 1);
    const classes: ExternalScore['classes'] = {};
    const misses: string[] = [];
    let matched = 0;
    for (const l of expected) {
      const c = (classes[externalClass(l)] ??= { expected: 0, matched: 0 });
      c.expected++;
      const k = externalAttributed(l.app, l);
      if (pool.get(k)) { pool.set(k, pool.get(k)! - 1); matched++; c.matched++; } else misses.push(k);
    }
    const extras = [...pool].flatMap(([k, n]) => Array(n).fill(k) as string[]);
    out[eco] = {
      expected: expected.length, reported: reported.length, matched,
      recall: expected.length ? matched / expected.length : 1,
      precision: reported.length ? matched / reported.length : null,
      classes, misses, extras,
    };
  }
  return out;
}

export function loadExpectedExternals(fixture: string): ExpectedExternal[] {
  const path = join(fixture, 'expected-externals.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { rows: ExpectedExternal[] }).rows : [];
}

/** The external_refs rows of a scanned copy, in the labels' shape. */
function readExternals(root: string): ScannedExternal[] {
  const store = new Store(join(root, '.mapx/mapx.db'));
  try {
    const flag = (v: unknown) => (v === null || v === undefined ? null : v === 1);
    return store.getExternalRefs().map((r: any) => ({
      file: r.file_path, line: r.line, sourceSymbol: r.source_symbol, specifier: r.specifier, symbol: r.symbol, kind: r.kind, ecosystem: r.ecosystem,
      package: r.package, origin: r.origin, direct: flag(r.direct), dev: flag(r.dev), attribution: r.attribution,
    }));
  } finally {
    store.close();
  }
}

export function combine(apps: AppScore[]): ArchScore {
  const kinds = Object.fromEntries(SCORED_KINDS.map((k) => {
    const expected = apps.reduce((n, a) => n + a.kinds[k].expected, 0);
    const reported = apps.reduce((n, a) => n + a.kinds[k].reported, 0);
    const matched = apps.reduce((n, a) => n + a.kinds[k].matched, 0);
    return [k, { expected, reported, matched, recall: expected ? matched / expected : 1, precision: reported ? matched / reported : null }];
  })) as Record<ScoredKind, KindScore>;
  const externalFindings: ArchScore['externalFindings'] = {};
  for (const a of apps) {
    for (const [name, e] of Object.entries(a.external ?? {})) {
      const t = (externalFindings[name] ??= { expected: 0, reported: 0, matched: 0, categories: {}, recall: 1, precision: null });
      t.expected += e.expected; t.reported += e.reported; t.matched += e.matched;
      for (const [c, n] of Object.entries(e.categories)) {
        const tc = (t.categories[c] ??= { expected: 0, matched: 0 });
        tc.expected += n.expected; tc.matched += n.matched;
      }
    }
  }
  for (const t of Object.values(externalFindings)) {
    t.recall = t.expected ? t.matched / t.expected : 1;
    t.precision = t.reported ? t.matched / t.reported : null;
  }
  return { apps, kinds, externalFindings };
}

// ─── Running the CLI on the fixture ─────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '../..');
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
const ENV = { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1', MAPX_NO_BANNER: '1' };
const cli = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--import', TSX, join(ROOT, 'src/main.ts'), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV, maxBuffer: 64 * 1024 * 1024 });

let checkCommand: boolean | undefined;
/** Whether the CLI has `mapx check` yet (M5-05 adds it). */
function hasCheck(cwd: string): boolean {
  checkCommand ??= /^\s+check(\s|$)/m.test(cli(cwd, '--help'));
  return checkCommand;
}

/**
 * Scans one fixture app in a temp copy and returns its report, or null when none was written; its
 * external_refs rows go to `externals` when given (M5-20).
 */
export function scanApp(fixture: string, app: string, repos: string[] | null, externals?: Map<string, ScannedExternal[]>, smells?: Map<string, ReportedSmell[]>): ArchReport | null {
  const root = mkdtempSync(join(tmpdir(), `mapx-arch-${app}-`));
  try {
    cpSync(join(fixture, app), root, { recursive: true });
    cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    for (const repo of repos ?? []) {
      execFileSync('git', ['init', '-q', join(root, repo)]);
      cli(root, 'workspaces', 'add', repo);
    }
    cli(root, 'scan');
    externals?.set(app, readExternals(root));
    // The smells read the baseline and the configuration as `check` does, so after it has run.
    const reportPath = join(root, '.mapx/architecture-report.json');
    if (hasCheck(root)) {
      try {
        // Every scored kind must be listed: uncovered and skipped findings are hidden by default (M5-05).
        cli(root, 'check', '--format', 'json', '--output', reportPath, '--report-uncovered', '--report-skipped');
      } catch (err: any) {
        // Exit 1 (violations), 2 (uncovered) and 3 (configuration errors) still write the report.
        if (![1, 2, 3].includes(err?.status)) throw err;
      }
    } else {
      // Until `mapx check` exists (M5-05), the evaluator runs in-process on the scanned copy (M5-04).
      const repoPaths = Object.fromEntries((repos ?? []).map((r) => [r, r]));
      const report = runArchitecture(root, { repoPaths });
      if (report) writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
    smells?.set(app, readSmells(root, repos));
    return existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) as ArchReport : null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function loadExpected(fixture: string): ExpectedFindings {
  return JSON.parse(readFileSync(join(fixture, 'expected-findings.json'), 'utf8')) as ExpectedFindings;
}

const pct = (n: number | null) => (n === null ? '   —' : `${(n * 100).toFixed(0).padStart(3)}%`);

async function main() {
  const argv = process.argv.slice(2);
  let only: string | undefined;
  const appAt = argv.indexOf('--app');
  if (appAt >= 0) {
    only = argv[appAt + 1];
    if (!only || only.startsWith('--')) throw new Error('--app needs a name');
    argv.splice(appAt, 2);
    if (argv.includes('--app')) throw new Error('--app given twice');
  }
  const args = parseScorerArgs(argv, { booleans: ['json'], thresholds: { 'min-recall': 'ratio', 'min-precision': 'ratio' }, requiredFile: 'expected-findings.json' });
  const fixture = resolve(args.fixture);
  const expected = loadExpected(fixture);
  const apps = Object.entries(expected.apps).filter(([name]) => !only || name === only);
  const smellOnly = Object.keys(loadExpectedSmells(fixture)?.apps ?? {});
  if (only && !apps.length && !smellOnly.includes(only)) throw new Error(`unknown app ${only}; expected one of ${[...Object.keys(expected.apps), ...smellOnly].join(', ')}`);
  const scanned = new Map<string, ScannedExternal[]>();
  const computed = new Map<string, ReportedSmell[]>();
  const scores = apps.map(([name, meta]) => scoreApp(name, expected.rows.filter((r) => r.app === name), scanApp(fixture, name, meta.repos, scanned, computed)));
  const score = combine(scores);
  const externals = scoreExternals(loadExpectedExternals(fixture), scanned);
  // Smells (M5-16-R1): the apps that only label smells are scanned too. Only the apps scanned in this run are scored (--app).
  const smellLabels = loadExpectedSmells(fixture);
  for (const [name, meta] of Object.entries(smellLabels?.apps ?? {})) {
    if ((!only || name === only) && !computed.has(name)) scanApp(fixture, name, meta.repos, undefined, computed);
  }
  const smells = smellLabels && scoreSmells({ ...smellLabels, complete: Object.fromEntries(Object.entries(smellLabels.complete).filter(([a]) => computed.has(a))) }, computed);

  const minRecall = args.thresholds['min-recall'];
  const minPrecision = args.thresholds['min-precision'];
  const failures: string[] = [];
  for (const [kind, k] of Object.entries(score.kinds)) {
    if (minRecall !== undefined && k.expected && k.recall < minRecall) failures.push(`${kind} recall ${k.recall.toFixed(3)} < ${minRecall}`);
    if (minPrecision !== undefined && k.precision !== null && k.precision < minPrecision) failures.push(`${kind} precision ${k.precision.toFixed(3)} < ${minPrecision}`);
  }
  for (const [eco, k] of Object.entries(score.externalFindings)) {
    if (minRecall !== undefined && k.expected && k.recall < minRecall) failures.push(`findings on externals ${eco} recall ${k.recall.toFixed(3)} < ${minRecall}`);
    if (minPrecision !== undefined && k.precision !== null && k.precision < minPrecision) failures.push(`findings on externals ${eco} precision ${k.precision.toFixed(3)} < ${minPrecision}`);
  }
  // The floor of the smells is 1.0 on the labelled rows: a missed row or a smell of a complete kind that no row
  // labels fails the run, whatever thresholds are given (M5-16-R1 review).
  for (const m of smells?.misses ?? []) failures.push(`smell missed ${m}`);
  for (const x of smells?.extras ?? []) failures.push(`smell not labelled ${x}`);
  for (const [kind, k] of Object.entries(smells?.kinds ?? {})) {
    if (minRecall !== undefined && k.expected && k.recall < minRecall) failures.push(`smell ${kind} recall ${k.recall.toFixed(3)} < ${minRecall}`);
    if (minPrecision !== undefined && k.precision !== null && k.precision < minPrecision) failures.push(`smell ${kind} precision ${k.precision.toFixed(3)} < ${minPrecision}`);
  }
  for (const [eco, k] of Object.entries(externals)) {
    if (minRecall !== undefined && k.expected && k.recall < minRecall) failures.push(`externals ${eco} recall ${k.recall.toFixed(3)} < ${minRecall}`);
    if (minPrecision !== undefined && k.precision !== null && k.precision < minPrecision) failures.push(`externals ${eco} precision ${k.precision.toFixed(3)} < ${minPrecision}`);
  }

  if (args.flags.has('json')) {
    console.log(JSON.stringify({ ...score, externals, ...(smells ? { smells } : {}), failures }, null, 2));
  } else {
    console.log(`Architecture findings (${fixture}): ${scores.filter((s) => s.report).length} of ${scores.length} apps wrote a report`);
    console.log('  kind        expected  reported  matched  recall  precision');
    for (const [kind, k] of Object.entries(score.kinds)) {
      console.log(`  ${kind.padEnd(10)}  ${String(k.expected).padStart(8)}  ${String(k.reported).padStart(8)}  ${String(k.matched).padStart(7)}  ${pct(k.recall).padStart(6)}  ${pct(k.precision).padStart(9)}`);
    }
    for (const s of scores) if (s.negativeHits.length) console.log(`  ${s.app}: findings on allowed or same-layer rows ${s.negativeHits.join(', ')}`);
    for (const [eco, k] of Object.entries(score.externalFindings)) {
      const categories = Object.entries(k.categories).map(([c, n]) => `${c} ${n.matched}/${n.expected}`).join(', ');
      console.log(`  findings on ${eco.padEnd(9)} ${String(k.expected).padStart(4)}  ${String(k.reported).padStart(8)}  ${String(k.matched).padStart(7)}  ${pct(k.recall).padStart(6)}  ${pct(k.precision).padStart(9)}  (${categories})`);
    }
    for (const [eco, k] of Object.entries(externals)) {
      const classes = Object.entries(k.classes).map(([c, n]) => `${c} ${n.matched}/${n.expected}`).join(', ');
      console.log(`  externals ${eco.padEnd(8)}  ${String(k.expected).padStart(4)}  ${String(k.reported).padStart(8)}  ${String(k.matched).padStart(7)}  ${pct(k.recall).padStart(6)}  ${pct(k.precision).padStart(9)}  (${classes})`);
      for (const m of k.misses) console.log(`    missed ${m}`);
      for (const x of k.extras) console.log(`    extra  ${x}`);
    }
    for (const [kind, k] of Object.entries(smells?.kinds ?? {})) {
      console.log(`  smell ${kind.padEnd(26)} ${String(k.expected).padStart(4)}  ${String(k.reported).padStart(8)}  ${String(k.matched).padStart(7)}  ${pct(k.recall).padStart(6)}  ${pct(k.precision).padStart(9)}`);
    }
    for (const m of smells?.misses ?? []) console.log(`    smell missed ${m}`);
    for (const x of smells?.extras ?? []) console.log(`    smell extra  ${x}`);
    for (const f of failures) console.log(`  FAIL ${f}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`score-arch: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
