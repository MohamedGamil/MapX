import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workspace, init, mapx, query, cleanup } from './helpers/e2e.js';
import { ConfigError, loadArchitectureConfig } from '../src/arch/config.js';
import { runArchitecture, type ArchReport } from '../src/arch/report.js';
import { Store } from '../src/core/store.js';
import { buildElementView } from '../src/arch/elements.js';
import { evaluateEdges, reportElement } from '../src/arch/evaluate.js';
import { computeMembership } from '../src/arch/membership.js';
import { expandPolicy } from '../src/arch/policy.js';
import { internalMarkers } from '../src/arch/visibility.js';
import { isAllowed, openArchitecture } from '../src/arch/introspect.js';
import { loadExpected, scoreApp, type ExpectedRow } from '../scripts/eval/score-arch.js';

// M5-11: visibility (AR-07). `private` selectors (rule private-layer, evaluated since M5-04) and
// internal markers (rule internal-element, AR-08 step 5): doc tags from visibility.internalTags,
// and, opt-in, each language's native module visibility.
const FIXTURE = resolve(__dirname, 'fixtures/arch-rules');
const expected = loadExpected(FIXTURE);
// php-broken-cycle has an invalid configuration: its report is the plus-cycle error alone.
const APPS = Object.keys(expected.apps).filter((a) => a !== 'php-broken-cycle');
const VISIBILITY_RULES = new Set(['private-layer', 'internal-element']);

const roots: Record<string, string> = {};
const scanApp = (app: string) => {
  const root = mkdtempSync(join(tmpdir(), `mapx-arch-vis-${app}-`));
  cpSync(join(FIXTURE, app), root, { recursive: true });
  init(root);
  for (const repo of expected.apps[app]!.repos ?? []) {
    execFileSync('git', ['init', '-q', join(root, repo)]);
    mapx(root, 'workspaces', 'add', repo);
  }
  mapx(root, 'scan');
  return root;
};
beforeAll(() => { for (const app of APPS) roots[app] = scanApp(app); }, 600_000);
afterAll(() => { for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true }); });

/** The app's report with `visibility` set in its configuration (nothing: the fixture's own), and the text edited by `edit`. */
function reportOf(app: string, visibility?: Record<string, unknown>, edit: (text: string) => string = (t) => t): ArchReport {
  const root = roots[app]!;
  const path = join(root, '.mapx/architecture.jsonc');
  const original = readFileSync(path, 'utf8');
  try {
    const text = visibility ? original.replace(/^\{/m, `{\n  "visibility": ${JSON.stringify(visibility)},`) : original;
    writeFileSync(path, edit(text));
    return runArchitecture(root)!;
  } finally {
    writeFileSync(path, original);
  }
}

/** The labelled rows of `app`, with each `native` label applied when native markers are on. */
const rowsOf = (app: string, native = false): ExpectedRow[] =>
  expected.rows.filter((r) => r.app === app).map((r) => (native && r.native ? { ...r, kind: r.native.kind, rule: r.native.rule } : r));

/** A finding per edge type (review of M5-11): kind, rule, both ends and the edge type. */
const dep = (f: ArchReport['findings'][number]) => `${f.kind} ${f.rule} ${f.source?.element} -> ${f.target?.element} (${f.edgeType})`;
const deps = (r: ArchReport, keep: (f: ArchReport['findings'][number]) => boolean = () => true) =>
  [...new Set(r.findings.filter((f) => f.kind !== 'allowed' && keep(f)).map(dep))].sort();
const internalTargets = (r: ArchReport) => [...new Set(r.findings.filter((f) => f.rule === 'internal-element').map((f) => f.target!.element))].sort();
/** The findings between a row's two ends, one `kind rule edgeType` each. */
const between = (r: ArchReport, row: ExpectedRow) => r.findings
  .filter((f) => f.source?.file === row.from!.file && f.target?.file === row.to!.file && f.source?.element?.endsWith(row.from!.symbol!) && f.target?.element?.endsWith(row.to!.symbol!))
  .map((f) => `${f.kind} ${f.rule ?? ''} ${f.edgeType}`.replace(/ +/g, ' ')).sort();

describe('the fixture: private-layer and internal-element rows (AR-07, AR-08)', () => {
  it('every private-layer and internal-element row is found, nothing else of those rules is reported, and no negative row is hit', () => {
    for (const app of APPS) {
      const report = reportOf(app);
      const rows = rowsOf(app);
      const score = scoreApp(app, rows, report);
      expect(score.misses, app).toEqual([]);
      expect(score.negativeHits, app).toEqual([]);
      // Precision 1 for the two rules: each such finding is a labelled row.
      const visibility = scoreApp(app, rows.filter((r) => VISIBILITY_RULES.has(r.rule ?? '')), { findings: report.findings.filter((f) => VISIBILITY_RULES.has(f.rule ?? '')) });
      expect(visibility.misses, app).toEqual([]);
      if (visibility.kinds.violation.reported) expect(visibility.kinds.violation.precision, app).toBe(1);
    }
    // Each tier-1 language has its two internal-element rows.
    const found = APPS.flatMap((app) => rowsOf(app).filter((r) => r.rule === 'internal-element').map((r) => r.id)).sort();
    expect(found).toEqual(['go-19', 'go-20', 'php-19', 'php-20', 'python-19', 'python-20', 'ts-19', 'ts-20']);
  });

  it('an internal element is named in the message, with its marker, and reachable from its own layer', () => {
    const r = reportOf('php');
    const f = r.findings.find((x) => x.rule === 'internal-element' && x.target?.element === 'App\\Domain\\LedgerHelper' && x.edgeType === 'instantiation')!;
    expect(f).toMatchObject({ kind: 'violation', severity: 'error', source: { element: 'App\\Application\\PlaceOrder', layer: 'Application' }, target: { layer: 'Domain' } });
    expect(f.message).toBe('App\\Application\\PlaceOrder must not depend on App\\Domain\\LedgerHelper: it is internal to Domain (@internal) (Application on Domain)');
    // Every edge type is the internal-element dependency, the import of the file included: a TS
    // import names LedgerHelper.ts, whose only top-level symbol is @internal.
    const ts = reportOf('ts');
    for (const id of ['ts-19', 'php-19']) {
      const row = expected.rows.find((x) => x.id === id)!;
      expect(between(id === 'ts-19' ? ts : r, row), id).toEqual(['violation internal-element import', 'violation internal-element instantiation']);
    }
    // php-21: Order (Domain) → LedgerHelper is same-layer.
    expect(r.findings.filter((x) => x.source?.element === 'App\\Domain\\Order' && x.target?.element === 'App\\Domain\\LedgerHelper')).toEqual([]);
  });

  it('`mapx arch allowed` answers as `mapx check` reports: an internal target, stored or hypothetical, is internal-element', () => {
    const root = roots['php']!;
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const ctx = openArchitecture(root, store)!;
      // In the index: PlaceOrder → LedgerHelper (php-19).
      expect(isAllowed(ctx, 'App\\Application\\PlaceOrder', 'App\\Domain\\LedgerHelper')).toMatchObject({ allowed: false, rule: 'internal-element', exitCode: 1 });
      // Not in the index: PlaceOrder → AuditTrail would be one too; PlaceOrder → Order is allowed.
      const hypothetical = isAllowed(ctx, 'App\\Application\\PlaceOrder', 'App\\Domain\\AuditTrail', { edgeType: 'call' });
      expect(hypothetical).toMatchObject({ allowed: false, rule: 'internal-element', exitCode: 1 });
      expect(hypothetical.reason).toMatch(/is internal to Domain/);
      expect(isAllowed(ctx, 'App\\Application\\PlaceOrder', 'App\\Domain\\Order', { edgeType: 'call' })).toMatchObject({ allowed: true });
    } finally {
      store.close();
    }
  });

  it('internal-element comes before private-layer (AR-08): an element both internal and private is reported as internal', () => {
    const r = reportOf('php', undefined, (t) => t.replace('"name": "Domain",', '"name": "Domain", "private": [{ "path": "app/Domain/LedgerHelper.php" }],'));
    const rules = r.findings.filter((f) => f.source?.element === 'App\\Application\\PlaceOrder' && f.target?.element === 'App\\Domain\\LedgerHelper').map((f) => `${f.rule} ${f.edgeType}`);
    expect(rules.sort()).toEqual(['internal-element import', 'internal-element instantiation']);
  });

  it('Go doc comments give doc tags: the fixture\'s `// @internal` types', () => {
    const root = roots['go']!;
    const tags = query<{ name: string; metadata: string }>(root, "SELECT name, metadata FROM symbols WHERE file_path IN ('domain/ledger_helper.go', 'domain/audit_trail.go') AND kind = 'struct'");
    expect(tags.map((t) => [t.name, JSON.parse(t.metadata).docTags]).sort()).toEqual([
      ['AuditTrail', [{ tag: '@internal', value: '' }]],
      ['LedgerHelper', [{ tag: '@internal', value: '' }]],
    ]);
  });
});

describe('native markers (visibility.nativeMarkers)', () => {
  it('are off by default', () => {
    for (const app of APPS) expect(loadArchitectureConfig(roots[app]!)!.visibility, app).toEqual({ internalTags: ['@internal', '@mapx-internal'], nativeMarkers: false });
  });

  it('enabling them adds exactly the findings of the rows labelled "native" (Go and Python), and removes none', () => {
    const added: string[] = [];
    for (const app of APPS) {
      const off = reportOf(app);
      const on = reportOf(app, { nativeMarkers: true });
      const before = deps(off);
      const after = deps(on);
      expect(before.filter((d) => !after.includes(d)), `${app} removed`).toEqual([]);
      const extra = after.filter((d) => !before.includes(d));
      added.push(...extra.map((d) => `${app}: ${d}`));
      const score = scoreApp(app, rowsOf(app, true), on);
      expect(score.misses, app).toEqual([]);
      expect(score.negativeHits, app).toEqual([]);
      expect(score.kinds.violation.precision, app).toBe(1);
    }
    expect(added.sort()).toEqual([
      'go: violation internal-element example.com/shop/application.CloseOrder -> example.com/shop/domain/internal/vault.Vault (call)',
      'go: violation internal-element example.com/shop/application.CloseOrder -> example.com/shop/domain/internal/vault.Vault (instantiation)',
      'python: violation internal-element app.application.close_order.CloseOrder -> app.domain._journal.Journal (call)',
      'python: violation internal-element app.application.close_order.CloseOrder -> app.domain._journal.Journal (import)',
      'python: violation internal-element app.application.close_order.CloseOrder -> app.domain._journal.Journal (instantiation)',
      'python: violation internal-element app.application.close_order.CloseOrder -> app.domain.rounding._round_half_even (call)',
      'python: violation internal-element app.application.close_order.CloseOrder -> app.domain.rounding._round_half_even (import)',
    ]);
    expect(expected.rows.filter((r) => r.native).map((r) => r.id).sort()).toEqual(['go-28', 'python-26', 'python-27']);
  });

  it('M5-11\'s rows hold for every edge type that carries them, with native markers off and on', () => {
    const mine = expected.rows.filter((r) => r.edgeTypes);
    expect(mine.map((r) => r.id).sort()).toEqual(['go-26', 'go-27', 'go-28', 'python-26', 'python-27', 'python-28']);
    for (const app of ['go', 'python']) {
      const off = reportOf(app);
      const on = reportOf(app, { nativeMarkers: true });
      for (const row of mine.filter((r) => r.app === app)) {
        const label = (kind: string, rule?: string) => row.edgeTypes!.map((t) => `${kind} ${rule ?? ''} ${t}`.replace(/ +/g, ' ')).sort();
        expect(between(off, row), `${row.id} off`).toEqual(label(row.kind, row.rule));
        const onTypes = row.native?.edgeTypes ?? row.edgeTypes!;
        expect(between(on, row), `${row.id} on`).toEqual(onTypes.map((t) => `${row.native?.kind ?? row.kind} ${(row.native ? row.native.rule : row.rule) ?? ''} ${t}`.replace(/ +/g, ' ')).sort());
      }
    }
  });

  it('a Go package import: allowed when it reaches an internal type, never left over beside the type\'s finding', () => {
    // CancelOrder imports example.com/shop/domain only for @internal AuditTrail: the import folds into
    // the type's internal-element finding instead of standing as an allowed package dependency.
    const r = reportOf('go');
    expect(r.findings.filter((f) => f.source?.element === 'example.com/shop/application.CancelOrder' && f.target?.element === 'example.com/shop/domain')).toEqual([]);
    expect(r.findings.filter((f) => f.target?.element === 'example.com/shop/domain/internal/vault' || f.target?.element === 'example.com/shop/internal/ledger')).toEqual([]);
  });

  it('the native finding names its marker', () => {
    const goReport = reportOf('go', { nativeMarkers: true });
    const go = goReport.findings.find((f) => f.rule === 'internal-element' && /Vault$/.test(f.target!.element))!;
    // The import of the internal package is internal too (the report then folds it into the Vault
    // finding); the module-root internal/ package stays allowed, since the whole module may import it.
    const store = new Store(join(roots['go']!, '.mapx/mapx.db'));
    try {
      const packageRules = (nativeMarkers: boolean) => {
        const base = loadArchitectureConfig(roots['go']!)!;
        const config = { ...base, visibility: { ...base.visibility, nativeMarkers } };
        const membership = computeMembership(buildElementView(store, roots['go']!), config);
        return evaluateEdges(store, config, membership, expandPolicy(config)).dependencies
          .filter((d) => d.targetPackage).map((d) => `${d.targetPackage!.name} ${d.kind} ${d.rule ?? ''}`.trim())
          .filter((d) => d.includes('/internal/')).sort();
      };
      expect(packageRules(false)).toEqual(['example.com/shop/domain/internal/vault allowed', 'example.com/shop/internal/ledger allowed']);
      expect(packageRules(true)).toEqual(['example.com/shop/domain/internal/vault violation internal-element', 'example.com/shop/internal/ledger allowed']);
    } finally {
      store.close();
    }
    expect(go.message).toBe('example.com/shop/application.CloseOrder must not depend on example.com/shop/domain/internal/vault.Vault: it is internal to Domain (Go internal/) (Application on Domain)');
    const py = reportOf('python', { nativeMarkers: true }).findings.find((f) => f.rule === 'internal-element' && /_round_half_even$/.test(f.target!.element))!;
    expect(py.message).toMatch(/: it is internal to Domain \(Python _name\)/);
  });
});

describe('visibility.internalTags', () => {
  it('another tag list replaces the default: @internal no longer marks anything', () => {
    for (const app of APPS) expect(internalTargets(reportOf(app, { internalTags: ['@mapx-internal'] })), app).toEqual([]);
  });

  it('native markers are not doc tags: TS @internal holds only across packages, PHP has none, Python and Go tags are not native', () => {
    const tagless = { internalTags: ['@mapx-internal'], nativeMarkers: true };
    // The TS app is one package (arch-ts): stripInternal hides nothing inside it. Across packages: the synthetic workspace.
    expect(internalTargets(reportOf('ts', tagless))).toEqual([]);
    expect(internalTargets(reportOf('php', tagless))).toEqual([]);
    expect(internalTargets(reportOf('python', tagless))).toEqual(['app.domain._journal.Journal', 'app.domain.rounding._round_half_even']);
    expect(internalTargets(reportOf('go', tagless))).toEqual(['example.com/shop/domain/internal/vault.Vault']);
  });

  it('a tag the configuration names is compared like the docTag selector: case-insensitive, @ optional', () => {
    expect(internalTargets(reportOf('php', { internalTags: ['INTERNAL'] }))).toEqual(['App\\Domain\\AuditTrail', 'App\\Domain\\LedgerHelper']);
  });

  it('the loader rejects an entry that is not a doc tag', () => {
    const root = roots['php']!;
    const path = join(root, '.mapx/architecture.jsonc');
    const original = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, original.replace(/^\{/m, '{\n  "visibility": { "internalTags": ["@internal", "not a tag", "@"] },'));
      let error: unknown;
      try { loadArchitectureConfig(root); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.map((i) => `${i.pointer}: ${i.message}`)).toEqual([
        '/visibility/internalTags/1: expected a doc tag such as "@internal", got "not a tag"',
        '/visibility/internalTags/2: expected a doc tag such as "@internal", got "@"',
      ]);
    } finally {
      writeFileSync(path, original);
    }
  });
});

// ─── Other languages' native markers, on a synthetic workspace ──────────────────────────────

const NATIVE_FILES: Record<string, string> = {
  '.mapx/architecture.jsonc': JSON.stringify({
    layers: [{ name: 'Core', selectors: [{ path: 'core/**' }] }, { name: 'App', selectors: [{ path: 'app/**' }] }, { name: 'Tests', selectors: [{ path: 'tests/**' }] }],
    rules: { App: ['Core'], Tests: ['Core'] },
  }),
  // Where each language's boundary is: C# projects, Gradle modules, Dart packages, npm packages.
  'core/Core.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'app/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'tests/Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'core/Properties/AssemblyInfo.cs': 'using System.Runtime.CompilerServices;\n\n[assembly: InternalsVisibleTo("Tests")]\n',
  'tests/UseSafe.cs': 'using Acme.Core;\nnamespace Acme.Tests\n{\n    public class UseSafe\n    {\n        public void Run() { new Safe().Open(); }\n    }\n}\n',
  'core/Form1.cs': 'namespace Acme.Core\n{\n    public partial class Form1\n    {\n        public void Show() {}\n    }\n}\n',
  'core/Form1.Designer.cs': 'namespace Acme.Core\n{\n    partial class Form1\n    {\n        private void InitializeComponent() {}\n    }\n}\n',
  'app/UseForm.cs': 'using Acme.Core;\nnamespace Acme.App\n{\n    public class UseForm\n    {\n        public void Run() { new Form1().Show(); }\n    }\n}\n',
  'core/build.gradle.kts': '',
  'app/build.gradle.kts': '',
  'core/pubspec.yaml': 'name: core\n',
  'app/pubspec.yaml': 'name: app\n',
  'core/web/package.json': '{ "name": "core-web" }\n',
  'core/web/index.ts': '/** @internal */\nexport class Hidden {}\n\nexport class Shown {}\n',
  'app/web/package.json': '{ "name": "app-web" }\n',
  'app/web/use.ts': "import { Hidden, Shown } from '../../core/web/index';\n\nexport class UseWeb {\n  run(): void {\n    new Hidden();\n    new Shown();\n  }\n}\n",
  'tests/RegistryTest.java': 'package acme.core;\n\npublic class RegistryTest {\n    public void run() {\n        new Registry().add();\n    }\n}\n',
  'core/Ledger.kt': 'package acme.core\n\ninternal class Ledger {\n    fun post() {}\n}\n\nclass Account {\n    internal fun audit() {}\n    fun open() {}\n    private fun secret() {}\n}\n',
  'app/UseKt.kt': 'package acme.app\n\nimport acme.core.Ledger\nimport acme.core.Account\n\nclass UseKt {\n    fun run() {\n        Ledger().post()\n        Account().open()\n        Account().audit()\n    }\n}\n',
  'core/Vault.cs': [
    'namespace Acme.Core',
    '{',
    '    class Vault { public void Lock() {} }',
    '    internal class Safe { public void Open() {} }',
    '    public class Bank',
    '    {',
    '        internal void Audit() {}',
    '        protected internal void Shared() {}',
    '        private protected void Narrow() {}',
    '        void Hidden() {}',
    '        public void Deposit() {}',
    '        class Nested {}',
    '    }',
    '    public interface IBank { void Pay(); }',
    '}',
    '',
  ].join('\n'),
  'core/Teller.cs': 'namespace Acme.Core.Tellers;\n\nclass Teller {}\n\npublic class Desk {}\n',
  'app/UseCs.cs': 'using Acme.Core;\nnamespace Acme.App\n{\n    public class UseCs\n    {\n        public void Run()\n        {\n            new Vault().Lock();\n            new Safe().Open();\n            new Bank().Deposit();\n        }\n    }\n}\n',
  'core/Registry.java': 'package acme.core;\n\nclass Registry {\n    void add() {}\n}\n',
  'core/Catalog.java': 'package acme.core;\n\npublic class Catalog {\n    void hidden() {}\n    public void list() {}\n    protected int size;\n    int count;\n    private void own() {}\n    Catalog() {}\n    void put(String s) {}\n    public void put(int a) {}\n}\n',
  'core/Shape.java': 'package acme.core;\n\npublic interface Shape {\n    void area();\n    class Unit {}\n}\n',
  'core/Color.java': 'package acme.core;\n\npublic enum Color {\n    RED;\n    void mix() {}\n}\n',
  'app/UseJava.java': 'package acme.app;\n\nimport acme.core.Registry;\nimport acme.core.Catalog;\n\npublic class UseJava {\n    public void run() {\n        new Registry().add();\n        new Catalog().list();\n    }\n}\n',
  'core/store.rs': 'pub(crate) struct Store {}\npub struct Shelf {}\npub(super) fn restock() {}\npub fn sell() {}\npub(in crate::core) fn count() {}\nfn local() {}\nimpl Shelf {\n    pub(crate) fn tidy(&self) {}\n    pub fn show(&self) {}\n}\n',
  'app/use_rs.rs': 'use crate::core::store::{Store, Shelf, restock, sell};\n\npub fn run() {\n    let _s = Store {};\n    restock();\n    sell();\n}\n',
  'core/lib/src/engine.dart': 'class Engine {\n  void start() {}\n}\n',
  'core/lib/wheel.dart': 'class Wheel {\n  void spin() {}\n  void _wobble() {}\n}\nclass _Spoke {}\n',
  'app/use_dart.dart': "import 'package:core/src/engine.dart';\nimport 'package:core/wheel.dart';\n\nclass UseDart {\n  void run() {\n    Engine().start();\n    Wheel().spin();\n  }\n}\n",
  'core/go.mod': 'module example.com/core\n\ngo 1.22\n',
  'core/billing/billing.go': [
    'package billing',
    '',
    '// Invoice is billed monthly.',
    '//',
    '// Deprecated: use Statement',
    '// instead.',
    '//',
    '// @internal reason here',
    '// @owner billing-team',
    'type Invoice struct{}',
    '',
    '// @detached A comment with a blank line below is not documentation.',
    '',
    'type Receipt struct{}',
    '',
    'type (',
    '\t// Line is one invoice line.',
    '\t// @mapx-internal',
    '\tLine struct{}',
    '\tTotal struct{}',
    ')',
    '',
    '// Charge charges. An indented line is code:',
    '//',
    '//\t@notatag',
    '/* @alsotag */',
    'func Charge() {}',
    '',
  ].join('\n'),
  'core/_private/helpers.py': 'def tidy():\n    pass\n',
  'core/models.py': 'class Model:\n    def __init__(self):\n        pass\n\n    def _cache(self):\n        pass\n\n    def __mangled(self):\n        pass\n\n\ndef _helper():\n    pass\n\n\ndef helper():\n    pass\n',
  'core/__main__.py': 'def main():\n    pass\n',
};

describe('native markers per language (Kotlin, C#, Java, Rust, Dart, Python, Go)', () => {
  let root = '';
  beforeAll(() => {
    root = workspace(NATIVE_FILES);
    init(root);
    mapx(root, 'scan');
  }, 300_000);
  afterAll(() => cleanup(root));

  it('Kotlin, C#, Java and Rust store a restricted visibility on the symbol; public ones store none', () => {
    const rows = query<{ file_path: string; name: string; scope: string | null; metadata: string }>(root, "SELECT file_path, name, scope, metadata FROM symbols WHERE metadata LIKE '%\"visibility\"%' ORDER BY file_path, start_line");
    expect(rows.map((r) => `${r.file_path} ${r.scope ? `${r.scope}::` : ''}${r.name} ${JSON.parse(r.metadata).visibility}`)).toEqual([
      'core/Catalog.java Catalog::hidden package',
      'core/Catalog.java Catalog::count package',
      'core/Catalog.java Catalog::Catalog package',
      'core/Catalog.java Catalog::put package',
      'core/Color.java Color::mix package',
      // Each part of a partial type stores what it says; the evaluator merges them (Form1 is public).
      'core/Form1.Designer.cs Form1 internal',
      'core/Ledger.kt Ledger internal',
      'core/Ledger.kt Account::audit internal',
      'core/Registry.java Registry package',
      'core/Registry.java Registry::add package',
      'core/Teller.cs Teller internal',
      'core/Vault.cs Vault internal',
      'core/Vault.cs Safe internal',
      'core/Vault.cs Bank::Audit internal',
      'core/Vault.cs Bank::Narrow internal',
      'core/store.rs Store pub(crate)',
      'core/store.rs restock pub(super)',
      'core/store.rs count pub(in crate::core)',
      'core/store.rs Shelf::tidy pub(crate)',
    ]);
  });

  it('Go doc comments: @tag lines and the Deprecated: paragraph, only from the comment directly above', () => {
    const tags = Object.fromEntries(query<{ name: string; metadata: string }>(root, "SELECT name, metadata FROM symbols WHERE file_path = 'core/billing/billing.go' AND kind != 'namespace'")
      .map((r) => [r.name, JSON.parse(r.metadata ?? '{}').docTags ?? []]));
    expect(tags).toEqual({
      Invoice: [{ tag: '@deprecated', value: 'use Statement instead.' }, { tag: '@internal', value: 'reason here' }, { tag: '@owner', value: 'billing-team' }],
      Receipt: [],
      Line: [{ tag: '@mapx-internal', value: '' }],
      Total: [],
      Charge: [{ tag: '@alsotag', value: '' }],
    });
  });

  it('marks exactly the elements each language makes module-internal', () => {
    const store = new Store(join(root, '.mapx/mapx.db'));
    try {
      const view = buildElementView(store, root);
      const config = loadArchitectureConfig(root)!;
      const name = (el: { kind: string; qualifiedName: string; file: { path: string } }) => (el.kind === 'file' ? el.file.path : el.qualifiedName);
      const marked = (nativeMarkers: boolean) => {
        const { native } = internalMarkers(view, { ...config.visibility, nativeMarkers }, (el) => reportElement(view, el));
        return view.elements.filter((el) => el.file.path.startsWith('core/')).map((el) => [el, native(el)] as const)
          .filter(([, m]) => m).map(([el, m]) => `${name(el)} ${m!.marker}${m!.element !== el ? ` via ${name(m!.element)}` : ''}`).sort();
      };
      expect(marked(false)).toEqual([]);
      // Kotlin names are path-based: the Kotlin parser stores no package (outside this task). Catalog.put
      // is not marked: one of its two overloads (one element) is public. Neither part of the partial
      // Form1 is: one part is public, so the type is (review of M5-11).
      expect(marked(true)).toEqual([
        'Acme.Core.Bank.Audit C# internal',
        'Acme.Core.Bank.Narrow C# internal',
        'Acme.Core.Safe C# internal',
        'Acme.Core.Safe.Open C# internal via Acme.Core.Safe',
        'Acme.Core.Tellers.Teller C# internal',
        'Acme.Core.Vault C# internal',
        'Acme.Core.Vault.Lock C# internal via Acme.Core.Vault',
        'acme.core.Catalog.Catalog Java package-private',
        'acme.core.Catalog.count Java package-private',
        'acme.core.Catalog.hidden Java package-private',
        'acme.core.Color.mix Java package-private',
        'acme.core.Registry Java package-private',
        'acme.core.Registry.add Java package-private',
        'core._private.helpers.tidy Python _module via core/_private/helpers.py',
        'core.models.Model.__mangled Python _name',
        'core.models.Model._cache Python _name',
        'core.models._helper Python _name',
        'core/Ledger.kt#Account.audit Kotlin internal',
        'core/Ledger.kt#Ledger Kotlin internal',
        'core/Ledger.kt#Ledger.post Kotlin internal via core/Ledger.kt#Ledger',
        'core/Registry.java Java package-private via acme.core.Registry',
        'core/_private/helpers.py Python _module',
        'core/lib/src/engine.dart Dart lib/src/',
        'core/lib/src/engine.dart#Engine Dart lib/src/ via core/lib/src/engine.dart',
        'core/lib/src/engine.dart#Engine.start Dart lib/src/ via core/lib/src/engine.dart',
        'core/lib/wheel.dart#Wheel._wobble Dart _name',
        'core/lib/wheel.dart#_Spoke Dart _name',
        'crate::core::store::Shelf::tidy Rust pub(crate)',
        'crate::core::store::Store Rust pub(crate)',
        'crate::core::store::count Rust pub(in crate::core)',
        'crate::core::store::restock Rust pub(super)',
        'core/web/index.ts#Hidden TypeScript @internal',
      ].sort());
    } finally {
      store.close();
    }
  });

  it('with native markers on, App gets an internal-element violation for each Core element its language would refuse it, and none without', () => {
    // Without native markers, only the doc tag: Hidden is @internal.
    const off = runArchitecture(root)!;
    expect(internalTargets(off)).toEqual(['core/web/index.ts#Hidden']);
    const path = join(root, '.mapx/architecture.jsonc');
    const original = readFileSync(path, 'utf8');
    try {
      // Without @internal among the tags, Hidden is internal through TypeScript's native marker.
      writeFileSync(path, JSON.stringify({ ...JSON.parse(original), visibility: { nativeMarkers: true, internalTags: ['@mapx-internal'] } }));
      const on = runArchitecture(root)!;
      // App is another C# project, Gradle module, Dart and npm package than Core, and another Java
      // package. Rust: one crate, so pub(crate) Store is legal, pub(super) restock is not.
      expect(internalTargets(on)).toEqual([
        'Acme.Core.Safe',
        'Acme.Core.Vault',
        'acme.core.Registry',
        'core/Ledger.kt#Account',
        'core/Ledger.kt#Ledger',
        'core/lib/src/engine.dart#Engine',
        'core/web/index.ts#Hidden',
        'crate::core::store::restock',
      ]);
      expect(on.findings.filter((f) => f.rule === 'internal-element').every((f) => f.source!.layer === 'App')).toBe(true);
      expect(on.findings.find((f) => f.target?.element === 'core/web/index.ts#Hidden' && f.rule === 'internal-element')!.message).toMatch(/\(TypeScript @internal\)/);
      // Public elements stay allowed: Bank.Deposit, Catalog.list, Wheel.spin, sell, Shown, Store (pub(crate)),
      // and the partial Form1. Tests may use Safe (InternalsVisibleTo("Tests")) and, in package acme.core,
      // Registry.
      for (const [s, t] of [['', 'Acme.Core.Bank'], ['', 'acme.core.Catalog'], ['', 'core/lib/wheel.dart#Wheel'], ['', 'crate::core::store::sell'], ['', 'core/web/index.ts#Shown'],
        ['', 'crate::core::store::Store'], ['', 'Acme.Core.Form1'], ['Acme.Tests.UseSafe', 'Acme.Core.Safe'], ['acme.core.RegistryTest', 'acme.core.Registry']]) {
        expect(on.findings.some((f) => f.kind === 'allowed' && f.target?.element === t && (!s || f.source?.element === s)), `${s} -> ${t}`).toBe(true);
      }
      // Account is allowed for open() and internal for audit(): the finding says which member.
      const account = on.findings.find((f) => f.rule === 'internal-element' && f.target?.element === 'core/Ledger.kt#Account')!;
      expect(account.message).toBe('app/UseKt.kt#UseKt must not depend on core/Ledger.kt#Account: core/Ledger.kt#Account.audit is internal to Core (Kotlin internal) (App on Core)');
      expect(on.findings.some((f) => f.kind === 'allowed' && f.target?.element === 'core/Ledger.kt#Account')).toBe(true);
    } finally {
      writeFileSync(path, original);
    }
  });
});

// ─── What each language allows, and trailing comments (review of M5-11) ───────────────────────

const LEGAL_FILES: Record<string, string> = {
  '.mapx/architecture.jsonc': JSON.stringify({
    visibility: { nativeMarkers: true },
    layers: [
      { name: 'Http', selectors: [{ path: 'internal/http/**' }] }, { name: 'Domain', selectors: [{ path: 'internal/domain/**' }] },
      { name: 'PyApp', selectors: [{ path: 'app/application/**' }] },
      { name: 'PyDomain', selectors: [{ all: [{ path: 'app/domain/**' }, { not: { path: 'app/domain/audit.py' } }] }] },
      { name: 'PyAudit', selectors: [{ path: 'app/domain/audit.py' }] },
      { name: 'Main', selectors: [{ path: 'java/src/main/**' }] }, { name: 'Tests', selectors: [{ path: 'java/src/test/**' }] },
      { name: 'KtMain', selectors: [{ path: 'kt/src/main/**' }] }, { name: 'KtTests', selectors: [{ path: 'kt/src/test/**' }] },
    ],
    rules: { Http: ['Domain'], PyApp: ['PyDomain'], PyAudit: ['PyDomain'], Tests: ['Main'], KtTests: ['KtMain'] },
  }),
  // Go: internal/http may import internal/domain, both rooted at internal's parent (the module root).
  'go.mod': 'module example.com/svc\n\ngo 1.22\n',
  'internal/domain/order.go': 'package domain\n\ntype Order struct{}\n\nfunc (o Order) Total() int { return 1 }\n',
  'internal/domain/money.go': [
    'package domain',
    '',
    'type Legacy struct{} // @internal kept for the v1 adapter',
    'type Money struct{}',
    '',
    'const (',
    '\tOldRate = 1 // Deprecated: use Rate.',
    '\tRate    = 2',
    ')',
    '',
  ].join('\n'),
  'internal/http/handler.go': 'package http\n\nimport "example.com/svc/internal/domain"\n\ntype Handler struct{}\n\nfunc (h Handler) Serve() int {\n\treturn domain.Order{}.Total()\n}\n',
  // Python: Journal is public through the package's re-export; only a direct import of _journal is internal.
  'app/__init__.py': '',
  'app/application/__init__.py': '',
  'app/application/use.py': 'from app.domain import Journal\n\n\nclass Use:\n    def run(self) -> None:\n        Journal().record()\n',
  'app/application/direct.py': 'from app.domain._journal import Journal\n\n\nclass Direct:\n    def run(self) -> None:\n        Journal().record()\n',
  'app/domain/__init__.py': 'from ._journal import Journal\n\n__all__ = ["Journal"]\n',
  'app/domain/_journal.py': 'class Journal:\n    def record(self) -> None:\n        pass\n',
  // In the package that holds _journal, another layer may import it directly.
  'app/domain/audit.py': 'from app.domain._journal import Journal\n\n\nclass Audit:\n    def run(self) -> None:\n        Journal().record()\n',
  // Java: a test in the same package, in another source root (the JUnit layout).
  'java/src/main/java/com/acme/Ledger.java': 'package com.acme;\n\npublic class Ledger {\n    int count; /** @internal */\n    void post() {}\n    public void open() {}\n}\n',
  'java/src/test/java/com/acme/LedgerTest.java': 'package com.acme;\n\npublic class LedgerTest {\n    public void testPost() {\n        Ledger l = new Ledger();\n        l.post();\n        l.open();\n    }\n}\n',
  // Kotlin: internal is module-wide, and a module's tests are in the module.
  'kt/build.gradle.kts': '',
  'kt/src/main/kotlin/KtLedger.kt': 'package acme\n\ninternal class KtLedger {\n    fun post() {}\n}\n',
  'kt/src/test/kotlin/KtLedgerTest.kt': 'package acme\n\nclass KtLedgerTest {\n    fun run() {\n        KtLedger().post()\n    }\n}\n',
  // TS: a trailing JSDoc documents nothing below it.
  'ts/a.ts': 'export const x = 1; /** @internal */\nexport class Later {}\n',
};

describe('native markers follow each language\'s own rule; trailing comments are not docs', () => {
  let root = '';
  let report: ArchReport;
  beforeAll(() => {
    root = workspace(LEGAL_FILES);
    init(root);
    mapx(root, 'scan');
    report = runArchitecture(root)!;
  }, 300_000);
  afterAll(() => cleanup(root));

  it('code the language accepts is not flagged: Go internal/ under its parent, a Python re-export or same-package import, a Java same-package test, a Kotlin same-module test', () => {
    expect(deps(report, (f) => f.rule === 'internal-element')).toEqual([
      'violation internal-element app.application.direct.Direct -> app.domain._journal.Journal (call)',
      'violation internal-element app.application.direct.Direct -> app.domain._journal.Journal (import)',
      'violation internal-element app.application.direct.Direct -> app.domain._journal.Journal (instantiation)',
    ]);
    // The legal references are there, as allowed dependencies.
    const allowed = (s: string, t: RegExp) => report.findings.some((f) => f.kind === 'allowed' && f.source?.element === s && t.test(f.target?.element ?? ''));
    expect(allowed('example.com/svc/internal/http.Handler', /internal\/domain\.Order$/)).toBe(true);
    expect(allowed('app.application.use.Use', /Journal$/)).toBe(true);
    expect(allowed('app.domain.audit.Audit', /_journal\.Journal$/)).toBe(true);
    expect(allowed('com.acme.LedgerTest', /^com\.acme\.Ledger$/)).toBe(true);
    expect(allowed('kt/src/test/kotlin/KtLedgerTest.kt#KtLedgerTest', /KtLedger$/)).toBe(true);
  });

  it('a trailing comment is not the next declaration\'s doc (Go, Java, TS)', () => {
    const tags = query<{ name: string; metadata: string | null }>(root, "SELECT name, metadata FROM symbols WHERE name IN ('Legacy', 'Money', 'OldRate', 'Rate', 'post', 'Later') AND file_path NOT LIKE 'kt/%'")
      .map((r) => `${r.name} ${JSON.stringify(JSON.parse(r.metadata ?? '{}').docTags ?? [])}`).sort();
    expect(tags).toEqual(['Later []', 'Legacy []', 'Money []', 'OldRate []', 'Rate []', 'post []']);
  });
});
