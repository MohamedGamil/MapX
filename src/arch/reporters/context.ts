// What the CI reporters (M5-07; AR-16) need beyond the report, and what they share: where a
// finding is (a workspace-relative POSIX path and line), how it reads on one line, and which
// formats `mapx check --format` takes.
import type { ArchReport, Finding } from '../report.js';
import { failsRun, type CheckOptions } from '../check.js';
import type { CodeClimateSeverityMap } from '../schema.js';

export const FORMATS = ['table', 'json', 'sarif', 'github', 'codeclimate', 'junit'] as const;
export type ReportFormat = typeof FORMATS[number];

export interface ReportContext {
  /**
   * The configuration file checked, workspace-relative (`.mapx/architecture.jsonc`, or a view's):
   * the location of findings without a source file (configuration errors, `empty-layer`,
   * `unsupported-selector`), since CodeClimate and annotations need a file.
   */
  configFile: string;
  /** What fails the run (`--fail-on`, `--fail-on-uncovered`, `--compare`): JUnit fails exactly those. */
  check?: CheckOptions;
  /** `report.codeclimate` from the configuration: finding severity or kind → CodeClimate severity. */
  codeclimate?: CodeClimateSeverityMap;
  /** MapX's version, for SARIF's `tool.driver.version`. */
  version?: string;
}

/** A path as every CI format wants it: relative, with `/` (the store already records `/`). */
export const posixPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Where a finding is fixed: its `location` (a stale entry: the baseline file), else its source file
 * and first line, else the configuration file.
 */
export function locate(f: Finding, ctx: ReportContext): { path: string; line?: number } {
  if (f.location) return { path: posixPath(f.location.file) };
  if (f.source?.file) return { path: posixPath(f.source.file), ...(f.source.line !== undefined ? { line: f.source.line } : {}) };
  return { path: posixPath(ctx.configFile) };
}

/**
 * Does the finding fail this run (check.ts failsRun, the exit-code rule)? Every format marks
 * exactly these at its failing level: SARIF `error`, `::error`, the CodeClimate `error` severity,
 * a JUnit failure or error (review of M5-07).
 */
export const fails = (f: Finding, ctx: ReportContext) => failsRun(f, ctx.check ?? {});

/** The rule a finding reports (`disallowed-layer`, `uncovered`, `stale-baseline` …). */
export const ruleOf = (f: Finding) => f.rule ?? f.kind;

/**
 * The finding's message, with the edge type of a dependency (a stale baseline entry's message
 * names its own) and why it is skipped: the text of an annotation or an issue.
 */
export function describeFinding(f: Finding): string {
  const dependency = f.kind === 'violation' || f.kind === 'skipped' || f.kind === 'uncovered' || f.kind === 'allowed';
  const via = dependency && f.edgeType ? ` [${f.edgeType}${f.verifiability === 'inferred' ? ', inferred' : ''}]` : '';
  const skipped = f.skippedBy ? ` (skipped by ${f.skippedBy === 'baseline' ? 'the baseline' : '--compare'})` : '';
  return `${f.message}${via}${skipped}`;
}

/** Short descriptions of the rules, for SARIF's rule metadata. */
export const RULE_DESCRIPTIONS: Record<string, string> = {
  'disallowed-layer': 'A dependency on a layer the source layer may not use.',
  'private-layer': 'A dependency on an element private to another layer.',
  'internal-element': 'A dependency on an element marked internal to its layer.',
  uncovered: 'A dependency on an element in no layer.',
  allowed: 'A dependency the rules allow.',
  'multi-layer': 'A declaration in more than one layer.',
  'empty-layer': 'A layer that matches no element.',
  'unsupported-selector': 'A selector this version of MapX cannot evaluate yet.',
  'plus-cycle': '"+" allowances that form a cycle.',
  config: 'An invalid architecture configuration.',
  'stale-baseline': 'A baseline entry that matches no violation any more.',
};

export type { ArchReport, Finding };
