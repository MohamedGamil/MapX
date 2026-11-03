import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import Ajv from 'ajv';
import { cleanup, init, mapx, mapxResult, mapxResultEnv, useBuiltCli, workspace } from './helpers/e2e';
import type { ArchReport, Finding } from '../src/arch/report';
import { configErrorReport } from '../src/arch/report';
import { ConfigError } from '../src/arch/config';
import { exitCode, failsRun, CONFIG_RULES, type CheckOptions } from '../src/arch/check';
import { renderReport, defaultFormat, type ReportContext } from '../src/arch/reporters/index';
import { keyLine, ruleOf } from '../src/arch/reporters/context';
import { escapeData, escapeProperty, renderGithub } from '../src/arch/reporters/github';
import { escapeXml, escapeXmlAttribute, renderJunit } from '../src/arch/reporters/junit';
import { codeclimateFingerprint, codeclimateSeverity, renderCodeclimate } from '../src/arch/reporters/codeclimate';
import { encodeUri, renderSarif } from '../src/arch/reporters/sarif';
import { VERSION } from '../src/version';

// M5-07 (AR-16): the CI reporters of `mapx check`: sarif, github, codeclimate and junit. Each is
// validated against the real schema or spec, not just its shape:
//   - SARIF against the official OASIS SARIF 2.1.0 schema, vendored in
//     tests/fixtures/arch-reporters/schemas (see NOTICE.md there for source and licence);
//   - GitHub workflow commands by parsing them back as the runner does (the toolkit's escaping);
//   - CodeClimate against the issue spec's required fields, as GitLab Code Quality reads them;
//   - JUnit with a strict XML 1.0 reader here, and against the Jenkins xUnit plugin's XSD with
//     lxml when python3 has it.
// Golden files: tests/fixtures/arch-reporters/golden, from the PHP fixture tests/fixtures/arch-rules/php
// (violations, a baseline's skipped pair, uncovered dependencies, a stale entry, an empty layer, a
// multi-layer warning). Regenerate them with UPDATE_GOLDEN=1 after a deliberate change.

const FIXTURES = resolve(__dirname, 'fixtures/arch-reporters');
const GOLDEN = join(FIXTURES, 'golden');
const PHP = resolve(__dirname, 'fixtures/arch-rules/php');
const FORMATS = ['sarif', 'github', 'codeclimate', 'junit'] as const;
const EXT: Record<string, string> = { sarif: 'sarif.json', github: 'github.txt', codeclimate: 'codeclimate.json', junit: 'junit.xml' };

// ─── Validators ───────────────────────────────────────────────────────────────────────────────

/**
 * The official SARIF schema is draft-04; ajv 8 reads draft-07. The only draft-04 construct it uses
 * is `id` (draft-07 `$id`), so a copy with `$schema` dropped and `id` renamed is the same schema.
 * Formats are checked too: `uri` must parse as an absolute URL, `uri-reference` must be RFC 3986
 * characters with valid percent-escapes.
 */
function sarifValidator() {
  const schema = JSON.parse(readFileSync(join(FIXTURES, 'schemas/sarif-schema-2.1.0.json'), 'utf8'));
  delete schema.$schema;
  schema.$id = schema.id;
  delete schema.id;
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat('uri', (s: string) => { try { return !!new URL(s).protocol; } catch { return false; } });
  ajv.addFormat('uri-reference', /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?#]|%[0-9A-Fa-f]{2})*$/);
  ajv.addFormat('date-time', (s: string) => !Number.isNaN(Date.parse(s)));
  return ajv.compile(schema);
}
const validateSarif = sarifValidator();
function expectValidSarif(text: string) {
  const ok = validateSarif(JSON.parse(text));
  expect(ok, JSON.stringify(validateSarif.errors, null, 2)).toBe(true);
}

/**
 * The CodeClimate issue spec (github.com/codeclimate/platform, spec/analyzers/SPEC.md), with the
 * fields GitLab Code Quality requires: description, check_name, fingerprint, severity,
 * location.path and location.lines.begin. A report is a JSON array of issues.
 */
const CODECLIMATE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['type', 'check_name', 'description', 'categories', 'severity', 'fingerprint', 'location'],
    properties: {
      type: { const: 'issue' },
      check_name: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      categories: { type: 'array', minItems: 1, items: { enum: ['Bug Risk', 'Clarity', 'Compatibility', 'Complexity', 'Duplication', 'Performance', 'Security', 'Style'] } },
      severity: { enum: ['info', 'minor', 'major', 'critical', 'blocker'] },
      fingerprint: { type: 'string', minLength: 1 },
      location: {
        type: 'object',
        required: ['path', 'lines'],
        properties: {
          path: { type: 'string', pattern: '^(?![/\\\\])(?![A-Za-z]:)[^\\\\]+$' },
          lines: { type: 'object', required: ['begin'], properties: { begin: { type: 'integer', minimum: 1 } } },
        },
      },
    },
  },
};
const validateCodeclimate = new Ajv({ allErrors: true }).compile(CODECLIMATE_SCHEMA);

/** Parses a workflow command back as the runner does: properties split on `,` and the first `=`, then unescaped. */
function parseCommand(line: string): { command: string; props: Record<string, string>; message: string } {
  const m = /^::([a-z]+)(?: ([^:]*))?::(.*)$/.exec(line);
  if (!m) throw new Error(`not a workflow command: ${line}`);
  const unescape = (s: string) => s.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%25/g, '%');
  const props: Record<string, string> = {};
  for (const p of (m[2] ?? '').split(',').filter(Boolean)) {
    const eq = p.indexOf('=');
    props[p.slice(0, eq)] = unescape(p.slice(eq + 1));
  }
  return { command: m[1]!, props, message: unescape(m[3]!) };
}

interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }
/**
 * A strict reader of the XML 1.0 subset JUnit uses: a declaration, elements, double-quoted
 * attributes, text, and entity or character references. It rejects a raw `<` or `&`, an unknown
 * entity, a character XML forbids, a mismatched tag and a duplicate attribute, and normalises as
 * a conforming parser does (CR LF → LF; tab, CR and LF in an attribute → space).
 */
function parseXml(xml: string): XmlNode {
  const forbidden = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
  if (forbidden.test(xml)) throw new Error('a character XML 1.0 forbids');
  const src = xml.replace(/\r\n?/g, '\n');
  const decode = (s: string, attr: boolean) => {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s)) throw new Error(`a bare & in ${JSON.stringify(s)}`);
    const n = attr ? s.replace(/[\t\n\r]/g, ' ') : s;
    return n.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!);
  };
  let i = 0;
  const decl = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/.exec(src);
  if (!decl) throw new Error('no XML declaration');
  i = decl[0].length;
  const element = (): XmlNode => {
    const open = /^<([A-Za-z][\w-]*)/.exec(src.slice(i));
    if (!open) throw new Error(`an element expected at ${i}`);
    i += open[0].length;
    const node: XmlNode = { name: open[1]!, attrs: {}, children: [], text: '' };
    for (;;) {
      const a = /^\s+([A-Za-z][\w-]*)="([^"<]*)"/.exec(src.slice(i));
      if (!a) break;
      if (a[1]! in node.attrs) throw new Error(`duplicate attribute ${a[1]}`);
      node.attrs[a[1]!] = decode(a[2]!, true);
      i += a[0].length;
    }
    if (src.startsWith('/>', i)) { i += 2; return node; }
    if (src[i] !== '>') throw new Error(`a malformed tag at ${i}: ${src.slice(i, i + 30)}`);
    i++;
    for (;;) {
      const lt = src.indexOf('<', i);
      if (lt < 0) throw new Error(`unclosed <${node.name}>`);
      node.text += decode(src.slice(i, lt), false);
      i = lt;
      if (src.startsWith(`</${node.name}>`, i)) { i += node.name.length + 3; return node; }
      if (src.startsWith('</', i)) throw new Error(`mismatched close at ${i}`);
      node.children.push(element());
    }
  };
  const root = element();
  if (src.slice(i) !== '\n') throw new Error('content after the root element');
  return root;
}
const all = (n: XmlNode, name: string): XmlNode[] => [...(n.name === name ? [n] : []), ...n.children.flatMap((c) => all(c, name))];

/**
 * python3 with lxml, for XSD validation; absent on some CI images, where that test skips. Isolated
 * (-I: no current directory or environment on the module path), with the user's site-packages,
 * where lxml is often installed, added back explicitly.
 */
const PY_PRELUDE = 'import site, sys\nsys.path.append(site.getusersitepackages())\nfrom lxml import etree\n';
const lxml = spawnSync('python3', ['-I', '-c', PY_PRELUDE], { encoding: 'utf8' }).status === 0;
function validateJunitXsd(xml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mapx-junit-'));
  temps.push(dir);
  writeFileSync(join(dir, 'report.xml'), xml);
  const code = `${PY_PRELUDE}schema = etree.XMLSchema(etree.parse(sys.argv[1]))\ndoc = etree.parse(sys.argv[2])\nprint("valid" if schema.validate(doc) else str(schema.error_log))`;
  const r = spawnSync('python3', ['-I', '-c', code, join(FIXTURES, 'schemas/junit-10.xsd'), join(dir, 'report.xml')], { cwd: dir, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.trim();
}

// ─── A synthetic report with hostile text ─────────────────────────────────────────────────────

const C = String.fromCharCode;
// `%`, CR LF, `:` and `,` (workflow commands), `<&"'>` (XML), a C0 control and a lone surrogate
// (which XML cannot carry), an astral character (which it can), and a command injection attempt.
const HOSTILE = `100% sure: a, b <x attr="y">&amp; 'q'${C(1)}${C(0xd800)} ok \u{1F600}\r\n::error::injected`;
const HOSTILE_FILE = 'src/we ird,dir/a:b%c#d.php';
const finding = (over: Partial<Finding>): Finding => ({ kind: 'violation', rule: 'disallowed-layer', severity: 'error', fingerprint: 'f'.repeat(16), message: HOSTILE, ...over });
const hostile: ArchReport = {
  version: 1,
  counts: { violation: 2, skipped: 1, uncovered: 1, allowed: 1, warning: 1, error: 1 },
  findings: [
    finding({ source: { element: 'App\\A', file: HOSTILE_FILE, layer: 'App', line: 3 }, target: { element: `T${HOSTILE}`, file: 'src/t.php', layer: 'Domain' }, edgeType: 'call', verifiability: 'inferred', fingerprint: '0000000000000001' }),
    finding({ severity: 'warn', source: { element: 'App\\B', file: 'src/b.php', layer: 'App', line: 9 }, target: { element: 'D', file: 'src/d.php', layer: 'Domain' }, edgeType: 'import', fingerprint: '0000000000000002' }),
    finding({ kind: 'skipped', skippedBy: 'compare', source: { element: 'App\\C', file: 'src/c.php', layer: 'App', line: 1 }, target: { element: 'D', file: 'src/d.php', layer: 'Domain' }, edgeType: 'import', fingerprint: '0000000000000003' }),
    finding({ kind: 'uncovered', rule: 'uncovered', severity: 'warn', source: { element: 'App\\C', file: 'src/c.php', layer: 'App', line: 2 }, target: { element: 'X', file: 'vendor/x.php' }, edgeType: 'import', fingerprint: '0000000000000004' }),
    finding({ kind: 'allowed', rule: undefined, severity: 'info', source: { element: 'App\\C', file: 'src/c.php', layer: 'App', line: 2 }, target: { element: 'Y', file: 'src/y.php', layer: 'Domain' }, edgeType: 'import', fingerprint: '0000000000000005' }),
    finding({ kind: 'warning', rule: 'empty-layer', severity: 'warn', layer: 'Empty', fingerprint: '0000000000000006' }),
    finding({ kind: 'error', rule: 'config', severity: 'error', fingerprint: '0000000000000007' }),
  ],
  layers: [{ name: 'App', elements: 3, files: 3, overlay: false, uncovered: 0 }, { name: 'Domain', elements: 1, files: 1, overlay: false, uncovered: 0 }, { name: 'Vendor', elements: 0, files: 0, overlay: true, uncovered: 0 }, { name: 'Empty', elements: 0, files: 0, overlay: false, uncovered: 0 }],
  layerEdges: [],
  configErrors: [HOSTILE],
  selection: { view: null, layer: null, rule: null },
};
const ctx: ReportContext = { configFile: '.mapx/architecture.jsonc', check: {}, version: '9.9.9' };

const temps: string[] = [];
afterAll(() => { for (const t of temps) cleanup(t); });
useBuiltCli(); // ~170 ms a CLI start instead of ~600 ms under tsx (M4-30)
// M4-30, timeouts: with 16 busy loops (load 18–26, 10 runs), the slowest test on the default 30 s
// took 4.9 s ("a stale entry in a baseline outside the workspace"; 1.7 s quiet, 6.3 s before
// M4-30). The default stands; the tests with their own timeouts are unchanged.

describe('reporters on hostile text (unit)', () => {
  it('SARIF validates against the official 2.1.0 schema; paths are relative URI references; skipped is suppressed', () => {
    const text = renderSarif(hostile, ctx);
    expectValidSarif(text);
    const run = JSON.parse(text).runs[0];
    expect(run.tool.driver.version).toBe('9.9.9');
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id)).toEqual(['allowed', 'config', 'disallowed-layer', 'empty-layer', 'uncovered']);
    const [r0, r1, r2, r3, r4, r5, r6] = run.results;
    expect(r0.locations[0].physicalLocation.artifactLocation).toEqual({ uri: 'src/we%20ird%2Cdir/a%3Ab%25c%23d.php', uriBaseId: '%SRCROOT%' });
    expect(decodeURIComponent(r0.locations[0].physicalLocation.artifactLocation.uri)).toBe(HOSTILE_FILE);
    expect(r0.locations[0].physicalLocation.region).toEqual({ startLine: 3 });
    expect(r0.message.text).toContain(HOSTILE); // JSON carries any text; only XML replaces characters
    expect(r0.message.text).toContain('[call, inferred]');
    // `error` exactly for what fails the run: the error violation and the configuration error.
    expect([r0.level, r1.level, r2.level, r3.level, r4.level, r5.level, r6.level]).toEqual(['error', 'warning', 'note', 'note', 'none', 'warning', 'error']);
    // --fail-on warn raises the warn violation and the warning; --fail-on-uncovered the uncovered.
    const levels = (check: CheckOptions) => JSON.parse(renderSarif(hostile, { ...ctx, check })).runs[0].results.map((r: { level: string }) => r.level);
    expect(levels({ failOn: 'warn' })).toEqual(['error', 'error', 'note', 'note', 'none', 'error', 'error']);
    expect(levels({ failOnUncovered: true })).toEqual(['error', 'warning', 'note', 'error', 'none', 'warning', 'error']);
    expect(r4.kind).toBe('pass');
    expect(r2.suppressions).toEqual([{ kind: 'external', status: 'accepted', justification: 'known to the base report (mapx check --compare)' }]);
    expect(run.results.map((r: { partialFingerprints: Record<string, string> }) => r.partialFingerprints['mapx/v1'])).toEqual(hostile.findings.map((f) => f.fingerprint));
    // A finding without a file (empty-layer, config) is located on the configuration file, line 1
    // (GitHub code scanning requires a start line).
    expect(r5.locations[0].physicalLocation.artifactLocation.uri).toBe('.mapx/architecture.jsonc');
    expect(run.results.map((r: { locations: Array<{ physicalLocation: { region: { startLine: number } } }> }) => r.locations[0]!.physicalLocation.region.startLine)).toEqual([3, 9, 1, 2, 2, 1, 1]);
    expect(r6.ruleIndex).toBe(1);
    expect(encodeUri('../peer/a b.ts')).toBe('../peer/a%20b.ts');
  });

  it('a file outside the repository is located on the configuration file, in every CI format; the message names it (review of M5-07-R2)', () => {
    const stale = (file: string, n: number) => finding({ kind: 'error', rule: 'stale-baseline', message: `${file}#/entries/0: stale`, location: { file, pointer: '/entries/0' }, fingerprint: `${n}`.padStart(16, '0') });
    const files = ['../../outside/bl.json', '../bl.json', '..bl/x.json', '/abs/bl.json', 'C:/ci/bl.json', 'D:/ci/bl.json'];
    const inSub: ReportContext = { ...ctx, pathPrefix: 'sub/', baselineLine: 4 };
    const report: ArchReport = { ...hostile, findings: files.map(stale) };
    const text = renderSarif(report, inSub);
    expectValidSarif(text);
    const results = JSON.parse(text).runs[0].results as Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>; message: { text: string }; properties: { outsideRoot?: string } }>;
    // Every result has a physical location in the repository (GitHub requires one): an outside file
    // is replaced by the configuration file, at the line naming the baseline. `..bl/` is a workspace folder.
    expect(results.map((r) => `${r.locations[0]!.physicalLocation.artifactLocation.uri}:${r.locations[0]!.physicalLocation.region.startLine}`))
      .toEqual(['sub/.mapx/architecture.jsonc:4', 'bl.json:1', 'sub/..bl/x.json:1', 'sub/.mapx/architecture.jsonc:4', 'sub/.mapx/architecture.jsonc:4', 'sub/.mapx/architecture.jsonc:4']);
    // An absolute path (another drive) is never put under the prefix.
    expect(results.map((r) => r.properties.outsideRoot ?? null)).toEqual(['../outside/bl.json', null, null, '/abs/bl.json', 'C:/ci/bl.json', 'D:/ci/bl.json']);
    expect(results[0]!.message.text).toBe('../../outside/bl.json#/entries/0: stale (in ../outside/bl.json, outside the repository)');
    // The other formats: the same location, the outside file only in the message.
    const gh = renderGithub(report, inSub).split('\n').filter((l) => l.startsWith('::')).map(parseCommand);
    expect(gh.map((c) => `${c.props.file}:${c.props.line}`)).toEqual(['sub/.mapx/architecture.jsonc:4', 'bl.json:undefined', 'sub/..bl/x.json:undefined', 'sub/.mapx/architecture.jsonc:4', 'sub/.mapx/architecture.jsonc:4', 'sub/.mapx/architecture.jsonc:4']);
    expect(gh[5]!.message).toBe('D:/ci/bl.json#/entries/0: stale (in D:/ci/bl.json, outside the repository)');
    const cc = JSON.parse(renderCodeclimate(report, inSub)) as Array<{ location: { path: string; lines: { begin: number } }; description: string }>;
    expect(cc.map((i) => i.location.path)).toEqual(['sub/.mapx/architecture.jsonc', 'bl.json', 'sub/..bl/x.json', 'sub/.mapx/architecture.jsonc', 'sub/.mapx/architecture.jsonc', 'sub/.mapx/architecture.jsonc']);
    expect(cc[0]!.location.lines.begin).toBe(4);
    const junit = renderJunit(report, inSub);
    expect(junit).toContain('sub/.mapx/architecture.jsonc:4\nD:/ci/bl.json#/entries/0: stale (in D:/ci/bl.json, outside the repository)');
    // No location in any CI format leaves the repository or is absolute.
    for (const path of [...results.map((r) => r.locations[0]!.physicalLocation.artifactLocation.uri), ...gh.map((c) => c.props.file!), ...cc.map((i) => i.location.path)]) {
      expect(path.startsWith('..') && !path.startsWith('..bl') || /^[A-Za-z]:|^\//.test(path), path).toBe(false);
    }
    // At the top level, or with no repository, the workspace is %SRCROOT%; with no line named, line 1.
    const top = JSON.parse(renderSarif({ ...hostile, findings: ['..', '../bl.json', 'bl.json', '..bl/x.json'].map(stale) }, ctx)).runs[0].results as typeof results;
    expect(top.map((r) => r.properties.outsideRoot ?? null)).toEqual(['..', '../bl.json', null, null]);
    expect(top.map((r) => `${r.locations[0]!.physicalLocation.artifactLocation.uri}:${r.locations[0]!.physicalLocation.region.startLine}`))
      .toEqual(['.mapx/architecture.jsonc:1', '.mapx/architecture.jsonc:1', 'bl.json:1', '..bl/x.json:1']);
    // A finding with an element keeps its logical location.
    const sourced = JSON.parse(renderSarif({ ...hostile, findings: [{ ...stale('../x.json', 9), source: { element: 'App\\X', file: '', layer: 'App' } }] }, ctx)).runs[0].results[0];
    expect(sourced.locations[0].logicalLocations).toEqual([{ fullyQualifiedName: 'App\\X' }]);
    expect(keyLine('{\n  "layers": [],\n  "baseline": "../bl.json"\n}\n', 'baseline')).toBe(3);
    expect(keyLine('{ "layers": [] }', 'baseline')).toBeUndefined();
  });

  it('GitHub: one command per finding, escaped as the toolkit does, so each parses back to the original text', () => {
    expect(escapeData('a%b\rc\nd:e,f')).toBe('a%25b%0Dc%0Ad:e,f');
    expect(escapeProperty('a%b\rc\nd:e,f')).toBe('a%25b%0Dc%0Ad%3Ae%2Cf');
    const lines = renderGithub(hostile, ctx).split('\n');
    expect(lines.pop()).toBe(''); // a final newline
    expect(lines.pop()).toMatch(/^Violations: 2 .*Errors: 1$/); // nothing cut
    // Every finding but the allowed one as a plain log line, in report order, then the annotations.
    const log = lines.filter((l) => !l.startsWith('::'));
    const annotations = lines.filter((l) => l.startsWith('::'));
    expect(lines).toEqual([...log, ...annotations]);
    expect(log).toHaveLength(6);
    expect(log.every((l) => /^\[(error|warning|notice)\] /.test(l))).toBe(true);
    expect(log[0]).toBe(`[error] ${HOSTILE_FILE}:3 disallowed-layer: ${HOSTILE.replace(/\r\n/, ' ')} [call, inferred]`);
    const parsed = annotations.map(parseCommand);
    // The run's causes first (the configuration error, then the error violation), then report order.
    expect(parsed.map((p) => `${p.command} ${p.props.title}`)).toEqual(['error config', 'error disallowed-layer', 'warning disallowed-layer', 'notice disallowed-layer', 'notice uncovered', 'warning empty-layer']);
    expect(parsed[1]!.props).toEqual({ file: HOSTILE_FILE, line: '3', title: 'disallowed-layer' });
    expect(parsed[1]!.message).toBe(`${HOSTILE} [call, inferred]`);
    expect(parsed[3]!.message).toBe(`${HOSTILE} [import] (skipped by --compare)`);
    expect(parsed[5]!.props).toEqual({ file: '.mapx/architecture.jsonc', title: 'empty-layer' });
    // ::error marks exactly what fails the run: with --fail-on warn, the warnings too.
    const commands = (check: CheckOptions) => renderGithub(hostile, { ...ctx, check }).split('\n').filter((l) => l.startsWith('::')).map((l) => `${parseCommand(l).command} ${parseCommand(l).props.title}`);
    expect(commands({ failOn: 'warn' })).toEqual(['error config', 'error disallowed-layer', 'error disallowed-layer', 'error empty-layer', 'notice disallowed-layer', 'notice uncovered']);
    // The injection attempt stays inside its message: no line starts a second command.
    expect(annotations.every((l) => /^::(error|warning|notice) file=/.test(l))).toBe(true);
    expect(log.every((l) => !l.includes('\n') && !l.startsWith('::'))).toBe(true);
  });

  it('GitHub: at most 10 annotations per level, the run-failing causes first, and the cut stated', () => {
    const many: ArchReport = {
      ...hostile,
      findings: [
        ...Array.from({ length: 12 }, (_, i) => finding({ message: `v${i}`, source: { element: `A${i}`, file: `src/a${i}.php`, layer: 'App', line: i + 1 }, target: { element: 'D', file: 'src/d.php', layer: 'Domain' }, edgeType: 'import', fingerprint: i.toString(16).padStart(16, '0') })),
        finding({ kind: 'error', rule: 'stale-baseline', message: 'stale', location: { file: '.mapx/architecture.baseline.json', pointer: '/entries/0' }, fingerprint: 'a'.repeat(16) }),
        finding({ kind: 'error', rule: 'config', message: 'bad', fingerprint: 'b'.repeat(16) }),
      ],
    };
    const lines = renderGithub(many, ctx).split('\n');
    const errors = lines.filter((l) => l.startsWith('::error'));
    expect(errors).toHaveLength(10);
    expect(errors.slice(0, 2).map((l) => parseCommand(l).props.title)).toEqual(['config', 'stale-baseline']);
    expect(parseCommand(errors[1]!).props.file).toBe('.mapx/architecture.baseline.json');
    expect(lines.at(-2)).toMatch(/ 4 more not annotated \(GitHub shows 10 per level in a step\); see the log lines above or --format sarif$/);
    // Nothing is lost: every finding is a log line, the unannotated ones included.
    expect(lines.filter((l) => l.startsWith('[error] '))).toHaveLength(14);
    expect(lines).toContain('[error] src/a11.php:12 disallowed-layer: v11 [import]');
  });

  it('CodeClimate: the spec fields, the finding fingerprints, severities by the map; allowed dependencies are not issues', () => {
    const issues = JSON.parse(renderCodeclimate(hostile, ctx));
    expect(validateCodeclimate(issues), JSON.stringify(validateCodeclimate.errors)).toBe(true);
    // A violation's issue fingerprint is its finding fingerprint; other kinds derive one.
    expect(issues.map((i: { fingerprint: string }) => i.fingerprint)).toEqual(hostile.findings.filter((f) => f.kind !== 'allowed').map(codeclimateFingerprint));
    expect(issues.slice(0, 2).map((i: { fingerprint: string }) => i.fingerprint)).toEqual(['0000000000000001', '0000000000000002']);
    expect(issues[2].fingerprint).not.toBe('0000000000000003');
    expect(issues.map((i: { severity: string }) => i.severity)).toEqual(['major', 'minor', 'minor', 'info', 'minor', 'major']);
    expect(issues[0].location).toEqual({ path: HOSTILE_FILE, lines: { begin: 3 } });
    expect(issues[4].location).toEqual({ path: '.mapx/architecture.jsonc', lines: { begin: 1 } });
    expect(issues[5].categories).toEqual(['Bug Risk']);
    const mapped = JSON.parse(renderCodeclimate(hostile, { ...ctx, codeclimate: { error: 'blocker', warn: 'info', skipped: 'info', uncovered: 'critical' } }));
    expect(mapped.map((i: { severity: string }) => i.severity)).toEqual(['blocker', 'info', 'info', 'critical', 'info', 'blocker']);
    expect(codeclimateSeverity(hostile.findings[1]!, { error: 'critical' })).toBe('minor'); // a key left out keeps its default
    // The failing level follows the run: --fail-on warn and --fail-on-uncovered map to `error`.
    expect(codeclimateSeverity(hostile.findings[1]!, {}, { failOn: 'warn' })).toBe('major');
    expect(codeclimateSeverity(hostile.findings[3]!, {}, { failOnUncovered: true })).toBe('major');
  });

  it('CodeClimate: one finding fingerprint as a violation, a skipped violation and a stale entry gives three issue fingerprints', () => {
    const fp = '0816fbd611f92a81';
    const asViolation = finding({ fingerprint: fp });
    const asSkipped = finding({ kind: 'skipped', skippedBy: 'baseline', fingerprint: fp });
    const asStale = finding({ kind: 'error', rule: 'stale-baseline', fingerprint: fp });
    const ids = [asViolation, asSkipped, asStale].map(codeclimateFingerprint);
    expect(ids[0]).toBe(fp); // the baseline's and the JSON report's identity, unchanged
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });

  it('JUnit: well-formed XML 1.0 that carries the text back; failures follow the exit rule; a suite per layer', () => {
    expect(escapeXml(`a<b>&"'\r\n\t${C(0)}${C(0xdfff)}`)).toBe(`a&lt;b&gt;&amp;&quot;&apos;&#13;\n\t${C(0xfffd)}${C(0xfffd)}`);
    expect(escapeXmlAttribute('a\tb\nc')).toBe('a&#9;b&#10;c');
    const xml = renderJunit(hostile, ctx);
    const root = parseXml(xml);
    expect(root.name).toBe('testsuites');
    // A non-overlay layer each, in configuration order (Vendor is an overlay), then other groups.
    expect(all(root, 'testsuite').map((s) => s.attrs.name)).toEqual(['App', 'Domain', 'Empty', 'configuration']);
    const app = all(root, 'testsuite')[0]!;
    expect(app.attrs).toMatchObject({ tests: '5', failures: '1', errors: '0', skipped: '1' });
    const [c0, c1, c2] = all(app, 'testcase');
    // The forbidden characters became U+FFFD; everything else, CR LF included, survives.
    const kept = HOSTILE.replace(C(1), C(0xfffd)).replace(C(0xd800), C(0xfffd));
    expect(c0!.attrs.name).toBe(`App\\A → T${kept} (call)`);
    expect(all(c0!, 'failure')[0]!.attrs.message).toBe(`${kept} [call, inferred]`);
    expect(all(c0!, 'failure')[0]!.text).toContain(`${HOSTILE_FILE}:3\n${kept}`);
    expect(all(c1!, 'failure')).toEqual([]); // warn: passes under the default --fail-on error
    expect(all(c2!, 'skipped')[0]!.attrs.message).toBe('skipped by --compare');
    // Domain has no finding: one passing testcase, so the report is never empty.
    expect(all(all(root, 'testsuite')[1]!, 'testcase').map((t) => t.attrs.name)).toEqual(['no findings']);
    expect(all(all(root, 'testsuite')[3]!, 'error')).toHaveLength(1);
    expect(root.attrs).toMatchObject({ tests: '8', failures: '1', errors: '1' });
    // --fail-on warn makes the warn violation and the warning fail, as the exit code does.
    const strict = parseXml(renderJunit(hostile, { ...ctx, check: { failOn: 'warn' } }));
    expect(strict.attrs).toMatchObject({ failures: '3', errors: '1' });
  });

  it.skipIf(!lxml)('JUnit validates against the Jenkins xUnit plugin JUnit XSD (lxml)', () => {
    expect(validateJunitXsd(renderJunit(hostile, ctx))).toBe('valid');
    expect(validateJunitXsd(renderJunit({ ...hostile, findings: [] }, ctx))).toBe('valid');
  });

  it('JUnit failures agree with the exit code, whatever the options', () => {
    const cases: CheckOptions[] = [{}, { failOn: 'warn' }, { failOnUncovered: true }, { known: new Set(['0000000000000001']) }];
    const noConfig = { ...hostile, findings: hostile.findings.filter((f) => f.rule !== 'config') };
    for (const check of cases) {
      const failures = Number(parseXml(renderJunit(noConfig, { ...ctx, check })).attrs.failures);
      expect(failures > 0, JSON.stringify(check)).toBe(exitCode(noConfig, check) !== 0);
    }
  });

  it('a configuration-error report renders in every format; SARIF still validates', () => {
    const report = configErrorReport(new ConfigError([{ file: '.mapx/architecture.jsonc', pointer: '/layers/0', message: `bad: ${HOSTILE}` }]));
    expectValidSarif(renderSarif(report, ctx));
    expect(validateCodeclimate(JSON.parse(renderCodeclimate(report, ctx)))).toBe(true);
    expect(parseCommand(renderGithub(report, ctx).split('\n').find((l) => l.startsWith('::'))!)).toMatchObject({ command: 'error', props: { file: '.mapx/architecture.jsonc' } });
    expect(parseXml(renderJunit(report, ctx)).attrs).toMatchObject({ tests: '1', errors: '1' });
  });

  it('GITHUB_ACTIONS chooses the github format only when no --format is given', () => {
    expect(defaultFormat(undefined, { GITHUB_ACTIONS: 'true' })).toBe('github');
    expect(defaultFormat('table', { GITHUB_ACTIONS: 'true' })).toBe('table');
    expect(defaultFormat(undefined, {})).toBe('table');
    expect(defaultFormat(undefined, { GITHUB_ACTIONS: 'false' })).toBe('table');
    // Workflow commands only work in the step's log: a file keeps the table.
    expect(defaultFormat(undefined, { GITHUB_ACTIONS: 'true' }, false)).toBe('table');
    expect(defaultFormat('github', { GITHUB_ACTIONS: 'true' }, false)).toBe('github');
  });

  it('the output is deterministic: the same report renders the same bytes', () => {
    for (const f of FORMATS) expect(renderReport(f, hostile, ctx)).toBe(renderReport(f, structuredClone(hostile), { ...ctx }));
  });
});

// ─── End to end on the PHP fixture, with golden files ─────────────────────────────────────────

/** A scanned copy of a fixture in a fresh temporary directory. */
function scannedCopy(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mapx-reporters-'));
  temps.push(root);
  cpSync(fixture, root, { recursive: true, filter: (p) => !p.endsWith('mapx.db') });
  init(root);
  mapx(root, 'scan');
  return root;
}
const ARGS = ['--report-skipped', '--report-uncovered'];
/** The MapX version is in SARIF's driver: the golden file has a placeholder. */
const normalise = (text: string) => text.replace(`"version": ${JSON.stringify(VERSION)},`, '"version": "<version>",');

describe('golden files on the PHP fixture (the real CLI)', () => {
  let root = '';
  let other = '';
  beforeAll(() => { root = scannedCopy(PHP); other = scannedCopy(PHP); }, 180_000);

  for (const format of FORMATS) {
    it(`${format}: matches the golden file, byte for byte, twice and from another directory`, () => {
      const r = mapxResult(root, 'check', '--format', format, ...ARGS);
      expect(r.status, r.stderr).toBe(3); // the fixture's deliberate stale baseline entry (php-26)
      const out = normalise(r.stdout);
      const file = join(GOLDEN, `php.${EXT[format]}`);
      if (process.env.UPDATE_GOLDEN) writeFileSync(file, out);
      expect(existsSync(file), `${file} is missing: run with UPDATE_GOLDEN=1`).toBe(true);
      expect(out).toBe(readFileSync(file, 'utf8'));
      expect(normalise(mapxResult(root, 'check', '--format', format, ...ARGS).stdout)).toBe(out);
      expect(normalise(mapxResult(other, 'check', '--format', format, ...ARGS).stdout)).toBe(out);
      // Relative POSIX paths only: nothing of the machine.
      expect(out).not.toContain(root);
      expect(out).not.toContain(tmpdir());
    });
  }

  it('SARIF and JUnit of the fixture pass their schemas; CodeClimate fingerprints derive from the JSON report', () => {
    expectValidSarif(mapxResult(root, 'check', '--format', 'sarif', ...ARGS).stdout);
    const sarifAll = mapxResult(root, 'check', '--format', 'sarif', ...ARGS, '--report-allowed').stdout;
    expectValidSarif(sarifAll);
    const json: ArchReport = JSON.parse(mapxResult(root, 'check', '--format', 'json', ...ARGS).stdout);
    const issues = JSON.parse(mapxResult(root, 'check', '--format', 'codeclimate', ...ARGS).stdout);
    expect(validateCodeclimate(issues), JSON.stringify(validateCodeclimate.errors)).toBe(true);
    expect(issues.map((i: { fingerprint: string }) => i.fingerprint)).toEqual(json.findings.map(codeclimateFingerprint));
    // Violations keep the finding fingerprint (the baseline's identity), as the criterion asks.
    const violations = json.findings.filter((f) => f.kind === 'violation');
    expect(violations.length).toBeGreaterThan(0);
    expect(issues.filter((i: { fingerprint: string }) => violations.some((v) => v.fingerprint === i.fingerprint))).toHaveLength(violations.length);
    expect(new Set(issues.map((i: { fingerprint: string }) => i.fingerprint)).size).toBe(issues.length);
    // The kinds M5-06 adds map sensibly: skipped by the baseline, the stale entry an error.
    const sarif = JSON.parse(mapxResult(root, 'check', '--format', 'sarif', ...ARGS).stdout).runs[0];
    const skipped = sarif.results.filter((r: { suppressions?: unknown[] }) => r.suppressions);
    expect(skipped.map((r: { partialFingerprints: Record<string, string> }) => r.partialFingerprints['mapx/v1']).sort()).toEqual(json.findings.filter((f) => f.kind === 'skipped').map((f) => f.fingerprint).sort());
    // The stale entry is located in the baseline file, where it has to be deleted (review of M5-07).
    expect(sarif.results.find((r: { ruleId: string }) => r.ruleId === 'stale-baseline')).toMatchObject({ level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: '.mapx/architecture.baseline.json' }, region: { startLine: 1 } } }] });
    expect(json.findings.find((f) => f.rule === 'stale-baseline')).toMatchObject({ location: { file: '.mapx/architecture.baseline.json', pointer: '/entries/0' } });
    // Every result has a start line: 1 for a file-level finding such as multi-layer.
    expect(sarif.results.every((r: { locations: Array<{ physicalLocation: { region?: { startLine: number } } }> }) => (r.locations[0]!.physicalLocation.region?.startLine ?? 0) >= 1)).toBe(true);
    expect(sarif.results.find((r: { ruleId: string }) => r.ruleId === 'multi-layer').locations[0].physicalLocation.region).toEqual({ startLine: 1 });
    const junit = parseXml(mapxResult(root, 'check', '--format', 'junit', ...ARGS).stdout);
    expect(all(junit, 'testsuite').map((s) => s.attrs.name)).toEqual(['Controller', 'Application', 'Domain', 'Shared', 'Infrastructure', 'Reporting', 'Domain, Shared', 'configuration']);
    expect(all(junit, 'skipped')).toHaveLength(3); // php-07's import, instantiation and call (M2-12)
    expect(all(all(junit, 'testsuite').at(-1)!, 'error')[0]!.attrs.type).toBe('stale-baseline');
    if (lxml) expect(validateJunitXsd(mapxResult(root, 'check', '--format', 'junit', ...ARGS, '--report-allowed').stdout)).toBe('valid');
  });

  it('GITHUB_ACTIONS=true without --format prints annotations on stdout; --format table, or --output, keeps the table', () => {
    const gh = mapxResultEnv(root, { GITHUB_ACTIONS: 'true' }, 'check');
    expect(gh.status).toBe(3);
    const first = gh.stdout.split('\n').find((l) => l.startsWith('::'))!;
    // The exit-3 cause is annotated first, at the baseline file.
    expect(parseCommand(first)).toMatchObject({ command: 'error', props: { file: '.mapx/architecture.baseline.json', title: 'stale-baseline' } });
    const table = mapxResultEnv(root, { GITHUB_ACTIONS: 'true' }, 'check', '--format', 'table');
    expect(table.stdout.startsWith('Controller\n')).toBe(true);
    expect(mapxResult(root, 'check').stdout.startsWith('Controller\n')).toBe(true); // no GITHUB_ACTIONS: the table
    // Workflow commands in a file do nothing: --output without --format writes the table (review of M5-07).
    const out = join(mkdtempSync(join(tmpdir(), 'mapx-reporters-out-')), 'report.txt');
    temps.push(join(out, '..'));
    const file = mapxResultEnv(root, { GITHUB_ACTIONS: 'true' }, 'check', '--output', out);
    expect(file.status).toBe(3);
    expect(file.stdout).toBe('');
    expect(readFileSync(out, 'utf8').startsWith('Controller\n')).toBe(true);
    expect(mapxResultEnv(root, { GITHUB_ACTIONS: 'true' }, 'check', '--format', 'github', '--output', out).status).toBe(3);
    expect(readFileSync(out, 'utf8')).toContain('::error file=');
  });

  // 15 errors since M5-11: php-19 and php-20 (@internal, import and instantiation each) are internal-element violations.
  // 22 since M2-12: each `(new X())->run()` violation has its call beside the instantiation (7 more).
  it('GitHub: the 22 errors of the fixture: the stale entry (the exit-3 cause) is annotated, the cut is stated, every finding is logged', () => {
    const lines = mapxResult(root, 'check', '--format', 'github', ...ARGS).stdout.split('\n');
    const errors = lines.filter((l) => l.startsWith('::error'));
    expect(errors).toHaveLength(10);
    expect(parseCommand(errors[0]!).props.title).toBe('stale-baseline');
    expect(parseCommand(errors[0]!).message).toMatch(/^\.mapx\/architecture\.baseline\.json#\/entries\/0: the baseline entry /);
    // 12 errors past the 10 shown (HttpGateway's packages in no layer are out of scope: M5-24-R4, D039);
    // M2-12 adds the `(new X())->run()` calls beside the instantiations.
    expect(lines.at(-2)).toMatch(/Errors: 1   12 more not annotated \(GitHub shows 10 per level in a step\); see the log lines above or --format sarif$/);
    const json: ArchReport = JSON.parse(mapxResult(root, 'check', '--format', 'json', ...ARGS).stdout);
    const logged = lines.filter((l) => /^\[(error|warning|notice)\] /.test(l));
    expect(logged).toHaveLength(json.findings.filter((f) => f.kind !== 'allowed').length);
    expect(logged.filter((l) => l.startsWith('[error] '))).toHaveLength(22);
  });

  it('an unknown --format is a usage error (exit 3) that lists the formats', () => {
    const r = mapxResult(root, 'check', '--format', 'xml');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('table, json, sarif, github, codeclimate, junit');
  });
});

describe('severities follow the configuration (CodeClimate) and the exit rule (JUnit)', () => {
  // Synthetic PHP app, labelled. App may use Domain only as an advisory (warn) rule; Domain may
  // use nothing; Support is in no layer.
  //   App\App\PlaceOrder → App\Domain\Order    violation, warn (advisory), import + instantiation
  //   App\App\PlaceOrder → App\Support\Clock   uncovered
  //   App\Domain\Order   → App\Infra\Repo      violation, error, import + instantiation
  const layers = [
    { name: 'App', selectors: [{ path: 'app/App/**' }] },
    { name: 'Domain', selectors: [{ path: 'app/Domain/**' }] },
    { name: 'Infra', selectors: [{ path: 'app/Infra/**' }] },
  ];
  const rules = { App: [{ allow: ['Domain'], severity: 'warn' }], Domain: [], Infra: ['Domain'] };
  const APP: Record<string, string> = {
    'composer.json': '{"name":"acme/reporters","autoload":{"psr-4":{"App\\\\":"app/"}}}\n',
    'app/App/PlaceOrder.php': '<?php\nnamespace App\\App;\n\nuse App\\Domain\\Order;\nuse App\\Support\\Clock;\n\nclass PlaceOrder {\n  public function run() { new Clock(); return new Order(); }\n}\n',
    'app/Domain/Order.php': '<?php\nnamespace App\\Domain;\n\nuse App\\Infra\\Repo;\n\nclass Order {\n  public function save() { return new Repo(); }\n}\n',
    'app/Infra/Repo.php': '<?php\nnamespace App\\Infra;\n\nclass Repo {}\n',
    'app/Support/Clock.php': '<?php\nnamespace App\\Support;\n\nclass Clock {}\n',
    '.mapx/architecture.jsonc': JSON.stringify({ layers, rules, report: { codeclimate: { error: 'critical', warn: 'info', uncovered: 'minor' } } }),
    '.mapx/architecture/plain.jsonc': JSON.stringify({ layers, rules }),
  };
  let root = '';
  beforeAll(() => {
    root = workspace(APP);
    temps.push(root);
    init(root);
    mapx(root, 'scan');
  }, 120_000);

  const severities = (...args: string[]) => {
    const issues: Array<{ check_name: string; severity: string; location: { path: string } }> = JSON.parse(mapxResult(root, 'check', '--format', 'codeclimate', '--report-uncovered', ...args).stdout);
    return issues.map((i) => `${i.location.path} ${i.check_name} ${i.severity}`);
  };

  it('report.codeclimate maps error, warn and uncovered; without it, the defaults', () => {
    expect(severities()).toEqual([
      'app/App/PlaceOrder.php disallowed-layer info', 'app/App/PlaceOrder.php disallowed-layer info',
      'app/Domain/Order.php disallowed-layer critical', 'app/Domain/Order.php disallowed-layer critical',
      'app/App/PlaceOrder.php uncovered minor', 'app/App/PlaceOrder.php uncovered minor',
    ]);
    expect(severities('--view', 'plain')).toEqual([
      'app/App/PlaceOrder.php disallowed-layer minor', 'app/App/PlaceOrder.php disallowed-layer minor',
      'app/Domain/Order.php disallowed-layer major', 'app/Domain/Order.php disallowed-layer major',
      'app/App/PlaceOrder.php uncovered info', 'app/App/PlaceOrder.php uncovered info',
    ]);
  });

  it('an invalid report.codeclimate is a configuration error (exit 3)', () => {
    // The scanned workspace with the invalid configuration: check reads it, the scan does not (M4-30).
    const bad = mkdtempSync(join(tmpdir(), 'mapx-reporters-'));
    temps.push(bad);
    cpSync(root, bad, { recursive: true });
    writeFileSync(join(bad, '.mapx/architecture.jsonc'), JSON.stringify({ layers, rules, report: { codeclimate: { error: 'severe', fatal: 'major' } } }));
    const r = mapxResult(bad, 'check', '--format', 'json');
    expect(r.status).toBe(3);
    const messages = (JSON.parse(r.stdout) as ArchReport).findings.map((f) => f.message);
    expect(messages).toContain('.mapx/architecture.jsonc#/report/codeclimate/error: expected one of info, minor, major, critical, blocker');
    expect(messages.some((m) => m.includes('#/report/codeclimate/fatal: unknown report.codeclimate key "fatal"'))).toBe(true);
  }, 120_000);

  it('JUnit fails the error violations only; with --fail-on warn the advisory ones too; --fail-on-uncovered the uncovered', () => {
    const failed = (...args: string[]) => {
      const r = mapxResult(root, 'check', '--format', 'junit', '--report-uncovered', ...args);
      const xml = parseXml(r.stdout);
      return { status: r.status, failed: all(xml, 'testcase').filter((t) => all(t, 'failure').length).map((t) => `${t.attrs.classname} ${t.attrs.name}`) };
    };
    expect(failed()).toEqual({ status: 1, failed: ['disallowed-layer App\\Domain\\Order → App\\Infra\\Repo (import)', 'disallowed-layer App\\Domain\\Order → App\\Infra\\Repo (instantiation)'] });
    expect(failed('--fail-on', 'warn').failed).toHaveLength(4);
    expect(failed('--layer', 'App')).toMatchObject({ status: 0, failed: [] });
    expect(failed('--layer', 'App', '--fail-on-uncovered')).toMatchObject({ status: 2, failed: ['uncovered App\\App\\PlaceOrder → App\\Support\\Clock (import)', 'uncovered App\\App\\PlaceOrder → App\\Support\\Clock (instantiation)'] });
    // Suites: every layer; narrowed by --layer, only that layer (others did not run).
    const suites = (...args: string[]) => all(parseXml(mapxResult(root, 'check', '--format', 'junit', ...args).stdout), 'testsuite').map((s) => s.attrs.name);
    expect(suites()).toEqual(['App', 'Domain', 'Infra']);
    expect(suites('--layer', 'App')).toEqual(['App']);
  });

  it('every format marks exactly the run-failing findings at its failing level, and the exit cause is among them', () => {
    // Review of M5-07 (P1-1): with every error violation baselined and --fail-on-uncovered, the run
    // exits 2, but GitHub and SARIF had shown no error at all.
    const pair = join(root, '.mapx', 'pair.baseline.json');
    const stale = join(root, '.mapx', 'stale.baseline.json');
    writeFileSync(pair, JSON.stringify({ version: 1, skip_violations: { 'App\\Domain\\Order': ['App\\Infra\\Repo'] } }));
    writeFileSync(stale, JSON.stringify({ version: 1, skip_violations: { 'App\\Domain\\Order': ['App\\Infra\\Repo'], 'App\\App\\PlaceOrder': ['App\\Infra\\Repo'] } }));
    const cases: Array<{ args: string[]; check: CheckOptions; exit: number; cause: (f: Finding) => boolean }> = [
      { args: [], check: {}, exit: 1, cause: (f) => f.kind === 'violation' },
      { args: ['--fail-on', 'warn'], check: { failOn: 'warn' }, exit: 1, cause: (f) => f.kind === 'violation' && f.severity === 'warn' },
      { args: ['--baseline', pair, '--fail-on-uncovered'], check: { failOnUncovered: true }, exit: 2, cause: (f) => f.kind === 'uncovered' },
      { args: ['--baseline', pair, '--fail-on', 'warn'], check: { failOn: 'warn' }, exit: 1, cause: (f) => f.kind === 'violation' && f.severity === 'warn' },
      { args: ['--baseline', stale], check: {}, exit: 3, cause: (f) => f.kind === 'error' && CONFIG_RULES.has(f.rule ?? '') },
    ];
    const run = (format: string, args: string[]) => mapxResult(root, 'check', '--view', 'plain', '--format', format, '--report-uncovered', '--report-skipped', ...args);
    const sorted = (xs: string[]) => [...xs].sort();
    for (const c of cases) {
      const label = c.args.join(' ') || '(no options)';
      const j = run('json', c.args);
      expect(j.status, label).toBe(c.exit);
      const json: ArchReport = JSON.parse(j.stdout);
      const failing = json.findings.filter((f) => failsRun(f, c.check));
      expect(failing.some(c.cause), `${label}: the exit cause fails`).toBe(true);
      const fps = sorted(failing.map((f) => f.fingerprint));

      const sarif = JSON.parse(run('sarif', c.args).stdout).runs[0].results as Array<{ level: string; partialFingerprints: Record<string, string> }>;
      expect(sorted(sarif.filter((r) => r.level === 'error').map((r) => r.partialFingerprints['mapx/v1']!)), `${label}: SARIF`).toEqual(fps);

      const where = (f: Finding) => {
        const file = f.location?.file ?? f.source?.file ?? '.mapx/architecture/plain.jsonc';
        const line = f.location ? undefined : f.source?.line;
        return `${ruleOf(f)} ${file}:${line ?? ''}`;
      };
      const gh = run('github', c.args).stdout.split('\n').filter((l) => l.startsWith('::error')).map(parseCommand);
      expect(sorted(gh.map((p) => `${p.props.title} ${p.props.file}:${p.props.line ?? ''}`)), `${label}: GitHub`).toEqual(sorted(failing.map(where)));

      const issues = JSON.parse(run('codeclimate', c.args).stdout) as Array<{ severity: string; fingerprint: string }>;
      expect(sorted(issues.filter((i) => i.severity === 'major').map((i) => i.fingerprint)), `${label}: CodeClimate`).toEqual(sorted(failing.map(codeclimateFingerprint)));

      const junit = parseXml(run('junit', c.args).stdout);
      const failed = all(junit, 'testcase').filter((t) => all(t, 'failure').length || all(t, 'error').length)
        .map((t) => /fingerprint: ([0-9a-f]{16})/.exec([...all(t, 'failure'), ...all(t, 'error')][0]!.text)![1]!);
      expect(sorted(failed), `${label}: JUnit`).toEqual(fps);
    }
  }, 300_000);

  it('a stale entry in a baseline outside the workspace is located at that file, relatively, with its pointer', () => {
    // Review of M5-07 (P2-4): the stale error pointed at the element's file, and named the baseline
    // by its absolute path. Given as ../<name>.json from the workspace.
    const name = `mapx-m507-${Math.random().toString(36).slice(2)}.baseline.json`;
    const file = join(root, '..', name);
    temps.push(file);
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ fingerprint: '0123456789abcdef' }], skip_violations: { 'App\\Domain\\Order': ['App\\Infra\\Repo'] } }));
    const run = (format: string) => mapxResult(root, 'check', '--view', 'plain', '--format', format, '--baseline', join('..', name));
    const json = run('json');
    expect(json.status).toBe(3);
    const stale = (JSON.parse(json.stdout) as ArchReport).findings.filter((f) => f.rule === 'stale-baseline');
    expect(stale).toEqual([expect.objectContaining({ location: { file: `../${name}`, pointer: '/entries/0' }, message: `../${name}#/entries/0: the baseline entry 0123456789abcdef matches no violation; delete it` })]);
    for (const format of ['json', 'table', 'sarif', 'github', 'codeclimate', 'junit']) expect(run(format).stdout, format).not.toContain(root);
    // Outside %SRCROOT% (here the workspace, outside git): every CI format locates it on the view's
    // configuration, line 1 (--baseline names it, no line does); the message names the file (M5-07-R2 review).
    const staleResult = JSON.parse(run('sarif').stdout).runs[0].results.find((r: { ruleId: string }) => r.ruleId === 'stale-baseline');
    const config = staleResult.locations[0].physicalLocation.artifactLocation.uri;
    expect(config).toMatch(/^\.mapx\/architecture.*\.jsonc$/);
    expect(staleResult.locations[0].physicalLocation.region).toEqual({ startLine: 1 });
    expect(staleResult.properties.outsideRoot).toBe(`../${name}`);
    expect(staleResult.message.text).toContain(`../${name}#/entries/0`);
    expect(run('github').stdout.split('\n').filter((l) => l.startsWith('::error')).map((l) => parseCommand(l).props)).toContainEqual({ file: config, line: '1', title: 'stale-baseline' });
    expect((JSON.parse(run('codeclimate').stdout) as Array<{ check_name: string; location: { path: string } }>).find((i) => i.check_name === 'stale-baseline')!.location.path).toBe(config);
  });

  it('a missing configuration still writes a SARIF report with one config error (exit 3)', () => {
    const none = workspace({ 'composer.json': APP['composer.json']!, 'app/App/PlaceOrder.php': APP['app/App/PlaceOrder.php']! });
    temps.push(none);
    init(none);
    mapx(none, 'scan');
    const r = mapxResult(none, 'check', '--format', 'sarif');
    expect(r.status).toBe(3);
    expectValidSarif(r.stdout);
    expect(JSON.parse(r.stdout).runs[0].results.map((x: { ruleId: string }) => x.ruleId)).toEqual(['config']);
  }, 120_000);
});

describe('paths from the repository root when the workspace is a subfolder (M5-07-R1)', () => {
  // GitHub code scanning, PR annotations and GitLab resolve report paths from the checkout root, so
  // a workspace at repo/sub must name its files sub/…. Synthetic PHP app, labelled:
  //   App\Domain\Order → App\Infra\Repo      violation (Domain may use nothing), import + instantiation
  //   App\App\PlaceOrder → App\Support\Clock uncovered (Support is in no layer)
  //   layer Empty                            empty-layer warning, located on the configuration file
  //   ../bl.json (with --baseline)           a stale entry, located on the baseline file
  const layers = [
    { name: 'App', selectors: [{ path: 'app/App/**' }] },
    { name: 'Domain', selectors: [{ path: 'app/Domain/**' }] },
    { name: 'Infra', selectors: [{ path: 'app/Infra/**' }] },
    { name: 'Empty', selectors: [{ path: 'app/Nothing/**' }] },
  ];
  const FILES: Record<string, string> = {
    'composer.json': '{"name":"acme/monorepo-sub","autoload":{"psr-4":{"App\\\\":"app/"}}}\n',
    'app/App/PlaceOrder.php': '<?php\nnamespace App\\App;\n\nuse App\\Support\\Clock;\n\nclass PlaceOrder {\n  public function run() { return new Clock(); }\n}\n',
    'app/Domain/Order.php': '<?php\nnamespace App\\Domain;\n\nuse App\\Infra\\Repo;\n\nclass Order {\n  public function save() { return new Repo(); }\n}\n',
    'app/Infra/Repo.php': '<?php\nnamespace App\\Infra;\n\nclass Repo {}\n',
    'app/Support/Clock.php': '<?php\nnamespace App\\Support;\n\nclass Clock {}\n',
    '.mapx/architecture.jsonc': JSON.stringify({ layers, rules: { App: ['Domain'], Domain: [], Infra: ['Domain'], Empty: [] } }),
  };
  const STALE = JSON.stringify({ version: 1, entries: [{ fingerprint: '0123456789abcdef' }] });
  const under = (dir: string) => Object.fromEntries(Object.entries(FILES).map(([p, c]) => [`${dir}/${p}`, c]));
  let repo = '';
  let top = '';
  beforeAll(() => {
    // A real repository whose top level holds the baseline, with the workspace in sub/; a workspace
    // that is a repository's top level, and one outside git, with the baseline beside them.
    repo = workspace({ ...under('sub'), 'bl.json': STALE }, ['.']);
    top = workspace({ ...under('top'), ...under('plain'), 'bl.json': STALE }, ['top']);
    temps.push(repo, top);
    for (const w of [join(repo, 'sub'), join(top, 'top'), join(top, 'plain')]) { init(w); mapx(w, 'scan'); }
  }, 180_000);

  /**
   * The file of each finding (allowed ones aside) in every format, sorted, and the JSON report's;
   * each format's stdout and stderr.
   */
  function located(root: string, env: Record<string, string> = {}) {
    const stdout: Record<string, string> = {};
    const stderr: Record<string, string> = {};
    const run = (format: string) => {
      const r = mapxResultEnv(root, env, 'check', '--format', format, '--report-uncovered', '--baseline', join('..', 'bl.json'));
      stdout[format] = r.stdout;
      stderr[format] = r.stderr;
      return r.stdout;
    };
    run('table');
    const json: ArchReport = JSON.parse(run('json'));
    const workspacePaths = json.findings.filter((f) => f.kind !== 'allowed').map((f) => f.location?.file ?? f.source?.file ?? '.mapx/architecture.jsonc').sort();
    const sarif = JSON.parse(run('sarif')).runs[0].results.map((r: { locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }) => decodeURIComponent(r.locations[0]!.physicalLocation.artifactLocation.uri));
    const github = run('github').split('\n').filter((l) => l.startsWith('::')).map((l) => parseCommand(l).props.file!);
    const codeclimate = (JSON.parse(run('codeclimate')) as Array<{ location: { path: string } }>).map((i) => i.location.path);
    // A testcase's body starts with `path:line` (after `kind (severity): ` when it passes).
    const junit = all(parseXml(run('junit')), 'testcase').filter((t) => t.attrs.name !== 'no findings')
      .map((t) => t.children.map((c) => c.text).join('').split('\n')[0]!.replace(/^\w+ \(\w+\): /, '').replace(/:\d+$/, ''));
    // What every CI format names: a file outside %SRCROOT% (the workspace here) is located on the configuration (M5-07-R2 review).
    const ciPaths = workspacePaths.map((p) => (p.startsWith('../') ? '.mapx/architecture.jsonc' : p)).sort();
    return { workspacePaths, ciPaths, sarif: sarif.sort(), github: github.sort(), codeclimate: codeclimate.sort(), junit: junit.sort(), stdout, stderr };
  }

  it('a workspace at repo/sub: the SARIF uri, ::error file=, the CodeClimate path and the JUnit locations are sub/…', () => {
    const got = located(join(repo, 'sub'));
    // The labelled locations are all there: source files, the configuration file and the baseline.
    expect(got.workspacePaths).toEqual(expect.arrayContaining(['app/Domain/Order.php', 'app/App/PlaceOrder.php', '.mapx/architecture.jsonc', '../bl.json']));
    // From the repository root: sub/… for the workspace's files, and the baseline at the top level.
    const fromRoot = got.workspacePaths.map((p) => posix.normalize(`sub/${p}`)).sort();
    expect(fromRoot).toEqual(expect.arrayContaining(['sub/app/Domain/Order.php', 'sub/app/App/PlaceOrder.php', 'sub/.mapx/architecture.jsonc', 'bl.json']));
    for (const format of ['sarif', 'github', 'codeclimate', 'junit'] as const) expect(got[format], format).toEqual(fromRoot);
    // SARIF's targetFile property names the target from the root too.
    const sarif = JSON.parse(mapxResult(join(repo, 'sub'), 'check', '--format', 'sarif').stdout);
    expect(sarif.runs[0].results.map((r: { properties: { targetFile?: string } }) => r.properties.targetFile).filter(Boolean)).toContain('sub/app/Infra/Repo.php');
  }, 120_000);

  /** Every `uri` anywhere in a SARIF log. */
  const urisOf = (node: unknown): string[] => !node || typeof node !== 'object' ? []
    : Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => (k === 'uri' && typeof v === 'string' ? [v] : urisOf(v)));

  it('a baseline outside the repository: the SARIF validates, no uri leaves %SRCROOT%, and the stale result is located on the configuration, naming the file (M5-07-R2)', () => {
    // repo/sub, with --baseline ../../<elsewhere>/outside/bl.json: outside the repository.
    const elsewhere = workspace({ 'outside/bl.json': STALE });
    temps.push(elsewhere);
    const baseline = posix.relative(join(repo, 'sub'), join(elsewhere, 'outside', 'bl.json'));
    expect(baseline).toMatch(/^\.\.\/\.\.\/[^/]+\/outside\/bl\.json$/);
    const r = mapxResult(join(repo, 'sub'), 'check', '--format', 'sarif', '--report-uncovered', '--baseline', baseline);
    expect(r.status, r.stderr).toBe(3);
    expectValidSarif(r.stdout);
    const sarif = JSON.parse(r.stdout);
    const uris = urisOf(sarif.runs);
    expect(uris.length).toBeGreaterThan(0);
    expect(uris.filter((u) => decodeURIComponent(u).split('/').includes('..') || /^[a-z]+:|^\//i.test(u)), 'uris leaving %SRCROOT%').toEqual([]);
    // The workspace's own files keep their sub/ locations.
    expect(uris).toEqual(expect.arrayContaining(['sub/app/Domain/Order.php', 'sub/.mapx/architecture.jsonc']));
    // GitHub requires a location in the repository on every result (review of M5-07-R2).
    expect(sarif.runs[0].results.every((x: { locations?: Array<{ physicalLocation?: object }> }) => !!x.locations?.[0]?.physicalLocation)).toBe(true);
    const stale = sarif.runs[0].results.filter((x: { ruleId: string }) => x.ruleId === 'stale-baseline');
    expect(stale).toHaveLength(1);
    // --baseline names it, no line of the configuration does: line 1 of the configuration.
    expect(stale[0].locations[0].physicalLocation).toEqual({ artifactLocation: { uri: 'sub/.mapx/architecture.jsonc', uriBaseId: '%SRCROOT%' }, region: { startLine: 1 } });
    // From the repository root, the file is one folder up: named in a property and in the message, never as a uri.
    const fromRoot = posix.normalize(`sub/${baseline}`);
    expect(fromRoot).toMatch(/^\.\.\/[^/]+\/outside\/bl\.json$/);
    expect(stale[0].properties.outsideRoot).toBe(fromRoot);
    expect(stale[0].message.text).toContain(`${baseline}#/entries/0`);
    expect(stale[0].message.text).toContain('outside the repository');
    expect(r.stdout).not.toContain(elsewhere);
    for (const format of ['github', 'codeclimate', 'junit']) {
      const out = mapxResult(join(repo, 'sub'), 'check', '--format', format, '--report-uncovered', '--baseline', baseline).stdout;
      expect(out, format).not.toContain(elsewhere);
      expect(out, format).toContain(`${baseline}#/entries/0`);
    }
  }, 120_000);

  it('a configuration naming a baseline outside the repository: the stale result is located on that line of the configuration (review of M5-07-R2)', () => {
    const elsewhere = workspace({ 'outside/bl.json': STALE });
    temps.push(elsewhere);
    const named = workspace(under('sub'), ['.']);
    temps.push(named);
    const ws = join(named, 'sub');
    const baseline = posix.relative(ws, join(elsewhere, 'outside', 'bl.json'));
    const config = JSON.stringify({ layers, rules: { App: ['Domain'], Domain: [], Infra: ['Domain'], Empty: [] }, baseline }, null, 2);
    writeFileSync(join(ws, '.mapx', 'architecture.jsonc'), config);
    init(ws);
    mapx(ws, 'scan');
    const r = mapxResult(ws, 'check', '--format', 'sarif');
    expect(r.status, r.stderr).toBe(3);
    expectValidSarif(r.stdout);
    const line = config.split('\n').findIndex((l) => l.includes('"baseline"')) + 1;
    expect(line).toBeGreaterThan(1);
    const stale = JSON.parse(r.stdout).runs[0].results.find((x: { ruleId: string }) => x.ruleId === 'stale-baseline');
    expect(stale.locations[0].physicalLocation).toEqual({ artifactLocation: { uri: 'sub/.mapx/architecture.jsonc', uriBaseId: '%SRCROOT%' }, region: { startLine: line } });
    expect(stale.properties.outsideRoot).toBe(posix.normalize(`sub/${baseline}`));
  }, 120_000);

  it('a workspace in a git submodule: paths are relative to the submodule, the repository its files belong to (M5-07-R2 decision)', () => {
    // lib is a repository with the workspace in sub/; super checks it out as the submodule mods/lib.
    const base = workspace({ ...under('lib/sub'), 'lib/README': 'lib\n' }, ['lib', 'super']);
    temps.push(base);
    const g = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
    expect(g(join(base, 'lib'), 'add', '-A').status).toBe(0);
    expect(g(join(base, 'lib'), 'commit', '-qm', 'lib').status).toBe(0);
    const added = g(join(base, 'super'), 'submodule', 'add', '-q', join(base, 'lib'), 'mods/lib');
    expect(added.status, added.stderr).toBe(0);
    const ws = join(base, 'super', 'mods', 'lib', 'sub');
    init(ws);
    mapx(ws, 'scan');
    const uris = JSON.parse(mapxResult(ws, 'check', '--format', 'sarif').stdout).runs[0].results
      .flatMap((x: { locations?: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }) => (x.locations ?? []).map((l) => l.physicalLocation.artifactLocation.uri));
    // git's view: the submodule's own top level. Code scanning and GitLab place these files in lib, not super.
    expect(uris).toContain('sub/app/Domain/Order.php');
    expect(uris.filter((u: string) => u.startsWith('mods/'))).toEqual([]);
  }, 120_000);

  const WARNING = /^Warning: git could not locate .* in its repository \(git rev-parse --show-prefix failed\), so report paths are relative to the workspace, not the repository root\.$/m;

  it('a workspace at a repository root, or outside git, is unchanged: workspace-relative paths, no warning', () => {
    const atRoot = located(join(top, 'top'));
    const outside = located(join(top, 'plain'));
    for (const got of [atRoot, outside]) {
      expect(got.workspacePaths).toEqual(expect.arrayContaining(['app/Domain/Order.php', '.mapx/architecture.jsonc', '../bl.json']));
      for (const format of ['sarif', 'github', 'codeclimate', 'junit'] as const) expect(got[format], format).toEqual(got.ciPaths);
      for (const [format, err] of Object.entries(got.stderr)) expect(err, format).not.toMatch(WARNING);
    }
    // The same files give the same bytes in every CI format, in a repository or not (json names the
    // repo after its folder).
    for (const format of ['sarif', 'github', 'codeclimate', 'junit']) expect(outside.stdout[format], format).toBe(atRoot.stdout[format]);
  }, 180_000);

  it('a workspace in a checkout git refuses (a bad GIT_DIR): workspace-relative paths, the same stdout, and one warning on stderr', () => {
    // Review of M5-07-R1: a git failure dropped the prefix silently (also git's "dubious ownership"
    // refusal in CI containers). The .git above the workspace says it is in a checkout.
    const refused = located(join(repo, 'sub'), { GIT_DIR: join(repo, 'no-such-git-dir') });
    const atRoot = located(join(top, 'top'));
    for (const format of ['sarif', 'github', 'codeclimate', 'junit'] as const) {
      expect(refused[format], format).toEqual(refused.ciPaths);
      // stdout is the report alone: byte for byte what a workspace at a repository root writes.
      expect(refused.stdout[format], format).toBe(atRoot.stdout[format]);
      expect(refused.stderr[format]!.match(new RegExp(WARNING.source, 'gm')), format).toHaveLength(1);
    }
    // table and json are workspace-relative anyway: no warning.
    for (const format of ['table', 'json']) expect(refused.stderr[format], format).not.toMatch(WARNING);
  }, 180_000);
});
