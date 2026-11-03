// The reporters of `mapx check --format` (M5-05, M5-07; AR-16).
import type { ArchReport } from '../report.js';
import { renderCodeclimate } from './codeclimate.js';
import { FORMATS, type ReportContext, type ReportFormat } from './context.js';
import { renderGithub } from './github.js';
import { renderJson } from './json.js';
import { renderJunit } from './junit.js';
import { renderSarif } from './sarif.js';
import { renderTable } from './table.js';

export { FORMATS, type ReportContext, type ReportFormat };

export function renderReport(format: ReportFormat, report: ArchReport, ctx: ReportContext): string {
  switch (format) {
    case 'table': return renderTable(report);
    case 'json': return renderJson(report);
    case 'sarif': return renderSarif(report, ctx);
    case 'github': return renderGithub(report, ctx);
    case 'codeclimate': return renderCodeclimate(report, ctx);
    case 'junit': return renderJunit(report, ctx);
  }
}

/**
 * The format of a run: the one given, else `github` when the report goes to stdout inside GitHub
 * Actions (GITHUB_ACTIONS is "true" on every runner), else `table`. Workflow commands only work in
 * the step's log, so `--output <file>` keeps the table (review of M5-07).
 */
export function defaultFormat(given: string | undefined, env: NodeJS.ProcessEnv = process.env, toStdout = true): string {
  if (given !== undefined) return given;
  return toStdout && env.GITHUB_ACTIONS === 'true' ? 'github' : 'table';
}
