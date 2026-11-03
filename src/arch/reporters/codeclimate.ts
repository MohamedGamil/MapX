// The CodeClimate reporter (M5-07; AR-16): a GitLab Code Quality report, the JSON array of
// CodeClimate issues GitLab reads (`artifacts:reports:codequality`).
//
// Each finding but an allowed dependency is an issue with the fields GitLab requires
// (`description`, `check_name`, `fingerprint`, `severity`, `location.path`, `location.lines.begin`)
// and the spec's `type` and `categories`.
//
// Fingerprint: a violation's is the finding's own (M5-06), so GitLab matches it across a merge
// request's base and head exactly as a baseline does. Every other kind derives one from its kind,
// rule and finding fingerprint, because the same finding fingerprint names several issues: a
// violation, the same dependency skipped by a baseline, and the stale entry once it is fixed
// (review of M5-07). Distinct issues never share a fingerprint, in one report or across two.
//
// Severity: the map `report.codeclimate` in the configuration. `error` is for the findings that
// fail the run (the exit-code rule: so --fail-on warn and --fail-on-uncovered raise what they
// fail); `warn` for the other violations and warnings (an advisory rule, an inferred edge);
// `uncovered` and `skipped` by kind. Defaults follow Deptrac: a failure is major, a skipped
// violation minor, an uncovered dependency info; a warning is minor.
import { createHash } from 'node:crypto';
import type { ArchReport, Finding } from '../report.js';
import { CONFIG_RULES, failsRun, type CheckOptions } from '../check.js';
import type { CodeClimateSeverity, CodeClimateSeverityMap } from '../schema.js';
import { locate, messageOf, ruleOf, type ReportContext } from './context.js';

export const CODECLIMATE_DEFAULTS: Required<CodeClimateSeverityMap> = { error: 'major', warn: 'minor', uncovered: 'info', skipped: 'minor' };

/** The CodeClimate severity of a finding under `map` (the configuration's, over the defaults). */
export function codeclimateSeverity(f: Finding, map: CodeClimateSeverityMap = {}, check: CheckOptions = {}): CodeClimateSeverity {
  const key = failsRun(f, check) ? 'error' : f.kind === 'uncovered' || f.kind === 'skipped' ? f.kind : 'warn';
  return map[key] ?? CODECLIMATE_DEFAULTS[key];
}

/** The issue fingerprint: a violation's finding fingerprint, else one derived from kind and rule. */
export function codeclimateFingerprint(f: Finding): string {
  if (f.kind === 'violation') return f.fingerprint;
  return createHash('sha256').update(JSON.stringify(['codeclimate', f.kind, ruleOf(f), f.fingerprint])).digest('hex').slice(0, 16);
}

export function renderCodeclimate(report: ArchReport, ctx: ReportContext): string {
  const issues = report.findings.filter((f) => f.kind !== 'allowed').map((f) => {
    const where = locate(f, ctx);
    return {
      type: 'issue',
      check_name: ruleOf(f),
      description: messageOf(f, ctx),
      // Configuration and baseline errors are mistakes in the rules, not coupling in the code.
      categories: [f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '') ? 'Bug Risk' : 'Complexity'],
      severity: codeclimateSeverity(f, ctx.codeclimate, ctx.check),
      fingerprint: codeclimateFingerprint(f),
      location: { path: where.path, lines: { begin: where.line !== undefined && where.line >= 1 ? where.line : 1 } },
    };
  });
  return `${JSON.stringify(issues, null, 2)}\n`;
}
