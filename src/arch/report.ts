// The architecture report (M5-04; docs/research/deptrac AR-09, AR-12). Aggregates the evaluator's
// decisions into findings with stable fingerprints, adds the multi-layer and empty-layer warnings
// and configuration errors, and counts dependencies per layer pair (layerEdges, for graphs and the
// DSM). `runArchitecture` is the whole pipeline; M5-05's `mapx check` calls it. A baseline and a
// base report (M5-06, AR-10) turn known violations into skipped ones; stale entries are errors.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Store } from '../core/store.js';
import { ConfigError, loadArchitectureConfig, reportedUncoveredPolicy, type LoadOptions, type ReportedUncoveredPolicy } from './config.js';
import type { ArchitectureConfig } from './schema.js';
import { getMembership, type LayerMembership } from './membership.js';
import { expandPolicy } from './policy.js';
import { ENDPOINT_EDGES, elementName, evaluateEdges, reportElement, type Dependency, type Evaluation, type Finding, type FindingKind, type FindingSeverity } from './evaluate.js';
import { BaselineMatcher, fingerprint, loadBaseline, repoKey, type Baseline } from './baseline.js';

export type { Finding, FindingKind } from './evaluate.js';

export interface ArchReport {
  version: 1;
  counts: Record<FindingKind, number>;
  findings: Finding[];
  /** Elements and files per layer, and its uncovered dependencies: findings whose source is in it (M5-13). */
  layers: Array<{ name: string; elements: number; files: number; overlay: boolean; uncovered: number }>;
  /**
   * Dependencies per layer pair. `warnings` counts the `violations` reported at `warn` (an advisory
   * allowance, or an inferred edge under `policy.inferred: "warn"`), per pair (M5-13).
   */
  layerEdges: LayerEdge[];
  configErrors: string[];
  /**
   * What `mapx check` evaluated and kept (M5-06): the view and the `--layer`/`--rule` filters, so
   * `--compare` can refuse a base report made on something else. Absent from in-process reports.
   */
  selection?: Selection;
  /**
   * The resolved `policy.uncovered` (M5-24-R4, D039): whether packages in no layer are reported,
   * and why (explicit, a package selector in a layer, or off by default). Absent from a report of
   * a configuration that cannot be loaded.
   */
  policy?: ReportedUncoveredPolicy;
}

export interface LayerEdge { from: string; to: string; allowed: number; violations: number; warnings: number; skipped: number }

/** `since` (M5-98-R1): the ref of `mapx check --since`; absent when the check was not narrowed by it. */
export interface Selection { view: string | null; layer: string | null; rule: string | null; since?: string | null }

// The fingerprint is the baseline's identity: it lives in baseline.ts, where it is documented.
export { fingerprint };

export interface SkipOptions {
  /** Violations this baseline lists become skipped; its unmatched entries become errors. */
  baseline?: Baseline | null;
  /**
   * The evaluation of `config` over `membership`, when the caller already has it (`ArchContext`'s):
   * the edges are then decided once per command (M5-16 review).
   */
  evaluation?: Evaluation;
  /** Fingerprints of a base revision's report (`--compare`): violations among them become skipped. */
  known?: Set<string>;
  /** Repo name → workspace-relative path, for the repos fingerprints name (`.` is the root repo). */
  repoPaths?: Record<string, string>;
  /**
   * Filled with what each finding is made of (M5-15): the finding each evaluated dependency became
   * (a dependency subsumed by a finer finding maps to a finding the report does not keep), and the
   * layer pairs each finding counts for in `layerEdges`, with the pair's severity.
   */
  trace?: ReportTrace;
}

/** See `SkipOptions.trace`. Pair keys are `from + "\u0000" + to`. */
export interface ReportTrace {
  findingOf: Map<Dependency, Finding>;
  pairsOf: Map<Finding, Map<string, FindingSeverity>>;
}

/** A trace to pass to `buildReport`. */
export const newReportTrace = (): ReportTrace => ({ findingOf: new Map(), pairsOf: new Map() });

/** What an internal-element message says is internal: "it" for the target or its file, else the marked member. */
const internalName = (marked: Parameters<typeof elementName>[0], target: string) =>
  marked.kind === 'file' || elementName(marked) === target ? 'it' : elementName(marked);

const KINDS: FindingKind[] = ['violation', 'skipped', 'uncovered', 'allowed', 'warning', 'error'];
const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]));

/** Orders findings deterministically: kind, rule, source, target, edge type, layer. */
export function sortFindings(findings: Finding[]): Finding[] {
  const key = (f: Finding) => [f.rule ?? '', f.source?.element ?? '', f.source?.layer ?? '', f.target?.element ?? '', f.edgeType ?? '', f.layer ?? ''].join('\u0000');
  return findings.sort((a, b) => (KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Builds the report of `config` over the membership (and so the index) it was computed on. */
export function buildReport(store: Store, config: ArchitectureConfig, membership: LayerMembership, skip: SkipOptions = {}): ArchReport {
  const view = membership.view;
  const policy = expandPolicy(config);
  const { dependencies: deps, endFiles } = skip.evaluation ?? evaluateEdges(store, config, membership, policy);
  const layerOrder = new Map(config.layers.map((l, i) => [l.name, i]));
  const byOrder = (a: string, b: string) => (layerOrder.get(a) ?? 0) - (layerOrder.get(b) ?? 0);

  // One finding per (kind, rule, reported source and target, edge type): a source in several layers
  // (AR-12) gets one finding naming every source layer the rule applies to, so fingerprints are
  // unique within a report (review of M5-04). Each finding remembers the layer pairs it counts for.
  const byKey = new Map<string, Finding>();
  const meta = new Map<Finding, { sourceLayers: Set<string>; pairs: Map<string, FindingSeverity>; packageDir?: string; sourceFiles: Set<string> }>();
  const repoPaths = skip.repoPaths ?? {};
  for (const d of deps) {
    const src = reportElement(view, d.source);
    const tgt = ENDPOINT_EDGES.has(d.edgeType) && d.target.kind === 'symbol' ? d.target : reportElement(view, d.target);
    const s = elementName(src);
    const t = d.targetPackage ? d.targetPackage.name : elementName(tgt);
    const targetFile = d.targetPackage ? d.targetPackage.dir : tgt.file.path;
    const rule = d.rule ?? 'allowed';
    // The fingerprint's ends (AR-09, review of M5-06): an end the edge names at file level (an
    // import) is its file, not the file's only top-level symbol shown above, so a symbol added to
    // either file does not re-key it. Repos keep identical names in two repos apart.
    const idS = d.source.kind === 'file' ? d.source.file.path : s;
    const idT = d.targetPackage ? t : d.target.kind === 'file' ? d.target.file.path : t;
    const sRepo = repoKey(src.file.repo, repoPaths);
    const tRepo = repoKey(tgt.file.repo, repoPaths);
    const key = JSON.stringify([d.kind, rule, s, t, d.edgeType, idS, idT, sRepo, tRepo]);
    let finding = byKey.get(key);
    if (!finding) {
      const targetLayer = d.targetLayers.join(', ') || undefined;
      finding = {
        kind: d.kind, rule: d.rule, severity: d.severity,
        source: { element: s, file: src.file.path, layer: d.sourceLayer, layers: [d.sourceLayer], repo: src.file.repo, ...(d.line !== undefined ? { line: d.line } : {}) },
        target: tgt.external
          ? { element: t, file: '', ...(targetLayer ? { layer: targetLayer, layers: [...d.targetLayers] } : {}), external: { ecosystem: tgt.external.ecosystem, origin: tgt.external.origin, package: tgt.external.package, direct: tgt.external.direct, dev: tgt.external.dev } }
          : { element: t, file: targetFile, ...(targetLayer ? { layer: targetLayer, layers: [...d.targetLayers] } : {}), repo: tgt.file.repo },
        edgeType: d.edgeType, verifiability: d.verifiability, edges: 0,
        fingerprint: fingerprint(rule, idS, idT, d.edgeType, sRepo, tRepo), message: '',
        ...(d.via ? { via: d.via } : {}),
        ...(idS !== s || idT !== t || sRepo || tRepo ? { identity: { source: idS, target: idT, ...(sRepo || tRepo ? { sourceRepo: sRepo, targetRepo: tRepo } : {}) } } : {}),
      };
      byKey.set(key, finding);
      meta.set(finding, { sourceLayers: new Set(), pairs: new Map(), sourceFiles: new Set(), ...(d.targetPackage ? { packageDir: d.targetPackage.dir } : {}) });
    }
    const m = meta.get(finding)!;
    skip.trace?.findingOf.set(d, finding);
    m.sourceFiles.add(d.source.file.path); // a type's methods can span files (Go, C# partial classes)
    if (!m.sourceLayers.has(d.sourceLayer)) finding.edges! += 1; // count edges once, not once per source layer
    m.sourceLayers.add(d.sourceLayer);
    // A verified edge outranks an inferred one: the finding keeps the stronger severity.
    if (d.severity === 'error' && finding.severity !== 'error') { finding.severity = 'error'; finding.verifiability = d.verifiability; }
    if (d.line !== undefined && (finding.source!.line === undefined || d.line < finding.source!.line)) finding.source!.line = d.line;
    // Each pair keeps its own strongest severity: a source in two layers can be advisory on one
    // pair and an error on the other (M5-13: layerEdges[].warnings).
    if (d.kind !== 'uncovered') {
      for (const to of d.violatedLayers ?? d.targetLayers) {
        if (to === d.sourceLayer) continue;
        const pk = `${d.sourceLayer}\u0000${to}`;
        if (m.pairs.get(pk) !== 'error') m.pairs.set(pk, d.severity);
      }
    }
    const violated = (d.violatedLayers ?? d.targetLayers).join(', ');
    finding.message = d.kind === 'uncovered'
      ? `${s} depends on ${t}, which is in no layer`
      : d.kind === 'allowed'
        ? `${s} may depend on ${t} (${[...m.sourceLayers].join(', ')} on ${finding.target!.layer})`
        : d.rule === 'private-layer'
          ? `${s} must not depend on ${t}: it is private to ${violated} (${[...m.sourceLayers].join(', ')} on ${violated})`
          : d.rule === 'internal-element' && d.internal
            ? `${s} must not depend on ${t}: ${internalName(d.internal.element, t)} is internal to ${violated} (${d.internal.marker}) (${[...m.sourceLayers].join(', ')} on ${violated})`
            : `${s} must not depend on ${t} (${[...m.sourceLayers].join(', ')} on ${violated})`;
    // An inherited dependency (M5-09) names the inheritance path it comes through.
    if (finding.via) finding.message += `, inherited via ${finding.via.join(' → ')}`;
  }
  for (const [f, m] of meta) {
    const layers = [...m.sourceLayers].sort(byOrder);
    f.source!.layer = layers.join(', ');
    f.source!.layers = layers;
    skip.trace?.pairsOf.set(f, m.pairs);
  }

  // A package-level finding (a Go import) is subsumed by a finer one of the same kind and rule, from
  // the same source file, on a type of that package: the import is how the type is reached. Without
  // one (a package used only through calls the resolver does not link) it stands. Keyed by file,
  // since an import is file-level whatever the file declares (review of M5-04). An allowed import
  // is subsumed by a finer finding of any kind: once the type it reaches is a violation (an internal
  // type, M5-11), the import is how that violation is reached, not an allowed dependency of its own.
  const finer = new Set<string>();
  const anyFiner = new Set<string>();
  for (const [f, m] of meta) {
    if (m.packageDir !== undefined || f.target!.external) continue; // an external target has no directory
    for (const file of m.sourceFiles) {
      finer.add(JSON.stringify([f.kind, f.rule ?? '', file, posix.dirname(f.target!.file)]));
      anyFiner.add(JSON.stringify([file, posix.dirname(f.target!.file)]));
    }
  }
  for (const [key, f] of byKey) {
    const m = meta.get(f)!;
    if (m.packageDir === undefined) continue;
    const subsumed = (file: string) => finer.has(JSON.stringify([f.kind, f.rule ?? '', file, m.packageDir]))
      || (f.kind === 'allowed' && anyFiner.has(JSON.stringify([file, m.packageDir])));
    if ([...m.sourceFiles].every(subsumed)) byKey.delete(key);
  }

  // AR-10: a violation the baseline lists, or the base report already had, is skipped. Before the
  // layer matrix is counted, so a skipped dependency counts as skipped there too.
  const matcher = skip.baseline ? new BaselineMatcher(skip.baseline) : null;
  for (const f of byKey.values()) {
    if (f.kind !== 'violation') continue;
    const by = matcher?.match(f) ? 'baseline' : skip.known?.has(f.fingerprint) ? 'compare' : undefined;
    if (by) { f.kind = 'skipped'; f.skippedBy = by; }
  }

  // layerEdges: dependencies (findings) per layer pair, counted after the subsumption above.
  const pairs = new Map<string, LayerEdge>();
  for (const f of byKey.values()) {
    for (const [pk, severity] of meta.get(f)!.pairs) {
      const [from, to] = pk.split('\u0000') as [string, string];
      const pair = pairs.get(pk) ?? { from, to, allowed: 0, violations: 0, warnings: 0, skipped: 0 };
      if (f.kind === 'allowed') pair.allowed++;
      else if (f.kind === 'skipped') pair.skipped++;
      else { pair.violations++; if (severity === 'warn') pair.warnings++; }
      pairs.set(pk, pair);
    }
  }
  const findings: Finding[] = [...byKey.values()];
  // Uncovered dependencies per source layer, from the layers themselves (a name may contain ", ").
  const uncoveredIn = new Map<string, number>();
  for (const f of findings) if (f.kind === 'uncovered') for (const l of meta.get(f)!.sourceLayers) uncoveredIn.set(l, (uncoveredIn.get(l) ?? 0) + 1);

  // AR-12: an element in several non-overlay layers. Reported once per top-level declaration, or
  // for a file without one that takes part in a dependency (an empty `__init__.py` does not):
  // members and files inherit their declarations' ambiguity.
  for (const el of membership.multiLayer) {
    if (el.kind === 'symbol' ? !el.topLevel : view.ofFile(el.file.path).some((e) => e.kind === 'symbol' && e.topLevel) || !endFiles.has(el.file.path)) continue;
    const layers = membership.primaryOf(el);
    const name = elementName(el);
    findings.push({
      kind: config.policy.strictLayers ? 'error' : 'warning', rule: 'multi-layer', severity: config.policy.strictLayers ? 'error' : 'warn',
      source: { element: name, file: el.file.path, layer: layers.join(', '), layers, repo: el.file.repo },
      fingerprint: fingerprint('multi-layer', name, '', ''), message: `${name} is in ${layers.length} layers: ${layers.join(', ')}`,
    });
  }
  for (const layer of membership.emptyLayers) {
    findings.push({ kind: 'warning', rule: 'empty-layer', severity: 'warn', layer, fingerprint: fingerprint('empty-layer', layer, '', ''), message: `layer ${layer} matches no element` });
  }
  // An entry that matched nothing is stale: the baseline only shrinks (Deptrac's PostProcess).
  if (matcher) findings.push(...matcher.stale(view, repoPaths));
  for (const e of policy.errors) findings.push({ kind: 'error', rule: 'config', severity: 'error', fingerprint: fingerprint('config', e, '', ''), message: e });
  // A selector this version cannot evaluate matches nothing: say so rather than fail silently.
  for (const u of membership.unsupported) {
    findings.push({
      kind: 'warning', rule: 'unsupported-selector', severity: 'warn', layer: u.layer,
      fingerprint: fingerprint('unsupported-selector', u.layer, u.selector, u.key),
      message: `layer ${u.layer}: ${u.selector} uses "${u.key}", which this version cannot evaluate yet (${u.task}); it matches nothing`,
    });
  }

  const filesIn = (layer: string) => new Set(membership.members(layer).filter((e) => e.kind !== 'external').map((e) => e.file.path)).size;
  const report: ArchReport = {
    version: 1,
    counts: Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FindingKind, number>,
    findings: sortFindings(findings),
    layers: membership.layers.map((l) => ({ name: l.name, elements: membership.members(l.name).length, files: filesIn(l.name), overlay: !!l.overlay, uncovered: uncoveredIn.get(l.name) ?? 0 })),
    layerEdges: [...pairs.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0)),
    configErrors: policy.errors,
    policy: reportedUncoveredPolicy(config),
  };
  for (const f of report.findings) report.counts[f.kind]++;
  return report;
}

/** A report for a configuration that cannot be loaded: its issues as errors (`+` cycles named by layer). */
export function configErrorReport(err: ConfigError): ArchReport {
  const findings: Finding[] = err.issues.map((i) => {
    const cycle = /"\+" allowances form a cycle: (.+)$/.exec(i.message);
    const where = `${i.file}${i.pointer ? `#${i.pointer}` : ''}`;
    return cycle
      ? { kind: 'error' as const, rule: 'plus-cycle', severity: 'error' as const, layer: cycle[1]!.split(' → ')[0]!, fingerprint: fingerprint('plus-cycle', cycle[1]!, '', ''), message: `${where}: ${i.message}` }
      : { kind: 'error' as const, rule: 'config', severity: 'error' as const, fingerprint: fingerprint('config', where, i.message, ''), message: `${where}: ${i.message}` };
  });
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FindingKind, number>;
  counts.error = findings.length;
  return { version: 1, counts, findings: sortFindings(findings), layers: [], layerEdges: [], configErrors: findings.map((f) => f.message) };
}

/** The workspace has an architecture configuration but no index to evaluate it on. */
export class NoIndexError extends Error {
  constructor(readonly dir: string) {
    super(`No MapX index in ${dir}: run \`mapx scan\` first`);
    this.name = 'NoIndexError';
  }
}

export interface RunOptions extends LoadOptions {
  /**
   * The baseline: a file (`--baseline`, overriding the configuration's), or false for none (as
   * `--generate-baseline` evaluates). Otherwise the configuration's, or the default file if it exists.
   */
  baseline?: string | false;
  /** Fingerprints of a base revision's report (`--compare`). */
  known?: Set<string>;
  /** An open store on the index; otherwise `<dir>/.mapx/mapx.db` is opened and closed. */
  store?: Store;
  /** Repo name → its path in the workspace (module roots fall back to these). */
  repoPaths?: Record<string, string>;
}

/**
 * Loads the architecture configuration of `dir`, evaluates it on the index and returns the report;
 * null when the workspace has no configuration. An invalid configuration gives a report of errors.
 */
export function runArchitecture(dir: string, options: RunOptions = {}): ArchReport | null {
  let config: ArchitectureConfig | null;
  try {
    config = loadArchitectureConfig(dir, options);
  } catch (err) {
    if (err instanceof ConfigError) return configErrorReport(err);
    throw err;
  }
  if (!config) return null;
  const dbPath = join(dir, '.mapx', 'mapx.db');
  // Never evaluate an empty index: an unscanned workspace would look clean (review of M5-04).
  if (!options.store && !existsSync(dbPath)) throw new NoIndexError(dir);
  let baseline: Baseline | null = null;
  try {
    if (options.baseline !== false) baseline = loadBaseline(dir, config, options.baseline);
  } catch (err) {
    if (err instanceof ConfigError) return configErrorReport(err);
    throw err;
  }
  const store = options.store ?? new Store(dbPath);
  try {
    const membership = getMembership(store, dir, config, dbPath, options.repoPaths);
    // Fingerprints name repos by path: from the caller, else from the workspace's config.json.
    const repoPaths = options.repoPaths ?? registeredRepoPaths(dir);
    return buildReport(store, config, membership, { baseline, known: options.known, repoPaths });
  } finally {
    if (!options.store) store.close();
  }
}

/** Repo name → path from `<dir>/.mapx/config.json`; empty when it cannot be read. */
function registeredRepoPaths(dir: string): Record<string, string> {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, '.mapx', 'config.json'), 'utf8')) as { repos?: Array<{ name?: unknown; path?: unknown }> };
    return Object.fromEntries((cfg.repos ?? []).filter((r) => typeof r.name === 'string' && typeof r.path === 'string').map((r) => [r.name as string, r.path as string]));
  } catch {
    return {};
  }
}
