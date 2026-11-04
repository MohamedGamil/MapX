import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Ajv from 'ajv';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { init, mapx, mapxResult } from './helpers/e2e.js';
import type { Selector } from '../src/arch/schema.js';
import { declaredBases, hierarchyMatch, hierarchyOf, shownPath, VIA_LIMIT } from '../src/arch/selectors/hierarchy.js';
import type { Element, ElementView, FileInfo, InheritanceRecords } from '../src/arch/elements.js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { validateArchitectureText } from '../src/arch/config.js';

// M5-09: hierarchy and member selectors (AR-04) and inherited dependencies (AR-02), end to end on
// the synthetic fixture tests/fixtures/arch-hierarchy. Each app is copied, initialised and scanned
// with the source CLI, then asked through `mapx arch` and `mapx check`.
const FIXTURE = resolve(__dirname, 'fixtures/arch-hierarchy');
const APPS = ['php', 'ts', 'python', 'java'] as const;
// `mixed` (review of M5-09): same-named local classes, parser edge cases, a duplicate import.
// `annotated` (review of M5-17-R1): annotations and attributes above a declaration, a wrapped base
// list, Python import aliases.
const SETUP = [...APPS, 'mixed', 'annotated'] as const;
type App = typeof SETUP[number];
const CLI = { timeout: 300_000 };
const roots = {} as Record<App, string>;

beforeAll(() => {
  for (const app of SETUP) {
    const root = mkdtempSync(join(tmpdir(), `mapx-arch-hierarchy-${app}-`));
    cpSync(join(FIXTURE, app), root, { recursive: true });
    init(root);
    mapx(root, 'scan');
    mkdirSync(join(root, '.mapx/architecture'), { recursive: true });
    roots[app] = root;
  }
}, 600_000);

afterAll(() => {
  for (const root of Object.values(roots)) if (root) rmSync(root, { recursive: true, force: true });
});

let views = 0;
/** A view of one overlay layer `L` selected by `selector`; returns its name. */
function viewOf(app: App, selectors: Selector[], doc: Record<string, unknown> = {}): string {
  const name = `h${++views}`;
  writeFileSync(join(roots[app], '.mapx/architecture', `${name}.jsonc`), JSON.stringify({ layers: [{ name: 'L', selectors }], rules: {}, ...doc }));
  return name;
}

/** The symbols layer `L` of a view selecting `selector` holds, by qualified name, with their trace. */
function members(app: App, selector: Selector): Array<{ element: string; selector: string; chain?: string[] }> {
  const r = mapxResult(roots[app], 'arch', 'layers', 'L', '--why', '--view', viewOf(app, [selector]), '--format', 'json');
  expect(r.status, r.stderr + r.stdout).toBe(0);
  return (JSON.parse(r.stdout).members as Array<{ element: string; kind: string; selector: string; chain?: string[] }>)
    .filter((m) => m.kind === 'symbol')
    .map(({ element, selector: s, chain }) => ({ element, selector: s, ...(chain ? { chain } : {}) }));
}
const names = (app: App, selector: Selector) => members(app, selector).map((m) => m.element).sort();

describe('transitive extends of a framework base class through an intermediate base (AR-04)', CLI, () => {
  it('PHP: extends Eloquent\\Model matches BaseModel, and Order and LineItem through it, with the chain', () => {
    const m = members('php', { extends: 'Eloquent\\Model' });
    expect(m.map((x) => x.element).sort()).toEqual(['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel']);
    expect(m.find((x) => x.element === 'App\\Domain\\LineItem')).toEqual({
      element: 'App\\Domain\\LineItem', selector: 'selectors[0].extends',
      chain: ['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel', 'Illuminate\\Database\\Eloquent\\Model'],
    });
    // The fully qualified name and a regex select the same classes.
    expect(names('php', { extends: 'Illuminate\\Database\\Eloquent\\Model' })).toEqual(['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel']);
    expect(names('php', { extends: '/Eloquent\\\\Model$/' })).toEqual(['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel']);
  });

  it('TS: an abstract base over sequelize\'s Model', () => {
    const m = members('ts', { extends: 'sequelize#Model' });
    expect(m.map((x) => x.element).sort()).toEqual(['src/domain/Order.ts#Order', 'src/support/BaseModel.ts#BaseModel']);
    expect(m.find((x) => x.element === 'src/domain/Order.ts#Order')!.chain).toEqual(['src/domain/Order.ts#Order', 'src/support/BaseModel.ts#BaseModel', 'sequelize#Model']);
  });

  it('Python: a base over django.db.models.Model, named through `from django.db import models`', () => {
    const m = members('python', { extends: 'django.db.models.Model' });
    expect(m.map((x) => x.element).sort()).toEqual(['app.domain.order.Order', 'app.support.base_model.BaseModel']);
    expect(m.find((x) => x.element === 'app.domain.order.Order')!.chain).toEqual(['app.domain.order.Order', 'app.support.base_model.BaseModel', 'django.db.models.Model']);
  });

  it('Java: a base over Spring Data\'s AbstractPersistable<Long>, named through its import', () => {
    const m = members('java', { extends: 'org.springframework.data.jpa.domain.AbstractPersistable' });
    expect(m.map((x) => x.element).sort()).toEqual(['com.acme.domain.Order', 'com.acme.support.BaseEntity']);
    expect(m.find((x) => x.element === 'com.acme.domain.Order')!.chain).toEqual(['com.acme.domain.Order', 'com.acme.support.BaseEntity', 'org.springframework.data.jpa.domain.AbstractPersistable']);
    expect(names('java', { extends: 'AbstractPersistable' })).toEqual(['com.acme.domain.Order', 'com.acme.support.BaseEntity']);
  });
});

describe('implements, inherits, mixes, inheritanceDepth and member (AR-04)', CLI, () => {
  it('implements: through an interface that extends it, and through a superclass; extends stays on the interface chain', () => {
    for (const app of ['php', 'ts', 'java'] as const) {
      const order = { php: 'App\\Domain\\Order', ts: 'src/domain/Order.ts#Order', java: 'com.acme.domain.Order' }[app];
      const billable = { php: 'App\\Domain\\Billable', ts: 'src/domain/Billable.ts#Billable', java: 'com.acme.domain.Billable' }[app];
      const implementers = names(app, { implements: 'Payable' });
      expect(implementers, app).toContain(order);
      expect(implementers, app).not.toContain(billable);
      expect(names(app, { extends: 'Payable' }), app).toEqual([billable]);
      expect(names(app, { inherits: 'Payable' }), app).toEqual([...implementers, billable].sort());
    }
    // PHP's external interface, named through the M5-19 candidate: BaseModel and its subclasses.
    expect(names('php', { implements: 'JsonSerializable' })).toEqual(['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel']);
  });

  it('mixes: a PHP trait used by a base class is mixed into its subclasses', () => {
    const m = members('php', { mixes: 'HasUuid' });
    expect(m.map((x) => x.element).sort()).toEqual(['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel']);
    expect(m.find((x) => x.element === 'App\\Domain\\Order')!.chain).toEqual(['App\\Domain\\Order', 'App\\Support\\BaseModel', 'App\\Support\\HasUuid']);
    expect(names('php', { extends: 'HasUuid' })).toEqual([]);
  });

  it('inheritanceDepth: the longest chain, an external base counting as one level', () => {
    expect(names('php', { inheritanceDepth: 3 })).toEqual(['App\\Domain\\LineItem']);
    expect(names('php', { all: [{ inheritanceDepth: 2 }, { path: 'app/Domain/**' }] })).toEqual(['App\\Domain\\LineItem', 'App\\Domain\\Order']);
    expect(names('python', { inheritanceDepth: 2 })).toEqual(['app.domain.order.Order']);
  });

  it('an inheritance cycle terminates: a type is not its own ancestor', () => {
    expect(names('php', { extends: 'LoopA' })).toEqual(['App\\Legacy\\LoopB']);
    expect(names('php', { all: [{ inheritanceDepth: 1 }, { path: 'app/Legacy/**' }] })).toEqual(['App\\Legacy\\LoopA', 'App\\Legacy\\LoopB']);
    expect(names('php', { all: [{ inheritanceDepth: 2 }, { path: 'app/Legacy/**' }] })).toEqual([]);
  });

  it('member: a type with an own method or field matching the regex; inherited members do not count', () => {
    expect(names('php', { member: '^pay$' })).toEqual(['App\\Domain\\Order']);
    expect(names('php', { member: '^total$' })).toEqual(['App\\Domain\\Order']);
    expect(names('ts', { member: '^pay$' })).toEqual(['src/domain/Order.ts#Order']);
    expect(names('python', { member: '^notify$' })).toEqual(['app.support.base_model.BaseModel']);
    expect(names('java', { member: '^(pay|run)$' })).toEqual(['com.acme.domain.Order', 'com.acme.domain.Plain']);
  });

  it('hierarchy selectors are symbol-level: `not` of one puts no file in a layer', () => {
    const r = mapxResult(roots.php, 'arch', 'layers', 'L', '--view', viewOf('php', [{ not: { extends: 'Eloquent\\Model' } }]), '--format', 'json');
    const m = JSON.parse(r.stdout).members as Array<{ element: string; kind: string }>;
    // Files join only through a top-level symbol: Plain's file, never BaseModel's.
    expect(m.map((x) => x.element)).toContain('app/Domain/Plain.php');
    expect(m.map((x) => x.element)).not.toContain('app/Support/BaseModel.php');
    expect(m.map((x) => x.element)).not.toContain('App\\Support\\BaseModel');
  });

  it('`mapx arch which` explains a hierarchy match with its chain', () => {
    const out = mapx(roots.php, 'arch', 'which', 'App\\Domain\\Order', '--view', viewOf('php', [{ extends: 'Eloquent\\Model' }]));
    expect(out).toContain('L  ← selectors[0].extends: App\\Domain\\Order → App\\Support\\BaseModel → Illuminate\\Database\\Eloquent\\Model');
  });
});

describe('policy.inheritDependencies (AR-02)', CLI, () => {
  type Finding = { kind: string; rule?: string; source?: { element: string; layer?: string }; target?: { element: string }; edgeType?: string; via?: string[]; message: string };
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(resolve(__dirname, '../schemas/arch-report.schema.json'), 'utf8')));
  const check = (app: App, ...args: string[]) => {
    const r = mapxResult(roots[app], 'check', '--format', 'json', '--report-allowed', ...args);
    const report = JSON.parse(r.stdout);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    return { status: r.status, findings: (report.findings as Finding[]) };
  };
  const cases: Record<typeof APPS[number], { order: string; base: string; mailer: string }> = {
    php: { order: 'App\\Domain\\Order', base: 'App\\Support\\BaseModel', mailer: 'App\\Http\\Mailer' },
    ts: { order: 'src/domain/Order.ts#Order', base: 'src/support/BaseModel.ts#BaseModel', mailer: 'src/http/Mailer.ts#Mailer' },
    python: { order: 'app.domain.order.Order', base: 'app.support.base_model.BaseModel', mailer: 'app.http.mailer.Mailer' },
    java: { order: 'com.acme.domain.Order', base: 'com.acme.support.BaseEntity', mailer: 'com.acme.http.Mailer' },
  };

  it('on: a Domain subclass violates through its Support base\'s Http dependency, `via` naming the inheritance path', () => {
    for (const app of APPS) {
      const { order, base, mailer } = cases[app];
      const { status, findings } = check(app);
      expect(status, app).toBe(1);
      const inherited = findings.filter((f) => f.kind === 'violation' && f.source?.element === order && f.target?.element === mailer);
      expect(inherited.length, app).toBeGreaterThan(0);
      for (const f of inherited) {
        expect(f.via, app).toEqual([order, base]);
        expect(f.source!.layer, app).toBe('Domain');
        expect(f.message, app).toContain(`inherited via ${order} → ${base}`);
      }
      // The base's own dependency is allowed (Support on Http) and carries no `via`.
      const own = findings.filter((f) => f.source?.element === base && f.target?.element === mailer);
      expect(own.length, app).toBeGreaterThan(0);
      expect(own.every((f) => f.kind === 'allowed' && f.via === undefined), app).toBe(true);
      // A dependency the subclass has itself is not derived again: Order's own edge to its base has no `via`.
      expect(findings.filter((f) => f.source?.element === order && f.target?.element === base).every((f) => f.via === undefined), app).toBe(true);
    }
    // Two levels: LineItem extends Order extends BaseModel.
    const { findings } = check('php');
    const deep = findings.filter((f) => f.kind === 'violation' && f.source?.element === 'App\\Domain\\LineItem' && f.target?.element === 'App\\Http\\Mailer');
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.every((f) => JSON.stringify(f.via) === JSON.stringify(['App\\Domain\\LineItem', 'App\\Domain\\Order', 'App\\Support\\BaseModel']))).toBe(true);
  });

  it('off (the default): the subclass has no such dependency, and no finding has `via`', () => {
    for (const app of APPS) {
      const off = viewOf(app, [], {
        layers: [
          { name: 'Domain', selectors: [{ path: { php: 'app/Domain/**', ts: 'src/domain/**', python: 'app/domain/**', java: 'src/main/java/com/acme/domain/**' }[app] }] },
          { name: 'Support', selectors: [{ path: { php: 'app/Support/**', ts: 'src/support/**', python: 'app/support/**', java: 'src/main/java/com/acme/support/**' }[app] }] },
          { name: 'Http', selectors: [{ path: { php: 'app/Http/**', ts: 'src/http/**', python: 'app/http/**', java: 'src/main/java/com/acme/http/**' }[app] }] },
        ],
        rules: { Domain: ['Support'], Support: ['Http'], Http: [] },
      });
      const { status, findings } = check(app, '--view', off);
      expect(findings.filter((f) => f.via), app).toEqual([]);
      expect(findings.filter((f) => f.source?.element === cases[app].order && f.target?.element === cases[app].mailer), app).toEqual([]);
      expect(status, app).toBe(0);
    }
  });
});

describe('MCP keeps in step with the CLI (M5-14 tools)', CLI, () => {
  let client: Client;
  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
  });
  afterAll(async () => { await client?.close(); });
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text);

  it('mapx_arch_explain and mapx_arch_layers carry the chain; mapx_arch_check carries `via`', async () => {
    const view = viewOf('php', [{ extends: 'Eloquent\\Model' }]);
    const chain = ['App\\Domain\\Order', 'App\\Support\\BaseModel', 'Illuminate\\Database\\Eloquent\\Model'];
    const explained = await call('mapx_arch_explain', { dir: roots.php, view, element: 'App\\Domain\\Order', layer: 'L' });
    expect(explained.element.matches[0].trace).toEqual([{ layer: 'L', selector: 'selectors[0].extends', via: 'self', chain }]);
    expect(explained.layer.matches).toEqual([{ element: 'App\\Domain\\Order', inLayer: true, selector: 'selectors[0].extends', via: 'self', chain }]);
    const layer = await call('mapx_arch_layers', { dir: roots.php, view, layer: 'L', why: true });
    expect(layer.members.find((m: { element: string }) => m.element === 'App\\Domain\\Order').chain).toEqual(chain);
    const report = await call('mapx_arch_check', { dir: roots.php, limit: 0 });
    const inherited = report.findings.filter((f: { source?: { element: string }; target?: { element: string } }) => f.source?.element === 'App\\Domain\\Order' && f.target?.element === 'App\\Http\\Mailer');
    expect(inherited.length).toBeGreaterThan(0);
    expect(inherited.every((f: { via?: string[] }) => JSON.stringify(f.via) === JSON.stringify(['App\\Domain\\Order', 'App\\Support\\BaseModel']))).toBe(true);
  });
});

describe('declared base lists, as the index stores signatures (unit)', () => {
  // The signatures are what a scan stores for these declarations (probe of M5-09).
  it.each([
    ['php', 'class', 'class BaseModel extends Model implements \\JsonSerializable, Countable', [['Model', 'extends'], ['JsonSerializable', 'implements'], ['Countable', 'implements']]],
    ['php', 'interface', 'interface Billable extends Payable, Countable', [['Payable', 'extends'], ['Countable', 'extends']]],
    ['typescript', 'class', 'export abstract class BaseModel<T> extends Model<T> implements A, B<string>', [['Model', 'extends'], ['A', 'implements'], ['B', 'implements']]],
    ['typescript', 'class', 'export class A extends Mixin(Base)', []],
    ['java', 'class', 'abstract class BaseEntity extends AbstractPersistable<Long> implements Serializable', [['AbstractPersistable', 'extends'], ['Serializable', 'implements']]],
    ['python', 'class', 'class BaseModel(models.Model, Generic[T], metaclass=ABCMeta):', [['models.Model', 'extends'], ['Generic', 'extends']]],
    ['kotlin', 'class', 'class Order(val id: Long) : BaseEntity(id), Payable, Comparable<Order>', [['BaseEntity', 'extends'], ['Payable', 'implements'], ['Comparable', 'implements']]],
    ['c-sharp', 'class', 'class Order : BaseEntity<long>, IPayable where T : class', [['BaseEntity', 'extends'], ['IPayable', 'implements']]],
    ['c-sharp', 'class', 'class Order : IPayable', [['IPayable', 'implements']]],
    ['scala', 'class', 'class Order(id: Long) extends BaseEntity(id) with Payable with Logging', [['BaseEntity', 'extends'], ['Payable', 'mixin'], ['Logging', 'mixin']]],
    ['dart', 'class', 'class Order extends BaseEntity with Logging implements Payable', [['BaseEntity', 'extends'], ['Logging', 'mixin'], ['Payable', 'implements']]],
    ['ruby', 'class', 'class Order < ApplicationRecord', [['ApplicationRecord', 'extends']]],
    ['swift', 'class', 'class Order: BaseEntity, Payable', [['BaseEntity', 'extends'], ['Payable', 'implements']]],
    ['go', 'struct', 'type Order struct', []],
  ])('%s %s: %s', (language, kind, signature, want) => {
    expect(declaredBases(signature, language, kind).map((b) => [b.written, b.kind])).toEqual(want);
  });
});

describe('the header is read past annotation lines, across a wrapped base list, through Python aliases (review of M5-17-R1)', CLI, () => {
  it.each([
    ['Java: @Transactional above a Spring Data repository', { extends: 'org.springframework.data.jpa.repository.JpaRepository' }, ['com.acme.OrderRepository']],
    ['Java: a multi-line annotation and a doc comment naming the class, over a wrapped `extends`', { extends: 'org.springframework.data.jpa.domain.AbstractPersistable' }, ['com.acme.Order']],
    ['Java: the wrapped `implements` line', { implements: 'java.io.Serializable' }, ['com.acme.Order']],
    ['C#: [Authorize] and [Route] above a controller', { extends: 'ControllerBase' }, ['Shop.Admin.AuditController']],
    ['Kotlin: @Service above a class', { extends: 'BaseService' }, ['kt/Billing.kt#Billing']],
    ['Kotlin: an annotation above a data class', { implements: 'Persistable' }, ['kt/Billing.kt#Invoice']],
    ['PHP: #[Route] above a controller', { extends: 'Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController' }, ['App\\Admin\\AdminController']],
    ['PHP: a multi-line #[ORM\\Entity(...)] above an entity', { extends: 'Doctrine\\Common\\Model' }, ['App\\Admin\\Product']],
    ['Python: `import Model as DM`, `import models as m`, and a decorated class', { extends: 'django.db.models.Model' }, ['py.billing.Credit', 'py.billing.Invoice', 'py.billing.Refund']],
  ] as Array<[string, Selector, string[]]>)('%s', (_, selector, want) => {
    expect(names('annotated', selector)).toEqual(want);
  });
});

describe('configuration: ancestor values written as regexes are checked (M5-09)', () => {
  it('a /regex/ that does not compile is a configuration issue; a plain name is not a regex', () => {
    const issues = validateArchitectureText(JSON.stringify({ layers: [{ name: 'L', selectors: [{ extends: '/Model(/' }, { implements: 'Foo(' }] }], rules: {} }));
    expect(issues.map((i) => i.pointer)).toEqual(['/layers/0/selectors/0/extends']);
  });
});

// ─── Review of M5-09 ─────────────────────────────────────────────────────────────────────────

describe('review P1-1: a base outside the workspace named like a local class', CLI, () => {
  it('the import names the base: sequelize, Django and Spring Data, not the same-named local class', () => {
    expect(members('mixed', { extends: 'sequelize#Model' })).toEqual([{ element: 'ts/src/User.ts#User', selector: 'selectors[0].extends', chain: ['ts/src/User.ts#User', 'sequelize#Model'] }]);
    expect(names('mixed', { extends: 'django.db.models.Model' })).toEqual(['py.app.post.Post', 'py.app.user.User']);
    expect(members('mixed', { extends: 'org.springframework.data.jpa.domain.AbstractPersistable' })).toEqual([
      { element: 'com.acme.b.Order', selector: 'selectors[0].extends', chain: ['com.acme.b.Order', 'org.springframework.data.jpa.domain.AbstractPersistable'] },
    ]);
    expect(members('mixed', { extends: 'Illuminate\\Database\\Eloquent\\Model' })).toEqual([
      { element: 'App\\Models\\Post', selector: 'selectors[0].extends', chain: ['App\\Models\\Post', 'Illuminate\\Database\\Eloquent\\Model'] },
    ]);
  });

  it('a base the file does resolve to the local class still extends it', () => {
    expect(names('mixed', { extends: 'ts/src/Model.ts#Model' })).toEqual(['ts/src/Local.ts#Local']);
    expect(names('mixed', { extends: 'py.app.local.Model' })).toEqual([]);
    expect(names('mixed', { extends: 'com.acme.a.AbstractPersistable' })).toEqual([]);
    expect(names('mixed', { extends: 'App\\Models\\Model' })).toEqual(['App\\Models\\User']);
  });
});

describe('review P2: parser and naming edge cases', CLI, () => {
  it('Python: a class line ending in a comment, and a one-line class body, keep their bases', () => {
    expect(names('mixed', { all: [{ extends: 'django.db.models.Model' }, { path: 'py/**' }] })).toEqual(['py.app.post.Post', 'py.app.user.User']);
  });

  it('Kotlin: an interface extending an interface is `extends`, though the index stores implements', () => {
    expect(names('mixed', { all: [{ extends: 'KI' }, { language: 'kotlin' }] })).toEqual(['kt/Types.kt#KJ']);
    expect(names('mixed', { all: [{ implements: 'KI' }, { language: 'kotlin' }] })).toEqual(['kt/Types.kt#KBase']);
  });

  it('PHP: a bare base name is qualified with the file\'s namespace', () => {
    expect(names('mixed', { implements: 'Some\\Vendor\\P' })).toEqual([]);
    expect(names('mixed', { implements: 'App\\Models\\P' })).toEqual(['App\\Models\\Status']);
  });

  it('an own import from a multi-type file and the same inherited import are one finding, the own one', () => {
    const r = mapxResult(roots.mixed, 'check', '--format', 'json');
    const findings = JSON.parse(r.stdout).findings as Array<{ kind: string; source: { element: string; file: string }; target: { element: string }; edgeType: string; via?: string[] }>;
    const toMailer = findings.filter((f) => f.source?.file === 'php/App/Domain/Two.php' && f.target?.element === 'App\\Http\\Mailer');
    expect(toMailer.filter((f) => f.edgeType === 'import')).toEqual([expect.objectContaining({ kind: 'violation', source: expect.objectContaining({ element: 'php/App/Domain/Two.php' }) })]);
    expect(toMailer.filter((f) => f.edgeType === 'import')[0]!.via).toBeUndefined();
    // The instantiation is Base's alone: Two inherits it, with `via`.
    expect(toMailer.filter((f) => f.edgeType === 'instantiation').map((f) => f.via)).toEqual([['App\\Domain\\Two', 'App\\Support\\Base']]);
  });
});

describe('review: a member is judged by its type for the hierarchy selectors', CLI, () => {
  it('a layer of Eloquent models holds their methods, so a method\'s dependency is checked', () => {
    const layer = mapxResult(roots.php, 'arch', 'layers', 'L', '--nested', '--view', viewOf('php', [{ extends: 'Eloquent\\Model' }]), '--format', 'json');
    const inL = (JSON.parse(layer.stdout).members as Array<{ element: string }>).map((m) => m.element);
    expect(inL).toEqual(expect.arrayContaining(['App\\Domain\\Order::pay', 'App\\Support\\BaseModel::notify']));
    expect(inL).not.toContain('App\\Domain\\Plain::run');
    const view = viewOf('php', [], {
      layers: [{ name: 'Models', selectors: [{ extends: 'Eloquent\\Model' }] }, { name: 'Http', selectors: [{ path: 'app/Http/**' }] }],
      rules: { Models: [], Http: [] },
    });
    const r = mapxResult(roots.php, 'check', '--view', view, '--format', 'json');
    const findings = JSON.parse(r.stdout).findings as Array<{ kind: string; source?: { element: string }; target?: { element: string }; edgeType?: string }>;
    // `notify` instantiates Mailer: before, only BaseModel's file-level import was checked.
    expect(findings.filter((f) => f.kind === 'violation' && f.source?.element === 'App\\Support\\BaseModel' && f.target?.element === 'App\\Http\\Mailer').map((f) => f.edgeType).sort()).toEqual(['import', 'instantiation']);
  });
});

/** A view of PHP types (one per file, namespace App) and stored inheritance edges, built in memory. */
function syntheticView(types: Array<{ name: string; kind?: string }>, edges: Array<[string, string, 'extends' | 'implements']>): ElementView {
  const elements: Element[] = [];
  const files = new Map<string, FileInfo>();
  const byFile = new Map<string, Element[]>();
  for (const t of types) {
    const path = `app/${t.name}.php`;
    const file: FileInfo = { path, repo: 'r', language: 'php', role: null, roleConfidence: 0, clusters: [], frameworkParts: new Set(), namespace: 'App' };
    files.set(path, file);
    const fileEl: Element = { id: `file:${path}`, kind: 'file', qualifiedName: path, file, topLevel: false };
    const sym: Element = { id: `symbol:${path}#App\\${t.name}#${t.kind ?? 'class'}`, kind: 'symbol', qualifiedName: `App\\${t.name}`, file, name: t.name, symbolKind: t.kind ?? 'class', scope: null, topLevel: true };
    elements.push(fileEl, sym);
    byFile.set(path, [fileEl, sym]);
  }
  const inheritance: InheritanceRecords = {
    edges: edges.map(([a, b, type]) => ({ sourceFile: `app/${a}.php`, sourceSymbol: a, targetFile: `app/${b}.php`, targetSymbol: `App\\${b}`, type })),
    candidates: [],
  };
  return {
    root: '/nonexistent', elements, files, byId: new Map(elements.map((e) => [e.id, e])), ofFile: (p) => byFile.get(p) ?? [],
    workspacePackage: () => null, scanStamp: 'synthetic', inheritance,
  };
}

describe('review P1-2 and P1-3: ancestry stays linear on deep chains and cycles', () => {
  it('a 2,000-class chain: every type matches its root, chains rebuilt on demand, depth 1,999', () => {
    const n = 2000;
    const view = syntheticView(Array.from({ length: n }, (_, i) => ({ name: `C${i}` })), Array.from({ length: n - 1 }, (_, i) => [`C${i}`, `C${i + 1}`, 'extends'] as [string, string, 'extends']));
    const types = view.elements.filter((e) => e.kind === 'symbol');
    const started = Date.now();
    let matched = 0;
    for (const t of types) if (hierarchyMatch(view, t, 'extends', `C${n - 1}`)) matched++;
    expect(matched).toBe(n - 1);
    expect(hierarchyMatch(view, types[0]!, 'extends', `C${n - 1}`)).toHaveLength(n);
    expect(hierarchyOf(view).depth(types[0]!)).toBe(n - 1);
    expect(hierarchyOf(view).longestChain(types[0]!)).toHaveLength(n);
    // Linear per type (quadratic over the whole chain); storing every path was cubic (review P1-2).
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it('inheritanceDepth on a 40-level interface ladder with a cycle at the bottom', () => {
    // L_i and R_i extend L_{i+1} and R_{i+1}; L_40 and X extend each other; R_40 extends nothing.
    const N = 40;
    const types = [...Array.from({ length: N + 1 }, (_, i) => [{ name: `L${i}`, kind: 'interface' }, { name: `R${i}`, kind: 'interface' }]).flat(), { name: 'X', kind: 'interface' }];
    const edges: Array<[string, string, 'extends']> = [];
    for (let i = 0; i < N; i++) for (const s of ['L', 'R']) edges.push([`${s}${i}`, `L${i + 1}`, 'extends'], [`${s}${i}`, `R${i + 1}`, 'extends']);
    edges.push([`L${N}`, 'X', 'extends'], ['X', `L${N}`, 'extends']);
    const view = syntheticView(types, edges);
    const el = (name: string) => view.elements.find((e) => e.kind === 'symbol' && e.name === name)!;
    const h = hierarchyOf(view);
    const started = Date.now();
    expect(h.depth(el(`L${N}`))).toBe(1);
    expect(h.depth(el('X'))).toBe(1);
    expect(h.depth(el(`R${N}`))).toBe(0);
    expect(h.depth(el('L0'))).toBe(N + 1);
    expect(h.longestChain(el('L0'))).toEqual([...Array.from({ length: N + 1 }, (_, i) => `App\\L${i}`), 'App\\X']);
    // The search that re-explored every path below a cycle doubled per level (review P1-3).
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it('`via` is shortened past VIA_LIMIT names', () => {
    const path = Array.from({ length: 1000 }, (_, i) => `C${i}`);
    expect(shownPath(path)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', '… 993 more …', 'C998', 'C999']);
    expect(shownPath(path)).toHaveLength(VIA_LIMIT);
    expect(shownPath(path.slice(0, VIA_LIMIT))).toEqual(path.slice(0, VIA_LIMIT));
  });
});

// M5-24-R2: under policy.inheritDependencies a type also answers for the packages its workspace
// ancestors use. tests/fixtures/arch-hierarchy/external: Domain may use Support, Support may use pg,
// Domain may not; BaseRepo (Support) imports and instantiates pg.
describe('policy.inheritDependencies and external packages (M5-24-R2)', CLI, () => {
  type F = { kind: string; rule?: string; source?: { element: string; layer?: string; line?: number }; target?: { element: string; external?: { origin: string } }; edgeType?: string; via?: string[]; message: string };
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mapx-arch-hierarchy-external-'));
    cpSync(join(FIXTURE, 'external'), root, { recursive: true });
    init(root);
    mapx(root, 'scan');
  }, 300_000);
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const check = () => {
    const r = mapxResult(root, 'check', '--format', 'json', '--report-allowed');
    return { status: r.status, findings: (JSON.parse(r.stdout).findings as F[]).filter((f) => f.target?.external) };
  };
  const pg = (findings: F[], from: string) => findings.filter((f) => f.source?.element === from).map((f) => `${f.kind} ${f.rule ?? ''} ${f.edgeType} via=${f.via?.join(' > ') ?? '-'}`).sort();
  const configure = (inheritDependencies: boolean) => {
    const file = join(root, '.mapx/architecture.jsonc');
    const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\/\/.*\n/gm, ''));
    writeFileSync(file, JSON.stringify({ ...config, policy: { inheritDependencies } }));
  };

  it('on: a subclass of a base that uses pg violates, `via` naming the inheritance path', () => {
    configure(true);
    const { status, findings } = check();
    expect(status).toBe(1);
    // Order extends BaseRepo; Special extends Order extends BaseRepo (a longer path).
    expect(pg(findings, 'src/domain/Order.ts#Order')).toEqual([
      'violation disallowed-layer import via=src/domain/Order.ts#Order > src/support/BaseRepo.ts#BaseRepo',
      'violation disallowed-layer instantiation via=src/domain/Order.ts#Order > src/support/BaseRepo.ts#BaseRepo',
    ]);
    expect(pg(findings, 'src/domain/Special.ts#Special')).toEqual([
      'violation disallowed-layer import via=src/domain/Special.ts#Special > src/domain/Order.ts#Order > src/support/BaseRepo.ts#BaseRepo',
      'violation disallowed-layer instantiation via=src/domain/Special.ts#Special > src/domain/Order.ts#Order > src/support/BaseRepo.ts#BaseRepo',
    ]);
    const order = findings.find((f) => f.source?.element === 'src/domain/Order.ts#Order' && f.edgeType === 'import')!;
    expect(order.message).toBe('src/domain/Order.ts#Order must not depend on pg (Domain on Database), inherited via src/domain/Order.ts#Order → src/support/BaseRepo.ts#BaseRepo');
    expect(order.source!.line).toBeUndefined(); // the dependency is in the base's file
    // The base's own dependencies are allowed and have no `via`. Its `extends pg.Client` is the
    // inheritance itself: Order and Special do not answer for it again (no `extends` finding above).
    expect(pg(findings, 'src/support/BaseRepo.ts#BaseRepo')).toEqual(['allowed  extends via=-', 'allowed  import via=-', 'allowed  instantiation via=-']);
    // Invoice uses pg itself: its own dependency is reported once, with no `via`; nothing is derived on top.
    expect(pg(findings, 'src/domain/Invoice.ts#Invoice')).toEqual(['violation disallowed-layer import via=-', 'violation disallowed-layer instantiation via=-']);
    // Plain extends nothing and uses nothing.
    expect(pg(findings, 'src/domain/Plain.ts#Plain')).toEqual([]);
    // A base in no layer still has its dependency: Thing (Domain) answers for CommonBase's pg (review). The base
    // itself, in no layer, has no finding.
    expect(pg(findings, 'src/domain/Thing.ts#Thing')).toEqual([
      'violation disallowed-layer import via=src/domain/Thing.ts#Thing > src/common/CommonBase.ts#CommonBase',
      'violation disallowed-layer instantiation via=src/domain/Thing.ts#Thing > src/common/CommonBase.ts#CommonBase',
    ]);
    expect(pg(findings, 'src/common/CommonBase.ts#CommonBase')).toEqual([]);
  });

  it('off: no inherited finding for Order or Special; only the dependencies the code states', () => {
    configure(false);
    const { findings } = check();
    expect(findings.filter((f) => f.via)).toEqual([]);
    expect(pg(findings, 'src/domain/Order.ts#Order')).toEqual([]);
    expect(pg(findings, 'src/domain/Special.ts#Special')).toEqual([]);
    expect(pg(findings, 'src/domain/Invoice.ts#Invoice')).toEqual(['violation disallowed-layer import via=-', 'violation disallowed-layer instantiation via=-']);
  });
});

describe('review P1-2: inheritDependencies on a 1,000-class chain, end to end in bounded memory', CLI, () => {
  it('each subclass inherits the root base\'s dependency once, with a shortened `via`, under a 512 MB heap', () => {
    const n = 1000;
    const files: Record<string, string> = {
      'composer.json': JSON.stringify({ name: 'fixture/deep', autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      'app/Http/Mailer.php': '<?php\nnamespace App\\Http;\n\nclass Mailer {}\n',
      [`app/Domain/C${n - 1}.php`]: `<?php\nnamespace App\\Domain;\n\nuse App\\Http\\Mailer;\n\nclass C${n - 1}\n{\n    public function mail() { return new Mailer(); }\n}\n`,
      '.mapx/architecture.jsonc': JSON.stringify({
        policy: { inheritDependencies: true },
        layers: [{ name: 'Domain', selectors: [{ path: 'app/Domain/**' }] }, { name: 'Http', selectors: [{ path: 'app/Http/**' }] }],
        rules: { Domain: [], Http: [] },
      }),
    };
    for (let i = 0; i < n - 1; i++) files[`app/Domain/C${i}.php`] = `<?php\nnamespace App\\Domain;\n\nclass C${i} extends C${i + 1} {}\n`;
    const root = mkdtempSync(join(tmpdir(), 'mapx-arch-deep-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      init(root);
      mapx(root, 'scan');
      const tsx = pathToFileURL(resolve(__dirname, '../node_modules/tsx/dist/loader.mjs')).href;
      const r = spawnSync(process.execPath, ['--max-old-space-size=512', '--import', tsx, resolve(__dirname, '../src/main.ts'), 'check', '--format', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1', GITHUB_ACTIONS: '' } });
      expect(r.status, r.stderr.slice(-2000)).toBe(1);
      const findings = JSON.parse(r.stdout).findings as Array<{ kind: string; source?: { element: string }; target?: { element: string }; via?: string[] }>;
      const inherited = findings.filter((f) => f.via);
      // Two dependencies (the import and the instantiation) per subclass; none on its own ancestors.
      expect(inherited).toHaveLength(2 * (n - 1));
      expect(inherited.every((f) => f.target!.element === 'App\\Http\\Mailer' && f.via!.length <= VIA_LIMIT)).toBe(true);
      expect(inherited.find((f) => f.source!.element === 'App\\Domain\\C0')!.via).toEqual(shownPath(Array.from({ length: n }, (_, i) => `App\\Domain\\C${i}`)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
