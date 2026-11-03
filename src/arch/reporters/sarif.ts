// The SARIF reporter (M5-07; AR-16): SARIF 2.1.0, for GitHub code scanning and IDE viewers.
// tests/arch-reporters.test.ts validates it against the official OASIS schema.
//
// One run. `tool.driver.rules` lists the rules the results use, sorted. Each finding is a result:
//   level        `error` exactly for the findings that fail the run (the exit-code rule, so
//                --fail-on warn and --fail-on-uncovered raise warnings and uncovered dependencies
//                to it); otherwise `warning` for violations, warnings and errors a base report
//                knows, `note` for uncovered and skipped ones; an allowed dependency is
//                `kind: "pass"` at level none (listed only with --report-allowed)
//   locations    the source file (relative to %SRCROOT%, the workspace) and first line, 1 when the
//                finding has none (GitHub requires a start line), and the element as a logical
//                location. A stale baseline entry is located on the baseline file; a finding
//                without a file (a configuration error, `empty-layer`) on the configuration file
//   partialFingerprints  `mapx/v1`: the finding's fingerprint, which survives moved lines
//   suppressions a skipped violation (baseline or --compare) is suppressed `external`, accepted
// `automationDetails.id` is `mapx-check/` (or `mapx-check/<view>/`), so code scanning keeps views
// apart. No timestamps, durations or absolute paths: the output is byte-stable.
import type { ArchReport, Finding } from '../report.js';
import { describeFinding, fails, locate, ruleOf, RULE_DESCRIPTIONS, type ReportContext } from './context.js';

export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
const INFO_URI = 'https://github.com/MohamedGamil/mapx';
const HELP_URI = `${INFO_URI}/blob/main/docs/architecture-rules.md`;

type Level = 'error' | 'warning' | 'note' | 'none';

function level(f: Finding, ctx: ReportContext): Level {
  if (fails(f, ctx)) return 'error';
  if (f.kind === 'allowed') return 'none';
  if (f.kind === 'uncovered' || f.kind === 'skipped') return 'note';
  return 'warning';
}

export function renderSarif(report: ArchReport, ctx: ReportContext): string {
  const ruleIds = [...new Set(report.findings.map(ruleOf))].sort();
  const index = new Map(ruleIds.map((id, i) => [id, i]));
  const rules = ruleIds.map((id) => ({
    id,
    shortDescription: { text: RULE_DESCRIPTIONS[id] ?? id },
    helpUri: HELP_URI,
    properties: { tags: ['architecture'] },
  }));
  const results = report.findings.map((f) => {
    const where = locate(f, ctx);
    const properties: Record<string, unknown> = { kind: f.kind };
    if (f.source?.layer) properties.sourceLayer = f.source.layer;
    if (f.target) properties.target = f.target.element;
    if (f.target?.file) properties.targetFile = f.target.file;
    if (f.target?.layer) properties.targetLayer = f.target.layer;
    if (f.layer) properties.layer = f.layer;
    if (f.edgeType) properties.edgeType = f.edgeType;
    if (f.verifiability) properties.verifiability = f.verifiability;
    if (f.edges !== undefined) properties.edges = f.edges;
    return {
      ruleId: ruleOf(f),
      ruleIndex: index.get(ruleOf(f))!,
      ...(f.kind === 'allowed' ? { kind: 'pass' } : {}),
      level: level(f, ctx),
      message: { text: describeFinding(f) },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: encodeUri(where.path), uriBaseId: '%SRCROOT%' },
          region: { startLine: where.line !== undefined && where.line >= 1 ? where.line : 1 },
        },
        ...(f.source ? { logicalLocations: [{ fullyQualifiedName: f.source.element }] } : {}),
      }],
      partialFingerprints: { 'mapx/v1': f.fingerprint },
      ...(f.kind === 'skipped' ? {
        suppressions: [{
          kind: 'external',
          status: 'accepted',
          justification: f.skippedBy === 'compare' ? 'known to the base report (mapx check --compare)' : 'listed in the architecture baseline',
        }],
      } : {}),
      properties,
    };
  });
  const sarif = {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'MapX', informationUri: INFO_URI, ...(ctx.version ? { version: ctx.version } : {}), rules } },
      automationDetails: { id: `mapx-check/${report.selection?.view ? `${report.selection.view}/` : ''}` },
      results,
    }],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

/**
 * A relative path as a URI reference: each segment percent-encoded (a space, `#`, `%` or `?` in a
 * file name would otherwise change its meaning), the `/` separators kept.
 */
export function encodeUri(path: string): string {
  return path.split('/').map((s) => encodeURIComponent(s)).join('/');
}
