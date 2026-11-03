// The dashboard's architecture API (M5-15; docs/research/deptrac/03 §3.6): `/api/arch/report`,
// `/api/arch/layers` and `/api/arch/edges`. Each answer is built from the report `mapx check`
// builds (baseline applied) over one evaluation of the configuration (`ctx.evaluation()`), which
// the M5-13 layer graph and DSM, M5-16's rule smells and M5-08's introspection reuse: the
// dashboard decides nothing of its own. Read-only: nothing here writes a file.
//
//   one unit     a layer pair's drill-down counts the report's findings (top-level element pairs),
//                as the DSM, the diagram and `mapx check` do; the finer dependencies are listed
//                under the finding they belong to (the report's trace)
//   one batch    the evaluation, the report and what is derived from it are kept while the index,
//                the configurations and the baseline are unchanged (their size and mtime), at most
//                CACHE_MS, on a store of their own
//   staleness    `mapx check`'s index gate (exit 4) is answered as `stale: true` and its reason
//   repos        the rules are evaluated over the whole workspace, as `mapx check` does; a repo
//                (M4-21's `repo=`) narrows the lists (findings, members, files, dependencies) to
//                that repo's files, while the graph, DSM, health and rule smells stay the workspace's
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './core/config.js';
import { Store } from './core/store.js';
import { baselineLocation, loadBaseline } from './arch/baseline.js';
import { ConfigError } from './arch/config.js';
import { CONFIG_RULES, shownReport } from './arch/check.js';
import { indexGate } from './arch/index-gate.js';
import {
  IntrospectError, layerDependencyRows, layerMembers, openArchitecture, unassignedElements, unusedAllowances,
  type ArchContext, type ConcreteDependency,
} from './arch/introspect.js';
import { buildReport, configErrorReport, newReportTrace, type ArchReport, type Finding, type ReportTrace } from './arch/report.js';
import { layerDsm, layerGraph } from './arch/reporters/index.js';
import { drawnEdges } from './arch/reporters/graph.js';
import { ruleSmells } from './arch/smells.js';

export interface ArchApiAnswer { status: number; body: unknown }

export const ARCH_ROUTES = ['report', 'layers', 'edges'] as const;

/** What the view shows when the workspace has no architecture configuration. */
export const NO_CONFIG_HINT = 'This workspace has no .mapx/architecture.jsonc. Run mapx arch init to propose one from the index, review it, then reload.';

/** Rule smells that restate findings (a violation per file pair, a configuration error): not counted again. */
const FINDING_SMELLS = new Set(['layer-violation', 'architecture-config']);

/** How long an evaluation is reused at most, even when no file it depends on changed. */
const CACHE_MS = 30_000;
/** How long the index gate's answer (a walk of the workspace) is reused. */
export const STALE_MS = 2_000;

const ok = (body: unknown): ArchApiAnswer => ({ status: 200, body });

/** One evaluation of the workspace's configuration, and what every answer derives from it. */
interface Evaluated {
  key: string;
  /** Files whose size and mtime make the key. */
  watched: string[];
  created: number;
  store: Store | null;
  /** The answer when there is nothing to evaluate: no configuration, or an invalid one. */
  state: Record<string, unknown> | null;
  ctx: ArchContext | null;
  report: ArchReport | null;
  trace: ReportTrace | null;
  overview: ReturnType<typeof overviewOf> | null;
}

const evaluations = new Map<string, Evaluated>();
const gates = new Map<string, { at: number; problems: string[] }>();
let evaluationCount = 0;
/** How many evaluations this process has made (tests check the cache with it). */
export const archEvaluations = () => evaluationCount;

function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** The files an evaluation of `dir` depends on: the index, the configurations (views too) and the baseline. */
function watchedFiles(dir: string, baseline: string | null): string[] {
  const mapx = join(dir, '.mapx');
  const files = ['mapx.db', 'mapx.db-wal', 'config.json', 'architecture.jsonc', 'architecture.baseline.json'].map((f) => join(mapx, f));
  try {
    for (const f of readdirSync(join(mapx, 'architecture'))) files.push(join(mapx, 'architecture', f));
  } catch { /* no views */ }
  if (baseline) files.push(resolve(baseline));
  return [...new Set(files)];
}

const keyOf = (files: string[]) => files.map((f) => `${f}=${stamp(f)}`).join('|');

/** The cached evaluation of `dir`, or a new one when a watched file changed or it is older than CACHE_MS. */
function evaluated(dir: string, repoPaths: Record<string, string>): Evaluated {
  const cached = evaluations.get(dir);
  if (cached && Date.now() - cached.created < CACHE_MS && keyOf(cached.watched) === cached.key) return cached;
  if (cached) {
    try { cached.store?.close(); } catch { /* ignore close errors */ }
    evaluations.delete(dir);
  }
  evaluationCount++;
  const entry: Evaluated = { key: '', watched: watchedFiles(dir, null), created: Date.now(), store: null, state: null, ctx: null, report: null, trace: null, overview: null };
  entry.key = keyOf(entry.watched);
  const store = new Store(join(dir, '.mapx', 'mapx.db'));
  entry.store = store;
  try {
    const ctx = openArchitecture(dir, store, { repoPaths });
    if (!ctx) {
      entry.state = { configured: false, hint: NO_CONFIG_HINT };
    } else if (ctx.policy.errors.length) {
      // As `mapx arch` refuses them: rules that cannot be expanded (a "+" cycle, an unknown layer).
      entry.state = { configured: true, valid: false, errors: ctx.policy.errors };
    } else {
      const baseline = baselineLocation(dir, ctx.config);
      entry.watched = watchedFiles(dir, baseline.path);
      entry.key = keyOf(entry.watched);
      const trace = newReportTrace();
      entry.report = buildReport(store, ctx.config, ctx.membership, { baseline: loadBaseline(dir, ctx.config), repoPaths, evaluation: ctx.evaluation(), trace });
      entry.ctx = ctx;
      entry.trace = trace;
    }
  } catch (err) {
    // An invalid configuration or baseline: its problems, as `mapx check` reports them (exit 3).
    if (!(err instanceof ConfigError)) {
      try { store.close(); } catch { /* ignore */ }
      throw err;
    }
    entry.state = { configured: true, valid: false, errors: configErrorReport(err).configErrors };
  }
  if (!entry.ctx) {
    try { store.close(); } catch { /* ignore */ }
    entry.store = null;
  }
  evaluations.set(dir, entry);
  // An idle evaluation releases its store.
  const timer = setTimeout(() => {
    if (evaluations.get(dir) !== entry) return;
    evaluations.delete(dir);
    try { entry.store?.close(); } catch { /* ignore */ }
  }, CACHE_MS);
  timer.unref?.();
  return entry;
}

/** `mapx check`'s index gate: null when the index is current, else why not (exit 4 there). */
async function staleness(dir: string, config: Config, store: Store): Promise<string | null> {
  const known = gates.get(dir);
  if (known && Date.now() - known.at < STALE_MS) return known.problems.length ? known.problems.join(' ') : null;
  const gate = await indexGate(dir, async () => ({ config, store }), { syncAdvice: '`mapx check --sync`', updateAdvice: '`mapx update`' });
  const problems = 'problems' in gate ? gate.problems : [];
  gates.set(dir, { at: Date.now(), problems });
  return problems.length ? problems.join(' ') : null;
}

/**
 * Answers `/api/arch/<route>` for the workspace in `dir`. `store` is the caller's open index, used
 * for the staleness check only; `repo` is the repo the lists are narrowed to, or null.
 */
export async function archApi(route: string, params: URLSearchParams, dir: string, config: Config, store: Store, repo: string | null): Promise<ArchApiAnswer> {
  if (!(ARCH_ROUTES as readonly string[]).includes(route)) return { status: 404, body: { error: `Unknown endpoint: /api/arch/${route}` } };
  const staleReason = await staleness(dir, config, store);
  const stale = staleReason ? { stale: true, staleReason } : { stale: false };
  const repoPaths = Object.fromEntries(config.repos.map((r) => [r.name, r.path]));
  // From here on nothing awaits: the cached evaluation's store cannot be closed under this request.
  const e = evaluated(dir, repoPaths);
  if (e.state) return ok({ ...e.state, ...stale });
  const ctx = e.ctx!;
  const files = ctx.membership.view.files;
  const inRepo = (file: string | undefined) => !repo || (file !== undefined && files.get(file)?.repo === repo);
  try {
    if (route === 'report') {
      e.overview ??= overviewOf(ctx, e.report!);
      const o = e.overview;
      // Layer-level findings (an empty layer, a configuration error) concern every repo.
      const findings = o.findings.filter((f) => !f.source || inRepo(f.source.file) || inRepo(f.target?.file));
      return ok({ configured: true, valid: true, ...stale, view: ctx.config.view, repo, ...o, findings });
    }
    if (route === 'layers') return ok({ configured: true, valid: true, ...stale, repo, ...layersAnswer(ctx, e.report!, params.get('layer'), inRepo) });
    return edgesAnswer(ctx, e.report!, e.trace!, params, repo, inRepo, stale);
  } catch (err) {
    if (err instanceof IntrospectError) return { status: 404, body: { error: err.message, candidates: err.candidates } };
    throw err;
  }
}

/**
 * The workspace's view, computed once per evaluation: the layer graph (and its edges as `mapx arch
 * graph` draws them) and DSM, the allowances no dependency uses (the DSM's faint cells, `mapx arch
 * unused`), health figures, the findings `mapx check --report-uncovered --report-skipped` shows
 * (allowed dependencies are only counted) and the rule smells.
 */
function overviewOf(ctx: ArchContext, report: ArchReport) {
  const graph = layerGraph(report, ctx.config);
  const smells = ruleSmells(ctx, report);
  const c = report.counts;
  return {
    counts: c,
    health: {
      violations: c.violation,
      warnLevelViolations: graph.totals.warnings,
      // `mapx check`'s "Warnings": multi-layer elements, empty layers, unsupported selectors.
      warnings: c.warning,
      baselineDebt: c.skipped,
      uncovered: c.uncovered,
      unassigned: unassignedElements(ctx).total,
      configErrors: report.findings.filter((f) => f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '')).length,
      ruleSmells: smells.filter((s) => !FINDING_SMELLS.has(s.type)).length,
      // No snapshot records architecture counts yet, so there is no trend to show.
      trend: null,
    },
    graph,
    drawn: drawnEdges(graph),
    dsm: layerDsm(graph),
    unusedAllowances: unusedAllowances(ctx).allowances.map((a) => ({ from: a.from, to: a.to, rule: a.rule })),
    findings: shownReport(report, { reportUncovered: true, reportSkipped: true }).findings,
    smells,
  };
}

/**
 * Every layer (size, group, colour, hidden) and, for the graph's overlay, each file's non-overlay
 * layers and the files in none; with `layer`, its members and the selector that matched each.
 */
function layersAnswer(ctx: ArchContext, report: ArchReport, layer: string | null, inRepo: (file?: string) => boolean) {
  if (layer !== null) {
    const m = layerMembers(ctx, layer, { why: true });
    const members = m.members.filter((e) => inRepo(e.file));
    return { layer: { ...m, total: members.length, members } };
  }
  const graph = layerGraph(report, ctx.config);
  const fileLayers: Record<string, string[]> = {};
  for (const path of [...ctx.membership.view.files.keys()].sort()) {
    if (!inRepo(path)) continue;
    const layers = ctx.membership.primaryOf(`file:${path}`);
    if (layers.length) fileLayers[path] = layers;
  }
  const unassigned = [...new Set(unassignedElements(ctx).elements.map((e) => e.file))].filter((f) => inRepo(f));
  return { layers: graph.layers, groups: graph.groups, files: fileLayers, unassigned };
}

/**
 * A layer pair's findings, as the report counts them on the pair (`layerEdges`, the DSM, `mapx
 * check`), each with the concrete dependencies it stands for (`mapx arch deps`). Without `to`,
 * every finding from `from`, uncovered ones included. A dependency the report subsumed (a Go
 * package import reached through a finer finding) is not listed: it is counted nowhere.
 */
function edgesAnswer(ctx: ArchContext, report: ArchReport, trace: ReportTrace, params: URLSearchParams, repo: string | null, inRepo: (file?: string) => boolean, stale: Record<string, unknown>): ArchApiAnswer {
  const from = params.get('from');
  if (!from) return { status: 400, body: { error: 'Pass from=<layer> (and to=<layer>).' } };
  const to = params.get('to') || undefined;
  const pair = to === undefined ? null : `${from}\u0000${to}`;
  const kept = new Set(report.findings);
  const under = new Map<Finding, ConcreteDependency[]>();
  for (const row of layerDependencyRows(ctx, from, to)) {
    if (!inRepo(row.concrete.source.file)) continue;
    const f = trace.findingOf.get(row.dependency);
    if (!f || !kept.has(f)) continue;
    if (pair !== null && !trace.pairsOf.get(f)?.has(pair)) continue;
    const list = under.get(f);
    if (list) list.push(row.concrete); else under.set(f, [row.concrete]);
  }
  const counts = { allowed: 0, violations: 0, warnings: 0, skipped: 0, uncovered: 0 };
  const findings = report.findings.filter((f) => under.has(f)).map((f) => {
    const severity = pair !== null ? trace.pairsOf.get(f)!.get(pair)! : f.severity;
    if (f.kind === 'allowed') counts.allowed++;
    else if (f.kind === 'skipped') counts.skipped++;
    else if (f.kind === 'uncovered') counts.uncovered++;
    else { counts.violations++; if (severity === 'warn') counts.warnings++; }
    return { ...f, pairSeverity: severity, dependencies: under.get(f)! };
  });
  return ok({ configured: true, valid: true, ...stale, repo, from, to: to ?? null, counts, findings });
}
