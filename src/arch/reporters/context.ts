// What the CI reporters (M5-07; AR-16) need beyond the report, and what they share: where a
// finding is (a POSIX path from the repository root, M5-07-R1, and a line), how it reads on one
// line, and which formats `mapx check --format` takes.
import { posix } from 'node:path';
import { getRepoPrefix, inGitCheckout } from '../../core/git-tracker.js';
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
  /**
   * The workspace's folder from the top of its git repository (`sub/`, git-tracker's
   * getRepoPrefix), put before every path: GitHub and GitLab locate files from the checkout root,
   * so a workspace in a monorepo subfolder would name files that do not exist (M5-07-R1). Empty or
   * absent at the top level or outside git: paths stay workspace-relative.
   */
  pathPrefix?: string;
}

/**
 * The `pathPrefix` of a `mapx check` run in `dir`. `table` and `json` stay workspace-relative, so
 * git is asked only for a CI format. If git cannot say where a folder inside a checkout is (a bad
 * GIT_DIR, git's "dubious ownership" refusal in a CI container), the paths stay workspace-relative,
 * and `warn` (stderr) says so: stdout is the report alone (review of M5-07-R1).
 */
export function reportPathPrefix(format: ReportFormat, dir: string, warn: (message: string) => void = (m) => console.error(m)): string {
  if (format === 'table' || format === 'json') return '';
  const prefix = getRepoPrefix(dir);
  if (prefix !== null) return prefix;
  if (inGitCheckout(dir)) warn(`Warning: git could not locate ${dir} in its repository (git rev-parse --show-prefix failed), so report paths are relative to the workspace, not the repository root.`);
  return '';
}

/** A path as every CI format wants it: relative, with `/` (the store already records `/`). */
export const posixPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** A workspace-relative path from the repository root (`sub/../bl.json` is `bl.json`). */
export function repoPath(p: string, ctx: ReportContext): string {
  const path = posixPath(p);
  return ctx.pathPrefix ? posix.normalize(`${posixPath(ctx.pathPrefix)}${path}`) : path;
}

/**
 * Where a finding is fixed, from the repository root: its `location` (a stale entry: the baseline
 * file), else its source file and first line, else the configuration file.
 */
export function locate(f: Finding, ctx: ReportContext): { path: string; line?: number } {
  if (f.location) return { path: repoPath(f.location.file, ctx) };
  if (f.source?.file) return { path: repoPath(f.source.file, ctx), ...(f.source.line !== undefined ? { line: f.source.line } : {}) };
  return { path: repoPath(ctx.configFile, ctx) };
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
