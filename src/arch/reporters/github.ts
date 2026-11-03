// The GitHub Actions reporter (M5-07; AR-16): workflow commands, which GitHub turns into
// annotations on the file and line of the pull request. `mapx check` picks it when GITHUB_ACTIONS
// is "true", no --format is given and the report goes to stdout.
//
// The output has three parts:
//   1. every finding as a plain log line, in report order: `[error] app/Domain/Order.php:5 disallowed-layer: …`
//   2. the annotations: `::error file=app/Domain/Order.php,line=5,title=disallowed-layer::App\Domain\Order must not …`
//   3. the counts line, saying how many findings were not annotated.
// `::error` marks exactly the findings that fail the run (check.ts failsRun, the exit-code rule);
// other violations and warnings are `::warning`, uncovered and skipped ones `::notice`, and allowed
// ones are not annotated. GitHub shows at most 10 annotations of each level per step, so the run's
// causes come first: configuration errors, stale baseline entries, then failing findings by
// severity, then the rest in report order. Beyond 10 per level nothing is annotated, the counts
// line says how many, and part 1 still lists them (review of M5-07: the exit-3 cause was the
// eleventh error).
//
// Escaping is the Actions toolkit's (@actions/core, command.ts): in the message `%`, CR and LF; in
// a property also `:` and `,`. A log line has its line breaks replaced by spaces and never starts
// with `::`. So one finding is always one line, and no text from the code can start a command.
import type { ArchReport, Finding } from '../report.js';
import { countsLine } from './table.js';
import { describeFinding, fails, locate, ruleOf, type ReportContext } from './context.js';

/** GitHub's limit of annotations per level (error, warning, notice) in one step. */
export const ANNOTATION_CAP = 10;

/** Escapes a command's message (the toolkit's `escapeData`). */
export const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Escapes a property value (the toolkit's `escapeProperty`). */
export const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

type Command = 'error' | 'warning' | 'notice';

function command(f: Finding, ctx: ReportContext): Command {
  if (fails(f, ctx)) return 'error';
  return f.kind === 'uncovered' || f.kind === 'skipped' ? 'notice' : 'warning';
}

/** Annotation order: what makes the run fail, its likeliest cause first. */
function rank(f: Finding, ctx: ReportContext): number {
  if (!fails(f, ctx)) return 4;
  if (f.kind === 'error' && (f.rule === 'config' || f.rule === 'plus-cycle')) return 0;
  if (f.rule === 'stale-baseline') return 1;
  return f.severity === 'error' ? 2 : 3;
}

export function renderGithub(report: ArchReport, ctx: ReportContext): string {
  const shown = report.findings.filter((f) => f.kind !== 'allowed');
  const at = (f: Finding) => {
    const where = locate(f, ctx);
    return `${where.path}${where.line !== undefined ? `:${where.line}` : ''}`;
  };
  const log = shown.map((f) => `[${command(f, ctx)}] ${at(f)} ${ruleOf(f)}: ${describeFinding(f).replace(/\r\n|\r|\n/g, ' ')}`);

  const ordered = shown.map((f, i) => ({ f, i, r: rank(f, ctx) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
  const used: Record<Command, number> = { error: 0, warning: 0, notice: 0 };
  let omitted = 0;
  const annotations: string[] = [];
  for (const f of ordered) {
    const cmd = command(f, ctx);
    if (used[cmd] >= ANNOTATION_CAP) { omitted++; continue; }
    used[cmd]++;
    const where = locate(f, ctx);
    const props = [`file=${escapeProperty(where.path)}`];
    if (where.line !== undefined) props.push(`line=${where.line}`);
    props.push(`title=${escapeProperty(ruleOf(f))}`);
    annotations.push(`::${cmd} ${props.join(',')}::${escapeData(describeFinding(f))}`);
  }
  const cut = omitted ? `   ${omitted} more not annotated (GitHub shows ${ANNOTATION_CAP} per level in a step); see the log lines above or --format sarif` : '';
  return `${[...log, ...annotations, `${countsLine(report)}${cut}`].join('\n')}\n`;
}
