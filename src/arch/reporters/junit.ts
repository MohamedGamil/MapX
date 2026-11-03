// The JUnit reporter (M5-07; AR-16): JUnit XML for the test reports of GitLab
// (`artifacts:reports:junit`) and Jenkins (the junit step). tests/arch-reporters.test.ts validates
// it against the Jenkins xUnit plugin's JUnit schema.
//
// One <testsuite> per non-overlay layer, in the configuration's order, then one per other group of
// findings, in report order: a source in several layers (`Domain, Shared`, as the table groups it)
// and `configuration` for configuration and baseline errors. One <testcase> per finding,
// not per rule: a testcase per rule would hide which dependency broke it, while GitLab and Jenkins
// list every testcase with its file and message. The testcase's class name is the rule.
//   - a finding that fails the run (check.ts failsRun: the same rule as the exit code, so
//     --fail-on warn, --fail-on-uncovered and --compare apply) is a <failure>, or an <error> for a
//     configuration or baseline error;
//   - a skipped violation is <skipped> (message: baseline or --compare);
//   - anything else (a warn-level violation, a warning, an uncovered dependency, an allowed one)
//     passes, its message in <system-out>.
// A layer without findings gets one passing testcase, `no findings`, so a clean run is a report
// of passing tests, never an empty one. No timestamps, durations or host names: byte-stable.
import type { ArchReport, Finding } from '../report.js';
import { CONFIG_RULES, failsRun } from '../check.js';
import { describeFinding, locate, ruleOf, type ReportContext } from './context.js';

/**
 * Escapes text for XML 1.0 content: the five special characters, and CR as a reference (a parser
 * turns CR LF into LF). Characters XML 1.0 cannot carry at all, even escaped (other C0 controls,
 * lone surrogates, U+FFFE and U+FFFF), become U+FFFD.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;');
}

/** Escapes an attribute value: tab and LF as references too, which a parser would turn into spaces. */
export const escapeXmlAttribute = (s: string) => escapeXml(s).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');

const attrs = (a: Record<string, string | number>) => Object.entries(a).map(([k, v]) => ` ${k}="${escapeXmlAttribute(String(v))}"`).join('');

/** The testcase's name: the dependency, or the message of a finding about one element or layer. */
function caseName(f: Finding): string {
  if (f.source && f.target) return `${f.source.element} → ${f.target.element}${f.edgeType ? ` (${f.edgeType})` : ''}`;
  return f.message;
}

interface Case { xml: string; failure: boolean; error: boolean; skipped: boolean }

function testcase(f: Finding, ctx: ReportContext): Case {
  const where = locate(f, ctx);
  const at = `${where.path}${where.line !== undefined ? `:${where.line}` : ''}`;
  const body = `${at}\n${describeFinding(f)}\nfingerprint: ${f.fingerprint}`;
  const head = `    <testcase${attrs({ name: caseName(f), classname: ruleOf(f) })}>`;
  const tail = '    </testcase>';
  if (f.kind === 'skipped') return { xml: `${head}\n      <skipped${attrs({ message: `skipped by ${f.skippedBy === 'compare' ? '--compare' : 'the baseline'}` })}/>\n      <system-out>${escapeXml(body)}</system-out>\n${tail}`, failure: false, error: false, skipped: true };
  if (failsRun(f, ctx.check ?? {})) {
    const tag = f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '') ? 'error' : 'failure';
    return { xml: `${head}\n      <${tag}${attrs({ type: ruleOf(f), message: describeFinding(f) })}>${escapeXml(body)}</${tag}>\n${tail}`, failure: tag === 'failure', error: tag === 'error', skipped: false };
  }
  return { xml: `${head}\n      <system-out>${escapeXml(`${f.kind} (${f.severity}): ${body}`)}</system-out>\n${tail}`, failure: false, error: false, skipped: false };
}

export function renderJunit(report: ArchReport, ctx: ReportContext): string {
  // The suites: every non-overlay layer, then the other groups as they first appear. Narrowed to
  // one layer (--layer), the other layers' suites would claim checks that did not run.
  const only = report.selection?.layer ?? null;
  const groups = new Map<string, Finding[]>();
  for (const l of report.layers) if (!l.overlay && (only === null || l.name === only)) groups.set(l.name, []);
  for (const f of report.findings) {
    const key = (f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '')) ? 'configuration' : f.source?.layer ?? f.layer ?? 'configuration';
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const suites: string[] = [];
  const total = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const [name, findings] of groups) {
    const cases = findings.map((f) => testcase(f, ctx));
    if (!cases.length) cases.push({ xml: `    <testcase${attrs({ name: 'no findings', classname: 'layer' })}/>`, failure: false, error: false, skipped: false });
    const n = {
      tests: cases.length,
      failures: cases.filter((c) => c.failure).length,
      errors: cases.filter((c) => c.error).length,
      skipped: cases.filter((c) => c.skipped).length,
    };
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += n[k];
    suites.push(`  <testsuite${attrs({ name, ...n })}>\n${cases.map((c) => c.xml).join('\n')}\n  </testsuite>`);
  }
  const root = `<testsuites${attrs({ name: 'mapx check', tests: total.tests, failures: total.failures, errors: total.errors })}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${root}\n${suites.join('\n')}\n</testsuites>\n`;
}
