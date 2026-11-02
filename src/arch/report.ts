// The architecture report (M5-04; docs/research/deptrac AR-09, AR-12). Aggregates the evaluator's
// decisions into findings with stable fingerprints, adds the multi-layer and empty-layer warnings
// and configuration errors, and counts dependencies per layer pair (layerEdges, for graphs and the
// DSM). `runArchitecture` is the whole pipeline; M5-05's `mapx check` calls it.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Store } from '../core/store.js';
import { ConfigError, loadArchitectureConfig, type LoadOptions } from './config.js';
import type { ArchitectureConfig } from './schema.js';
import { getMembership, type LayerMembership } from './membership.js';
import { expandPolicy } from './policy.js';
import { ENDPOINT_EDGES, elementName, evaluateEdges, reportElement, type Finding, type FindingKind } from './evaluate.js';

export type { Finding, FindingKind } from './evaluate.js';

export interface ArchReport {
  version: 1;
  counts: Record<FindingKind, number>;
  findings: Finding[];
  layers: Array<{ name: string; elements: number; files: number; overlay: boolean }>;
  layerEdges: Array<{ from: string; to: string; allowed: number; violations: number; skipped: number }>;
  configErrors: string[];
}

/** A finding's stable identity (AR-09): rule, both elements and the edge type; never a line number. */
export function fingerprint(rule: string, source: string, target: string, edgeType: string): string {
  return createHash('sha256').update(JSON.stringify([rule, source, target, edgeType])).digest('hex').slice(0, 16);
}

const KINDS: FindingKind[] = ['violation', 'skipped', 'uncovered', 'allowed', 'warning', 'error'];
const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]));

/** Orders findings deterministically: kind, rule, source, target, edge type, layer. */
export function sortFindings(findings: Finding[]): Finding[] {
  const key = (f: Finding) => [f.rule ?? '', f.source?.element ?? '', f.source?.layer ?? '', f.target?.element ?? '', f.edgeType ?? '', f.layer ?? ''].join('\u0000');
  return findings.sort((a, b) => (KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Builds the report of `config` over the membership (and so the index) it was computed on. */
export function buildReport(store: Store, config: ArchitectureConfig, membership: LayerMembership): ArchReport {
  const view = membership.view;
  const policy = expandPolicy(config);
  const { dependencies: deps, endFiles } = evaluateEdges(store, config, membership, policy);
  const layerOrder = new Map(config.layers.map((l, i) => [l.name, i]));
  const byOrder = (a: string, b: string) => (layerOrder.get(a) ?? 0) - (layerOrder.get(b) ?? 0);

  // One finding per (kind, rule, reported source and target, edge type): a source in several layers
  // (AR-12) gets one finding naming every source layer the rule applies to, so fingerprints are
  // unique within a report (review of M5-04). Each finding remembers the layer pairs it counts for.
  const byKey = new Map<string, Finding>();
  const meta = new Map<Finding, { sourceLayers: Set<string>; pairs: Set<string>; packageDir?: string; sourceFiles: Set<string> }>();
  for (const d of deps) {
    const src = reportElement(view, d.source);
    const tgt = ENDPOINT_EDGES.has(d.edgeType) && d.target.kind === 'symbol' ? d.target : reportElement(view, d.target);
    const s = elementName(src);
    const t = d.targetPackage ? d.targetPackage.name : elementName(tgt);
    const targetFile = d.targetPackage ? d.targetPackage.dir : tgt.file.path;
    const rule = d.rule ?? 'allowed';
    const key = JSON.stringify([d.kind, rule, s, t, d.edgeType]);
    let finding = byKey.get(key);
    if (!finding) {
      const targetLayer = d.targetLayers.join(', ') || undefined;
      finding = {
        kind: d.kind, rule: d.rule, severity: d.severity,
        source: { element: s, file: src.file.path, layer: d.sourceLayer, repo: src.file.repo, ...(d.line !== undefined ? { line: d.line } : {}) },
        target: { element: t, file: targetFile, ...(targetLayer ? { layer: targetLayer } : {}), repo: tgt.file.repo },
        edgeType: d.edgeType, verifiability: d.verifiability, edges: 0,
        fingerprint: fingerprint(rule, s, t, d.edgeType), message: '',
      };
      byKey.set(key, finding);
      meta.set(finding, { sourceLayers: new Set(), pairs: new Set(), sourceFiles: new Set(), ...(d.targetPackage ? { packageDir: d.targetPackage.dir } : {}) });
    }
    const m = meta.get(finding)!;
    m.sourceFiles.add(d.source.file.path); // a type's methods can span files (Go, C# partial classes)
    if (!m.sourceLayers.has(d.sourceLayer)) finding.edges! += 1; // count edges once, not once per source layer
    m.sourceLayers.add(d.sourceLayer);
    // A verified edge outranks an inferred one: the finding keeps the stronger severity.
    if (d.severity === 'error' && finding.severity !== 'error') { finding.severity = 'error'; finding.verifiability = d.verifiability; }
    if (d.line !== undefined && (finding.source!.line === undefined || d.line < finding.source!.line)) finding.source!.line = d.line;
    if (d.kind !== 'uncovered') for (const to of d.violatedLayers ?? d.targetLayers) if (to !== d.sourceLayer) m.pairs.add(`${d.sourceLayer}\u0000${to}`);
    const violated = (d.violatedLayers ?? d.targetLayers).join(', ');
    finding.message = d.kind === 'uncovered'
      ? `${s} depends on ${t}, which is in no layer`
      : d.kind === 'allowed'
        ? `${s} may depend on ${t} (${[...m.sourceLayers].join(', ')} on ${finding.target!.layer})`
        : d.rule === 'private-layer'
          ? `${s} must not depend on ${t}: it is private to ${violated} (${[...m.sourceLayers].join(', ')} on ${violated})`
          : `${s} must not depend on ${t} (${[...m.sourceLayers].join(', ')} on ${violated})`;
  }
  for (const [f, m] of meta) f.source!.layer = [...m.sourceLayers].sort(byOrder).join(', ');

  // A package-level finding (a Go import) is subsumed by a finer one of the same kind and rule, from
  // the same source file, on a type of that package: the import is how the type is reached. Without
  // one (a package used only through calls the resolver does not link) it stands. Keyed by file,
  // since an import is file-level whatever the file declares (review of M5-04).
  const finer = new Set<string>();
  for (const [f, m] of meta) if (m.packageDir === undefined) for (const file of m.sourceFiles) finer.add(JSON.stringify([f.kind, f.rule ?? '', file, posix.dirname(f.target!.file)]));
  for (const [key, f] of byKey) {
    const m = meta.get(f)!;
    if (m.packageDir !== undefined && [...m.sourceFiles].every((file) => finer.has(JSON.stringify([f.kind, f.rule ?? '', file, m.packageDir])))) byKey.delete(key);
  }

  // layerEdges: dependencies (findings) per layer pair, counted after the subsumption above.
  const pairs = new Map<string, { from: string; to: string; allowed: number; violations: number; skipped: number }>();
  for (const f of byKey.values()) {
    for (const pk of meta.get(f)!.pairs) {
      const [from, to] = pk.split('\u0000') as [string, string];
      const pair = pairs.get(pk) ?? { from, to, allowed: 0, violations: 0, skipped: 0 };
      if (f.kind === 'allowed') pair.allowed++;
      else pair.violations++;
      pairs.set(pk, pair);
    }
  }
  const findings: Finding[] = [...byKey.values()];

  // AR-12: an element in several non-overlay layers. Reported once per top-level declaration, or
  // for a file without one that takes part in a dependency (an empty `__init__.py` does not):
  // members and files inherit their declarations' ambiguity.
  for (const el of membership.multiLayer) {
    if (el.kind === 'symbol' ? !el.topLevel : view.ofFile(el.file.path).some((e) => e.kind === 'symbol' && e.topLevel) || !endFiles.has(el.file.path)) continue;
    const layers = membership.primaryOf(el);
    const name = elementName(el);
    findings.push({
      kind: config.policy.strictLayers ? 'error' : 'warning', rule: 'multi-layer', severity: config.policy.strictLayers ? 'error' : 'warn',
      source: { element: name, file: el.file.path, layer: layers.join(', '), repo: el.file.repo },
      fingerprint: fingerprint('multi-layer', name, '', ''), message: `${name} is in ${layers.length} layers: ${layers.join(', ')}`,
    });
  }
  for (const layer of membership.emptyLayers) {
    findings.push({ kind: 'warning', rule: 'empty-layer', severity: 'warn', layer, fingerprint: fingerprint('empty-layer', layer, '', ''), message: `layer ${layer} matches no element` });
  }
  for (const e of policy.errors) findings.push({ kind: 'error', rule: 'config', severity: 'error', fingerprint: fingerprint('config', e, '', ''), message: e });
  // A selector this version cannot evaluate matches nothing: say so rather than fail silently.
  for (const u of membership.unsupported) {
    findings.push({
      kind: 'warning', rule: 'unsupported-selector', severity: 'warn', layer: u.layer,
      fingerprint: fingerprint('unsupported-selector', u.layer, u.selector, u.key),
      message: `layer ${u.layer}: ${u.selector} uses "${u.key}", which this version cannot evaluate yet (${u.task}); it matches nothing`,
    });
  }

  const filesIn = (layer: string) => new Set(membership.members(layer).map((e) => e.file.path)).size;
  const report: ArchReport = {
    version: 1,
    counts: Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FindingKind, number>,
    findings: sortFindings(findings),
    layers: membership.layers.map((l) => ({ name: l.name, elements: membership.members(l.name).length, files: filesIn(l.name), overlay: !!l.overlay })),
    layerEdges: [...pairs.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0)),
    configErrors: policy.errors,
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
  const store = options.store ?? new Store(dbPath);
  try {
    const membership = getMembership(store, dir, config, dbPath, options.repoPaths);
    return buildReport(store, config, membership);
  } finally {
    if (!options.store) store.close();
  }
}
