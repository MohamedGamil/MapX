// `mapx check` (M5-05; docs/research/deptrac AR-16, AR-17): what a report shows and what it exits
// with. The CLI (src/cli.ts) loads the configuration and the index, runs runArchitecture, then
// asks this module which findings to show and which exit code the run ends with.
//
// Exit contract (AR-17):
//   0  no failing finding
//   1  violations of severity error (with --fail-on warn: also warn-level violations and warnings)
//   2  uncovered dependencies, with --fail-on-uncovered
//   3  configuration errors (invalid document, a "+" cycle, no configuration at all)
//   4  the index is missing or stale (scan or --sync required), or an internal error
// When several apply, the lowest-level problem wins: 4 before 3 before 1 before 2. The CLI checks
// the index (4) before it loads the configuration (3); this module decides 3, 1 and 2.
import type { ArchReport, Finding, FindingKind } from './report.js';

export const EXIT = { ok: 0, violations: 1, uncovered: 2, config: 3, index: 4 } as const;

export interface CheckOptions {
  /** Show uncovered dependencies (they never fail the run without failOnUncovered). */
  reportUncovered?: boolean;
  failOnUncovered?: boolean;
  /** Show skipped (baselined) violations; baselines arrive with M5-06. */
  reportSkipped?: boolean;
  /** Show allowed dependencies (normally only counted). */
  reportAllowed?: boolean;
  /** `warn` makes warn-level violations and warnings fail the run. */
  failOn?: 'error' | 'warn';
  /** Only findings with this source or target layer (dependency findings) or layer (layer findings). */
  layer?: string;
  /** Only findings with this rule (`disallowed-layer`, `private-layer`, `uncovered`, `multi-layer` …). */
  rule?: string;
}

/** Error findings about the configuration or baseline, not the code: exit 3. */
export const CONFIG_RULES = new Set(['config', 'plus-cycle', 'stale-baseline']);

/** The rules `--rule` accepts: those the evaluator reports, and those later tasks add. */
export const CHECK_RULES = ['disallowed-layer', 'private-layer', 'internal-element', 'uncovered', 'allowed', 'multi-layer', 'empty-layer', 'unsupported-selector', 'plus-cycle', 'config', 'stale-baseline'];

const KINDS: FindingKind[] = ['violation', 'skipped', 'uncovered', 'allowed', 'warning', 'error'];

const layersOf = (s: string | undefined) => (s ? s.split(', ') : []);

/** Does a finding concern `layer`? Its source or target layers, or the layer it is about. */
function inLayer(f: Finding, layer: string): boolean {
  return [...layersOf(f.source?.layer), ...layersOf(f.target?.layer), ...(f.layer ? [f.layer] : [])].includes(layer);
}

/**
 * The findings `--layer` and `--rule` select (configuration errors always stay: they concern the
 * whole run). Counts are recomputed on them; layers and layerEdges are kept whole.
 */
export function selectFindings(report: ArchReport, options: CheckOptions): ArchReport {
  const findings = report.findings.filter((f) => {
    if (f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '')) return true;
    if (options.layer && !inLayer(f, options.layer)) return false;
    if (options.rule && (f.rule ?? f.kind) !== options.rule) return false;
    return true;
  });
  return withCounts({ ...report, findings });
}

/** The report a reporter prints: the selection, without the kinds that are not shown. */
export function shownReport(report: ArchReport, options: CheckOptions): ArchReport {
  const selected = selectFindings(report, options);
  const hidden = new Set<FindingKind>();
  if (!options.reportUncovered && !options.failOnUncovered) hidden.add('uncovered');
  if (!options.reportSkipped) hidden.add('skipped');
  if (!options.reportAllowed) hidden.add('allowed');
  // Counts keep every selected kind, so a reader sees how many were hidden.
  return { ...selected, findings: selected.findings.filter((f) => !hidden.has(f.kind)) };
}

function withCounts(report: ArchReport): ArchReport {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FindingKind, number>;
  for (const f of report.findings) counts[f.kind]++;
  return { ...report, counts };
}

/** The exit code of a run that produced `report` (exit 4 is the CLI's: it never gets a report). */
export function exitCode(report: ArchReport, options: CheckOptions): number {
  if (report.findings.some((f) => f.kind === 'error' && CONFIG_RULES.has(f.rule ?? ''))) return EXIT.config;
  const selected = selectFindings(report, options).findings;
  const failsOn = (f: Finding) =>
    f.kind === 'violation' && (f.severity === 'error' || options.failOn === 'warn')
    || f.kind === 'error' // multi-layer under strictLayers
    || (f.kind === 'warning' && options.failOn === 'warn');
  if (selected.some(failsOn)) return EXIT.violations;
  if (options.failOnUncovered && selected.some((f) => f.kind === 'uncovered')) return EXIT.uncovered;
  return EXIT.ok;
}
