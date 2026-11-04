// The table reporter (M5-05; AR-16): findings grouped by source layer (layer findings by their
// layer), each with its rule, both elements, the edge type, the location and the reason, then a
// summary of the counts. Plain text: no colour, so it reads the same in a terminal, a log or a file.
import type { ArchReport, Finding } from '../report.js';

const MARK: Record<string, string> = { violation: '✖', uncovered: '?', skipped: '-', allowed: '✓', warning: '!', error: '✖' };

function line(f: Finding): string {
  const severity = f.kind === 'violation' ? ` [${f.severity}]` : f.skippedBy ? ` [${f.skippedBy}]` : '';
  const head = `  ${MARK[f.kind] ?? '·'} ${f.rule ?? f.kind}${severity}`;
  if (!f.source) return `${head}  ${f.message}`;
  if (!f.target) return `${head}  ${f.message}${f.source.file ? `\n      ${f.source.file}` : ''}`; // multi-layer: where the element is (an external has no file)
  const where = `${f.source.file}${f.source.line !== undefined ? `:${f.source.line}` : ''}`;
  const via = f.edgeType ? ` (${f.edgeType}${f.verifiability === 'inferred' ? ', inferred' : ''})` : '';
  return `${head}  ${f.source.element} → ${f.target.element}${via}\n      ${where}  ${f.message}`;
}

export function renderTable(report: ArchReport): string {
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = f.source?.layer ?? (f.layer ? `layer ${f.layer}` : 'configuration');
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: string[] = [];
  for (const [group, findings] of groups) {
    out.push(group);
    for (const f of findings) out.push(line(f));
    out.push('');
  }
  out.push(countsLine(report));
  return `${out.join('\n')}\n`;
}

/** The summary of the counts: the table's last line, and the GitHub reporter's. */
export function countsLine(report: ArchReport): string {
  const c = report.counts;
  const errors = report.findings.filter((f) => f.kind === 'violation' && f.severity === 'error').length;
  return `Violations: ${c.violation} (${errors} error, ${c.violation - errors} warn)   Uncovered: ${c.uncovered}   Skipped: ${c.skipped}   Allowed: ${c.allowed}   Warnings: ${c.warning}   Errors: ${c.error}`;
}
