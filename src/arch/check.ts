// `mapx check` (M5-05; docs/research/deptrac AR-16, AR-17): what a report shows and what it exits
// with. The CLI (src/cli.ts) loads the configuration and the index, runs runArchitecture, then
// asks this module which findings to show and which exit code the run ends with.
//
// Exit contract (AR-17):
//   0  no failing finding
//   1  violations of severity error (with --fail-on warn: also warn-level violations and warnings)
//   2  uncovered dependencies, with --fail-on-uncovered
//   3  configuration errors (invalid document, a "+" cycle, no configuration at all) and baseline
//      errors (an invalid baseline or base report, a stale baseline entry)
//   4  the index is missing or stale (scan or --sync required), or an internal error
// When several apply, the lowest-level problem wins: 4 before 3 before 1 before 2. The CLI checks
// the index (4) before it loads the configuration (3); this module decides 3, 1 and 2.
import type { ArchReport, Finding, FindingKind } from './report.js';

export const EXIT = { ok: 0, violations: 1, uncovered: 2, config: 3, index: 4 } as const;

export interface CheckOptions {
  /** Show uncovered dependencies (they never fail the run without failOnUncovered). */
  reportUncovered?: boolean;
  failOnUncovered?: boolean;
  /** Show skipped violations (a baseline or `--compare` accepts them, M5-06). */
  reportSkipped?: boolean;
  /** Show allowed dependencies (normally only counted). */
  reportAllowed?: boolean;
  /** `warn` makes warn-level violations and warnings fail the run. */
  failOn?: 'error' | 'warn';
  /** Only findings with this source or target layer (dependency findings) or layer (layer findings). */
  layer?: string;
  /** Only findings with this rule (`disallowed-layer`, `private-layer`, `uncovered`, `multi-layer` …). */
  rule?: string;
  /**
   * Fingerprints of a base revision's report (`--compare`, M5-06): a failing finding among them
   * (a warning under `--fail-on warn`, an uncovered dependency under `--fail-on-uncovered`, a
   * strict `multi-layer` error) does not fail the run. Known violations are already skipped.
   */
  known?: Set<string>;
}

/** Error findings about the configuration or baseline, not the code: exit 3. */
export const CONFIG_RULES = new Set(['config', 'plus-cycle', 'stale-baseline']);

/** The rules `--rule` accepts: those the evaluator reports, and those later tasks add. */
export const CHECK_RULES = ['disallowed-layer', 'private-layer', 'internal-element', 'uncovered', 'allowed', 'multi-layer', 'empty-layer', 'unsupported-selector', 'plus-cycle', 'config', 'stale-baseline'];

const KINDS: FindingKind[] = ['violation', 'skipped', 'uncovered', 'allowed', 'warning', 'error'];

/**
 * An end's layers: the list, since a layer name may contain ", " (M5-15 review). A report read from
 * a file that predates the list (`--compare`) falls back to splitting the joined names.
 */
export const endLayers = (end: Finding['source']): string[] => end?.layers ?? (end?.layer ? end.layer.split(', ') : []);

/** Does a finding concern `layer`? Its source or target layers, or the layer it is about. */
function inLayer(f: Finding, layer: string): boolean {
  return [...endLayers(f.source), ...endLayers(f.target), ...(f.layer ? [f.layer] : [])].includes(layer);
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

/**
 * The findings of dependencies written in a file that changed (`--since`, M5-98-R1): a finding is
 * kept when its source file is in `changed`, since a dependency lives in its source file, and a
 * changed target alone does not make an existing dependency new. Findings without a source (an
 * empty layer, a selector problem) concern the configuration, not changed code, and are dropped;
 * configuration and baseline errors always stay. Counts are recomputed.
 */
export function sinceFindings(report: ArchReport, changed: ReadonlySet<string>): ArchReport {
  const findings = report.findings.filter((f) => isConfigError(f) || (f.source?.file !== undefined && f.source.file !== '' && changed.has(f.source.file)));
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

/** A configuration or baseline error: exit 3, whatever the options. */
const isConfigError = (f: Finding) => f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '');

/** Does `f` fail the run as a violation (exit 1)? A finding the base report knows does not. */
function failsAsViolation(f: Finding, options: CheckOptions): boolean {
  if (options.known?.has(f.fingerprint)) return false;
  return f.kind === 'violation' && (f.severity === 'error' || options.failOn === 'warn')
    || f.kind === 'error' // multi-layer under strictLayers
    || (f.kind === 'warning' && options.failOn === 'warn');
}

const failsAsUncovered = (f: Finding, options: CheckOptions) => !!options.failOnUncovered && f.kind === 'uncovered' && !options.known?.has(f.fingerprint);

/**
 * Does this finding make the run fail (exit 3, 1 or 2)? The JUnit reporter (M5-07) fails exactly
 * these testcases, so its failures agree with the exit code.
 */
export function failsRun(f: Finding, options: CheckOptions): boolean {
  return isConfigError(f) || failsAsViolation(f, options) || failsAsUncovered(f, options);
}

/** The exit code of a run that produced `report` (exit 4 is the CLI's: it never gets a report). */
export function exitCode(report: ArchReport, options: CheckOptions): number {
  if (report.findings.some(isConfigError)) return EXIT.config;
  const selected = selectFindings(report, options).findings;
  if (selected.some((f) => failsAsViolation(f, options))) return EXIT.violations;
  if (selected.some((f) => failsAsUncovered(f, options))) return EXIT.uncovered;
  return EXIT.ok;
}
