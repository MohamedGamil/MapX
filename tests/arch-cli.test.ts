import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';

// M5-05: `mapx check` with the built CLI. The test builds src/ with tsup into a temporary layout
// that links the package's node_modules, wasm, queries and VERSION, so the checkout is untouched.
const ROOT = resolve(__dirname, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/arch-rules');
let build = '';
let bin = '';
const temps: string[] = [];

function run(cwd: string, ...args: string[]) {
  // Without GITHUB_ACTIONS: on a GitHub runner it would make the table assertions see annotations (M5-07).
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', MAPX_NO_BANNER: '1', MAPX_NO_TELEMETRY: '1' };
  delete env.GITHUB_ACTIONS;
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mapx-arch-cli-'));
  temps.push(root);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
function scanned(root: string): string {
  expect(run(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover').status).toBe(0);
  expect(run(root, 'scan').status).toBe(0);
  return root;
}

const layers = [
  { name: 'App', selectors: [{ path: 'app/App/**' }] },
  { name: 'Domain', selectors: [{ path: 'app/Domain/**' }] },
];
const view = (rules: Record<string, unknown[]>) => JSON.stringify({ layers, rules });
// A small PHP app: App → Domain (allowed by the main config), App → Support (in no layer).
const APP: Record<string, string> = {
  'composer.json': '{"name":"acme/check","autoload":{"psr-4":{"App\\\\":"app/"}}}\n',
  'app/Domain/Order.php': '<?php\nnamespace App\\Domain;\n\nclass Order {}\n',
  'app/Support/Clock.php': '<?php\nnamespace App\\Support;\n\nclass Clock {}\n',
  'app/App/PlaceOrder.php': '<?php\nnamespace App\\App;\n\nuse App\\Domain\\Order;\nuse App\\Support\\Clock;\n\nclass PlaceOrder {\n  public function run() { new Clock(); return new Order(); }\n}\n',
  '.mapx/architecture.jsonc': view({ App: ['Domain'], Domain: [] }),
  '.mapx/architecture/strict.jsonc': view({ App: [], Domain: [] }),
  '.mapx/architecture/advisory.jsonc': view({ App: [{ allow: ['Domain'], severity: 'warn' }], Domain: [] }),
};
let app = '';

beforeAll(() => {
  build = mkdtempSync(join(tmpdir(), 'mapx-arch-cli-build-'));
  for (const name of ['node_modules', 'wasm', 'queries', 'VERSION', 'package.json', 'schemas']) symlinkSync(join(ROOT, name), join(build, name));
  execFileSync(process.execPath, [join(ROOT, 'node_modules/tsup/dist/cli-default.js'), '--out-dir', join(build, 'dist'), '--no-dts', '--silent'], { cwd: ROOT, stdio: 'ignore' });
  bin = join(build, 'dist/main.js');
  app = scanned(workspace(APP));
}, 300_000);
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  if (build) rmSync(build, { recursive: true, force: true });
});

describe('mapx check: the exit contract (AR-17), with the built CLI', () => {
  it('0: no failing finding (uncovered dependencies are reported only on request)', () => {
    expect(existsSync(bin)).toBe(true);
    const r = run(app, 'check');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Violations: 0 \(0 error, 0 warn\)\s+Uncovered: 2/);
    expect(r.stdout).not.toContain('App\\Support\\Clock'); // hidden without --report-uncovered
    expect(run(app, 'check', '--report-uncovered').stdout).toContain('App\\App\\PlaceOrder → App\\Support\\Clock');
  });

  it('1: an error-level violation; --layer and --rule narrow what fails', () => {
    const r = run(app, 'check', '--view', 'strict');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('✖ disallowed-layer [error]  App\\App\\PlaceOrder → App\\Domain\\Order (instantiation)');
    expect(r.stdout).toMatch(/app\/App\/PlaceOrder\.php:8 /);
    expect(run(app, 'check', '--view', 'strict', '--layer', 'Domain').status).toBe(1); // the target layer counts too
    expect(run(app, 'check', '--view', 'strict', '--rule', 'private-layer').status).toBe(0);
  });

  it('1 with --fail-on warn: an advisory (warn) violation fails only when warnings do', () => {
    expect(run(app, 'check', '--view', 'advisory').status).toBe(0);
    expect(run(app, 'check', '--view', 'advisory').stdout).toContain('✖ disallowed-layer [warn]');
    expect(run(app, 'check', '--view', 'advisory', '--fail-on', 'warn').status).toBe(1);
  });

  it('2: an uncovered dependency with --fail-on-uncovered', () => {
    const r = run(app, 'check', '--fail-on-uncovered');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('? uncovered  App\\App\\PlaceOrder → App\\Support\\Clock');
    // Violations come first: 1 beats 2.
    expect(run(app, 'check', '--view', 'strict', '--fail-on-uncovered').status).toBe(1);
  });

  it('3: an invalid configuration (a "+" cycle), and no configuration at all with a hint', () => {
    const broken = workspace({});
    cpSync(join(FIXTURE, 'php-broken-cycle'), broken, { recursive: true });
    scanned(broken);
    const r = run(broken, 'check');
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('"+" allowances form a cycle: Application → Domain → Application');
    const none = scanned(workspace({ 'a.php': '<?php\nclass A {}\n' }));
    const n = run(none, 'check');
    expect(n.status).toBe(3);
    expect(n.stderr).toContain('`mapx arch init`');
    expect(run(app, 'check', '--format', 'xml').status).toBe(3);
  });

  it('4: no index, or a stale one; --sync brings it up to date first', () => {
    const unscanned = workspace(APP);
    const r = run(unscanned, 'check');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('mapx scan');

    const stale = scanned(workspace(APP));
    appendFileSync(join(stale, 'app/Domain/Order.php'), '\nclass Money {}\n');
    const s = run(stale, 'check');
    expect(s.status).toBe(4);
    expect(s.stderr).toMatch(/index is stale: 1 file\(s\) changed .*app\/Domain\/Order\.php/);
    const synced = run(stale, 'check', '--sync');
    expect(synced.status).toBe(0);
    expect(run(stale, 'check').status).toBe(0); // the sync was real
  });
});

describe('review of M5-05: what must not pass as clean, and usage errors', () => {
  it('4: an index no scan completed (any command creates the database file)', () => {
    const root = workspace(APP);
    expect(run(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover').status).toBe(0);
    run(root, 'status'); // opens, and so creates, .mapx/mapx.db
    expect(existsSync(join(root, '.mapx/mapx.db'))).toBe(true);
    const r = run(root, 'check', '--view', 'strict');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('no completed scan');
  });

  it('4: a new file in a workspace that is not a git repository; --sync then sees its violation', () => {
    const root = scanned(workspace(APP));
    expect(existsSync(join(root, '.git'))).toBe(false);
    writeFileSync(join(root, 'app/Domain/Bad.php'), '<?php\nnamespace App\\Domain;\n\nuse App\\App\\PlaceOrder;\n\nclass Bad { public function run() { return new PlaceOrder(); } }\n');
    const r = run(root, 'check');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('app/Domain/Bad.php (new)');
    const synced = run(root, 'check', '--sync');
    expect(synced.status).toBe(1);
    expect(synced.stdout).toContain('App\\Domain\\Bad → App\\App\\PlaceOrder');
  });

  it('4: a new file in a nested repo of a multi-repo workspace', () => {
    const root = workspace({ ...APP, 'web/src/a.ts': 'export const a = 1;\n' });
    execFileSync('git', ['init', '-q', join(root, 'web')]);
    expect(run(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover').status).toBe(0);
    expect(run(root, 'workspaces', 'add', 'web').status).toBe(0);
    expect(run(root, 'scan').status).toBe(0);
    expect(run(root, 'check').status).toBe(0);
    writeFileSync(join(root, 'web/src/b.ts'), 'export const b = 2;\n');
    const r = run(root, 'check');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('web/src/b.ts (new)');
  });

  it('4 before 3: no index wins over an invalid configuration', () => {
    const broken = workspace({});
    cpSync(join(FIXTURE, 'php-broken-cycle'), broken, { recursive: true });
    expect(run(broken, 'check').status).toBe(4);
  });

  it('3: a --layer or --rule that names nothing, and any usage error', () => {
    const layer = run(app, 'check', '--view', 'strict', '--layer', 'Domian');
    expect(layer.status).toBe(3);
    expect(layer.stderr).toContain('not a layer of this configuration (App, Domain)');
    expect(run(app, 'check', '--view', 'strict', '--rule', 'disallowed_layer').status).toBe(3);
    expect(run(app, 'check', '--fail-on-uncoverd').status).toBe(3); // unknown option
    expect(run(app, 'check', '--layer').status).toBe(3); // missing value
    expect(run(app, 'check', '--help').status).toBe(0);
  });

  it('3: a missing view is named; no configuration still gives a JSON report', () => {
    const v = run(app, 'check', '--view', 'nope');
    expect(v.status).toBe(3);
    expect(v.stderr).toContain('No view "nope"');
    expect(v.stderr).toContain('.mapx/architecture/nope.jsonc does not exist');
    const none = scanned(workspace({ 'a.php': '<?php\nclass A {}\n' }));
    const j = run(none, 'check', '--format', 'json');
    expect(j.status).toBe(3);
    expect(JSON.parse(j.stdout).findings.map((f: any) => [f.kind, f.rule])).toEqual([['error', 'config']]);
  });

  it('--output is relative to the current directory and creates its folder', () => {
    const cwd = workspace({});
    const r = run(cwd, 'check', app, '--format', 'json', '--output', 'reports/arch/out.json');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, 'reports/arch/out.json'), 'utf8')).version).toBe(1);
    expect(existsSync(join(app, 'reports'))).toBe(false);
  });
});

describe('mapx check --format json', () => {
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(join(ROOT, 'schemas/arch-report.schema.json'), 'utf8')));

  it('validates against schemas/arch-report.schema.json and is identical across runs', () => {
    const php = scanned(workspace({}));
    cpSync(join(FIXTURE, 'php'), php, { recursive: true });
    run(php, 'scan');
    const a = run(php, 'check', '--format', 'json', '--report-uncovered', '--report-allowed');
    const b = run(php, 'check', '--format', 'json', '--report-uncovered', '--report-allowed');
    // Exit 3: the fixture's baseline has a stale entry on purpose (php-26), and skips both edges of php-07 (M5-06).
    expect(a.status).toBe(3);
    expect(a.stdout).toBe(b.stdout);
    const report = JSON.parse(a.stdout);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    // M5-11: php-19 and php-20 (@internal, import and instantiation each) are violations, no longer allowed.
    // M5-24-R4 (D039): HttpGateway's dependencies on packages in no layer are out of scope, as the
    // configuration has no package selector.
    // M2-12: each `(new X())->run()` is a call of X::run too, beside its instantiation (php-07's three
    // edges skipped; Clock and Uuid uncovered).
    expect(report.counts).toMatchObject({ violation: 21, skipped: 3, error: 1, uncovered: 6, allowed: 24, warning: 2 });
    expect(report.findings.filter((f: any) => f.kind === 'allowed')).toHaveLength(24);
    // Without --report-*: allowed and uncovered are counted, not listed.
    const plain = JSON.parse(run(php, 'check', '--format', 'json').stdout);
    expect(validate(plain)).toBe(true);
    expect(plain.counts.uncovered).toBe(6);
    expect(plain.findings.some((f: any) => f.kind === 'uncovered' || f.kind === 'allowed')).toBe(false);
  }, 120_000);

  it('--output writes the report to a file, and a configuration error is a valid report too', () => {
    const out = join(workspace({}), 'report.json'); // outside the app: MapX indexes JSON, so a report inside would make it stale
    expect(run(app, 'check', '--view', 'strict', '--format', 'json', '--output', out).stdout).toBe('');
    expect(validate(JSON.parse(readFileSync(out, 'utf8')))).toBe(true);
    const broken = workspace({});
    cpSync(join(FIXTURE, 'php-broken-cycle'), broken, { recursive: true });
    scanned(broken);
    const err = JSON.parse(run(broken, 'check', '--format', 'json').stdout);
    expect(validate(err), JSON.stringify(validate.errors)).toBe(true);
    expect(err.findings.map((f: any) => [f.kind, f.rule, f.layer])).toEqual([['error', 'plus-cycle', 'Application']]);
  });
});

describe('exitCode and the shown report (src/arch/check.ts)', () => {
  const finding = (kind: string, rule: string, severity = 'error', extra: Record<string, unknown> = {}) =>
    ({ kind, rule, severity, fingerprint: '0'.repeat(16), message: rule, ...extra }) as any;
  const report = (...findings: any[]) => ({ version: 1, counts: {} as any, findings, layers: [], layerEdges: [], configErrors: [] }) as any;

  it('3 for configuration errors in a report, whatever else it holds; strictLayers multi-layer errors are 1', async () => {
    const { exitCode } = await import('../src/arch/check.js');
    const violation = finding('violation', 'disallowed-layer', 'error', { source: { element: 'A', file: 'a', layer: 'A' }, target: { element: 'B', file: 'b', layer: 'B' } });
    expect(exitCode(report(violation, finding('error', 'config')), {})).toBe(3);
    expect(exitCode(report(finding('error', 'plus-cycle', 'error', { layer: 'A' })), {})).toBe(3);
    expect(exitCode(report(finding('error', 'multi-layer', 'error', { source: { element: 'X', file: 'x', layer: 'A, B' } })), {})).toBe(1);
    expect(exitCode(report(finding('warning', 'empty-layer', 'warn', { layer: 'R' })), {})).toBe(0);
    expect(exitCode(report(finding('warning', 'empty-layer', 'warn', { layer: 'R' })), { failOn: 'warn' })).toBe(1);
    // A configuration error is never filtered away by --layer or --rule.
    expect(exitCode(report(finding('error', 'config')), { layer: 'Nope', rule: 'nope' })).toBe(3);
  });
});
