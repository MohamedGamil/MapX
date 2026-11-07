import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { init, mapx, mapxResult } from './helpers/e2e.js';
import { stripJsonc } from '../src/core/js-aliases.js';
import { loadArchitectureText, PRESETS } from '../src/arch/config.js';
import { PRESET_TEXTS } from '../src/arch/presets/index.js';
import { presetModule } from '../scripts/gen-arch-presets.js';
import { FRAMEWORK_PRESETS, writeAll } from '../src/arch/infer.js';

// M5-17: `mapx arch init` (AR-15). Every case runs the real CLI on a scanned temp copy of a
// synthetic fixture: tests/fixtures/arch-init/<name> (each file says which preset it is for and
// where its one violation is) and the Laravel route fixture of M1-01, used as it is.
const FIXTURES = resolve(__dirname, 'fixtures/arch-init');
const LARAVEL = resolve(__dirname, 'fixtures/laravel-routes');
const ROLES = resolve(__dirname, 'fixtures/arch-mcp/ts'); // roles: Data → Service breaks the web-api order
const SCHEMA = JSON.parse(readFileSync(resolve(__dirname, '../schemas/architecture.schema.json'), 'utf8'));
const SLOW = { timeout: 300_000 };
// AR-15's catalogue: the first wave (M5-17) and the rest (M5-17-R1).
// The framework presets, each the choice of `--from framework` on its fixture (FRAMEWORK_PRESETS).
const FRAMEWORK_IDS = ['laravel', 'nestjs', 'django', 'symfony', 'nextjs', 'express', 'fastapi', 'rails', 'spring', 'aspnet', 'flutter', 'vue'];
const ALL_PRESETS = ['aspnet', 'clean', 'ddd-contexts', 'django', 'express', 'fastapi', 'feature-sliced', 'flutter', 'hexagonal', 'laravel', 'layered', 'mvc', 'mvvm', 'nestjs', 'nextjs', 'onion', 'rails', 'spring', 'symfony', 'vue'];

let tmp = '';
const copies = new Map<string, string>();
let client: Client;

/** A scanned copy of `fixture` (once per name). */
function scanned(name: string, fixture: string): string {
  const root = join(tmp, name);
  cpSync(fixture, root, { recursive: true });
  rmSync(join(root, '.mapx'), { recursive: true, force: true });
  init(root);
  mapx(root, 'scan');
  copies.set(name, root);
  return root;
}

/** Every file under `root` with a hash of its content: any write shows. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const run = (cwd: string, ...args: string[]) => mapxResult(cwd, ...args);
const json = (cwd: string, ...args: string[]) => {
  const r = run(cwd, ...args);
  return { status: r.status, body: JSON.parse(r.stdout), stderr: r.stderr };
};
/** The violations of `mapx check --format json`, as unique `source file → target file` pairs. */
function violations(report: { findings: Array<{ kind: string; source?: { file: string }; target?: { file: string } }> }): string[] {
  return [...new Set(report.findings.filter((f) => f.kind === 'violation').map((f) => `${f.source!.file} → ${f.target!.file}`))].sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mapx-arch-init-'));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
}, 60_000);
afterAll(async () => {
  await client?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the shipped presets', () => {
  it('are the .jsonc files, embedded (scripts/gen-arch-presets.ts): the twenty of AR-15', () => {
    expect(readFileSync(resolve(__dirname, '../src/arch/presets/index.ts'), 'utf8')).toBe(presetModule());
    expect(Object.keys(PRESETS).sort()).toEqual(ALL_PRESETS);
    for (const [id, text] of Object.entries(PRESET_TEXTS)) expect(PRESETS[id]).toBe(text);
  });

  it('--from framework knows every framework preset (M5-17-R1)', () => {
    expect([...new Set(Object.values(FRAMEWORK_PRESETS))].sort()).toEqual([...FRAMEWORK_IDS].sort());
  });

  it('each validates against the schema and loads, extended, without an issue', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(SCHEMA);
    const dir = mkdtempSync(join(tmpdir(), 'mapx-arch-preset-'));
    try {
      for (const [id, text] of Object.entries(PRESET_TEXTS)) {
        expect([id, validate(JSON.parse(stripJsonc(text))), validate.errors]).toEqual([id, true, null]);
        const loaded = loadArchitectureText(dir, JSON.stringify({ extends: `mapx:preset/${id}` }));
        expect([id, loaded.issues]).toEqual([id, []]);
        expect(loaded.config!.layers.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Each preset on its fixture: the layers that hold files, and the one planted violation. Every
// fixture fills every layer of its preset (review of M5-17: a rule between two empty layers is
// never tested), except M1-01's route fixture, kept for the acceptance criterion, which fills 3 of
// 11 and so gets the "most layers are empty" warning.
// `unclassified` (review of M5-17-R1): the paths of the Unclassified layer, the code no preset layer
// selects (an entry point, an app/Enums folder), which every layer may use so that day one passes.
const CASES: Array<{ name?: string; preset: string; fixture: string; layers: Record<string, number>; violations: string[]; parameters?: Record<string, string>; partial?: string; unclassified?: string[] }> = [
  {
    name: 'laravel (the M1-01 route fixture)', preset: 'laravel', fixture: LARAVEL, parameters: { root: '' },
    layers: { Routes: 43, Http: 17, Providers: 1 },
    violations: [],
    // Module route files and providers outside the preset's folders (review of M5-17-R1).
    unclassified: [
      'Modules/Blog/app/Providers/**', 'Modules/Blog/routes/**', 'app/Modules/Billing/BillingServiceProvider.php', 'app/Modules/Billing/Routes/**',
      'app/Modules/Shop/ShopServiceProvider.php', 'app/Modules/Shop/routes.php', 'artisan', 'bootstrap/**',
    ],
    partial: 'Warning: 8 of 11 layers are empty (Console, Jobs, Events, Listeners, Services, Models, Views, Database): `mapx check` warns about each until code lands there.\n',
  },
  {
    // Idiomatic Laravel 11 (review of M5-17): route-model binding in a route closure, an invokable
    // action routed directly, the scheduler in routes/console.php, channel authorisation with
    // models, a listener type-hinting its event. Clean but for the planted Model → Http request.
    // app/Billing (M5-17-R1) is in no folder the preset names: its model, queued job and controller
    // are placed by ancestry alone (Models, Jobs and Http each count one of its files).
    name: 'laravel (a Laravel 11 app filling every layer)', preset: 'laravel', fixture: join(FIXTURES, 'laravel11'), parameters: { root: '' },
    layers: { Routes: 3, Http: 5, Console: 2, Providers: 1, Jobs: 2, Events: 1, Listeners: 1, Services: 2, Models: 5, Views: 1, Database: 3 },
    unclassified: ['app/Enums/**', 'artisan', 'bootstrap/**'],
    violations: ['app/Models/OrderItem.php → app/Http/Requests/StoreOrderRequest.php'],
  },
  {
    // src/billing (M5-17-R1) has no Nest file suffix: @Entity, @Injectable and `implements
    // CanActivate` place its three files (an @Injectable guard is in Enhancer only).
    preset: 'nestjs', fixture: join(FIXTURES, 'nestjs'),
    layers: { Module: 2, Controller: 1, Enhancer: 2, Provider: 2, Dto: 1, Entity: 2 },
    unclassified: ['src/main.ts'],
    violations: ['src/orders/orders.controller.ts → src/orders/order.entity.ts'],
  },
  {
    // shop/billing.py and shop/api.py (M5-17-R1) are in no module the preset names: models.Model
    // and the class-based view bases place them.
    preset: 'django', fixture: join(FIXTURES, 'django'),
    layers: { Urls: 1, Views: 2, Admin: 1, Commands: 2, Forms: 1, Serializers: 1, Migrations: 2, Models: 2 },
    unclassified: ['manage.py', 'shop/__init__.py', 'shop/management/__init__.py'],
    violations: ['shop/admin.py → shop/views.py'],
  },
  {
    preset: 'layered', fixture: join(FIXTURES, 'layered'), parameters: { root: 'src/' },
    layers: { Presentation: 1, Business: 1, Persistence: 1, Common: 1 },
    violations: ['src/presentation/OrderController.ts → src/persistence/OrderRepository.ts'],
  },
  {
    preset: 'clean', fixture: join(FIXTURES, 'clean'), parameters: { root: 'src/' },
    layers: { Domain: 1, Application: 2, Adapters: 1, Infrastructure: 2 },
    violations: ['src/domain/Order.ts → src/infrastructure/SystemClock.ts'],
  },
  {
    preset: 'hexagonal', fixture: join(FIXTURES, 'hexagonal'), parameters: { root: 'src/' },
    layers: { Domain: 1, Application: 2, Adapters: 2 },
    violations: ['src/application/PlaceOrder.ts → src/adapters/MemoryOrderStore.ts'],
  },
  {
    preset: 'ddd-contexts', fixture: join(FIXTURES, 'ddd'), parameters: { root: 'src/' },
    layers: { SharedKernel: 1, Billing: 1, Shipping: 1 },
    violations: ['src/billing/Invoice.ts → src/shipping/Shipment.ts'],
  },
  {
    preset: 'feature-sliced', fixture: join(FIXTURES, 'fsd'), parameters: { root: 'src/' },
    layers: { App: 1, Processes: 1, Pages: 1, Widgets: 1, Features: 1, Entities: 1, Shared: 1 },
    violations: ['src/entities/Product.ts → src/features/AddToCart.ts'],
  },
  // M5-17-R1: the rest of AR-15. Each fixture (tests/fixtures/arch-init/<preset>) fills every layer
  // and plants one violation, named in a comment. Those whose preset selects by ancestry or
  // annotation also have a file in a folder no path selector names (a Billing folder).
  {
    preset: 'onion', fixture: join(FIXTURES, 'onion'), parameters: { root: 'src/' },
    layers: { DomainModel: 1, DomainServices: 1, ApplicationServices: 1, Presentation: 1, Infrastructure: 1 },
    violations: ['src/application/Checkout.ts → src/infrastructure/SqlOrderRepository.ts'],
  },
  {
    preset: 'mvc', fixture: join(FIXTURES, 'mvc'), parameters: { root: 'src/' },
    layers: { Controllers: 1, Views: 1, Models: 1 },
    violations: ['src/views/OrderView.ts → src/controllers/OrderController.ts'],
  },
  {
    preset: 'mvvm', fixture: join(FIXTURES, 'mvvm'), parameters: { root: 'src/' },
    layers: { Views: 1, ViewModels: 1, Services: 1, Models: 1 },
    violations: ['src/views/OrderView.ts → src/services/OrderService.ts'],
  },
  {
    // src/Billing: an #[ORM\Entity] and an AbstractController subclass.
    preset: 'symfony', fixture: join(FIXTURES, 'symfony'), parameters: { root: '' },
    layers: { Controller: 2, Form: 1, Command: 1, EventSubscriber: 1, MessageHandler: 1, Message: 1, Service: 1, Repository: 1, Entity: 2 },
    unclassified: ['bin/**'],
    violations: ['src/Entity/Order.php → src/Service/OrderTotals.php'],
  },
  {
    preset: 'express', fixture: join(FIXTURES, 'express'), parameters: { root: 'src/' },
    layers: { App: 1, Routes: 1, Controllers: 1, Middleware: 1, Services: 1, Models: 1, Config: 1 },
    violations: ['src/models/order.ts → src/controllers/orderController.ts'],
  },
  {
    preset: 'fastapi', fixture: join(FIXTURES, 'fastapi'), parameters: { root: 'app/' },
    layers: { App: 1, Routers: 2, Dependencies: 1, Services: 2, Schemas: 2, Models: 2, Core: 3 },
    unclassified: ['app/__init__.py'],
    violations: ['app/models/order.py → app/routers/orders.py'],
  },
  {
    // app/billing: an ApplicationRecord model and an ApplicationJob job.
    preset: 'rails', fixture: join(FIXTURES, 'rails'), parameters: { root: '' },
    layers: { Routes: 1, Controllers: 2, Channels: 1, Helpers: 1, Services: 1, Jobs: 3, Mailers: 2, Models: 3, Database: 2 },
    unclassified: ['Gemfile'],
    violations: ['app/models/order.rb → app/services/place_order.rb'],
  },
  {
    // com.example.shop.billing: a Spring Data repository and a @Service.
    preset: 'spring', fixture: join(FIXTURES, 'spring'),
    layers: { Controller: 1, Config: 1, Service: 2, Repository: 2, Dto: 1, Entity: 1 },
    unclassified: ['src/main/java/com/example/shop/ShopApplication.java'],
    violations: ['src/main/java/com/example/shop/domain/Order.java → src/main/java/com/example/shop/dto/OrderDto.java'],
  },
  {
    // Billing/: a DbContext and a ControllerBase subclass.
    preset: 'aspnet', fixture: join(FIXTURES, 'aspnet'),
    layers: { Controllers: 2, Pages: 1, Middleware: 1, Services: 1, Data: 2, Dtos: 1, Models: 1 },
    unclassified: ['Program.cs'],
    violations: ['Models/Order.cs → Services/OrderService.cs'],
  },
  {
    // lib/billing: a ChangeNotifier.
    preset: 'flutter', fixture: join(FIXTURES, 'flutter'), parameters: { root: 'lib/' },
    layers: { App: 1, Screens: 1, Widgets: 1, State: 2, Services: 1, Models: 1 },
    violations: ['lib/widgets/order_tile.dart → lib/services/order_api.dart'],
  },
  {
    preset: 'nextjs', fixture: join(FIXTURES, 'nextjs'), parameters: { root: '' },
    layers: { Routes: 1, Api: 1, Actions: 1, Components: 1, Hooks: 1, Lib: 1 },
    violations: ['lib/orders.ts → components/OrderList.tsx'],
  },
  {
    preset: 'vue', fixture: join(FIXTURES, 'vue'), parameters: { root: 'src/' },
    layers: { App: 2, Router: 1, Views: 1, Components: 1, Composables: 1, Stores: 1, Services: 1, Shared: 1 },
    violations: ['src/services/ordersApi.ts → src/stores/orders.ts'],
  },
];

describe('mapx arch init --preset: a config that validates and that mapx check runs without configuration errors', SLOW, () => {
  for (const c of CASES) {
    it(c.name ?? c.preset, () => {
      const root = scanned((c.name ?? c.preset).replace(/\W+/g, '-'), c.fixture);
      const before = snapshot(root);
      // Dry run by default: the proposal, and nothing written.
      const dry = json(root, 'arch', 'init', '--preset', c.preset, '--json');
      expect(dry.status).toBe(0);
      expect(snapshot(root)).toEqual(before);
      expect(dry.body).toMatchObject({ path: '.mapx/architecture.jsonc', written: false, exists: false, source: 'preset', preset: c.preset, issues: [] });
      if (c.parameters) expect(dry.body.parameters).toEqual(c.parameters);
      expect(Object.fromEntries(dry.body.layers.filter((l: { files: number }) => l.files > 0).map((l: { name: string; files: number }) => [l.name, l.files]))).toEqual(c.layers);
      // Every layer the preset defines holds a file, so each of its rules is exercised.
      if (!c.partial) expect(dry.body.layers.map((l: { name: string }) => l.name).sort()).toEqual(Object.keys(c.layers).sort());
      expect(JSON.parse(stripJsonc(dry.body.config)).extends).toBe(`mapx:preset/${c.preset}`);
      // The code no layer selects is in Unclassified, which every layer may use and which may use every layer.
      expect(dry.body.unclassified?.paths ?? []).toEqual(c.unclassified ?? []);
      if (c.unclassified) {
        const doc = JSON.parse(stripJsonc(dry.body.config));
        expect(doc.layers.find((l: { name: string }) => l.name === 'Unclassified')).toEqual({ name: 'Unclassified', selectors: c.unclassified.map((path) => ({ path })) });
        expect([doc.rules['*'], doc.rules.Unclassified]).toEqual([expect.arrayContaining(['Unclassified']), ['*']]);
      }

      const written = run(root, 'arch', 'init', '--preset', c.preset, '--write');
      expect([written.status, written.stderr]).toEqual([0, c.partial ?? '']);
      expect(readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8')).toBe(dry.body.config);
      expect(run(root, 'arch', 'validate-config').status).toBe(0);
      const check = json(root, 'check', '--format', 'json');
      expect(check.body.configErrors).toEqual([]);
      expect(check.body.findings.filter((f: { kind: string }) => f.kind === 'error')).toEqual([]);
      // No element lands in two layers (review of M5-17-R1: a Laravel model in app/Services).
      expect(check.body.findings.filter((f: { rule: string }) => f.rule === 'multi-layer').map((f: { message: string }) => f.message)).toEqual([]);
      expect(check.status).toBe(c.violations.length ? 1 : 0);
      expect(violations(check.body)).toEqual(c.violations);
      expect(check.body.counts.violation).toBe(dry.body.violations);

      // Day one (M5-17-R1): with the baseline, `check --fail-on-uncovered` passes.
      expect(run(root, 'arch', 'init', '--preset', c.preset, '--baseline', '--write', '--force').status).toBe(0);
      const dayOne = run(root, 'check', '--fail-on-uncovered');
      expect(dayOne.status, dayOne.stdout).toBe(0);
      // A framework preset is what `--from framework` picks on its fixture, with no other framework.
      if (FRAMEWORK_IDS.includes(c.preset)) {
        expect(json(root, 'arch', 'init', '--from', 'framework', '--json').body).toMatchObject({ source: 'preset', preset: c.preset, notes: [] });
      }
    });
  }
});

describe('mapx arch init --preset: the folder parameter is inferred from the indexed paths', SLOW, () => {
  it('a clean layout two levels down (services/api/src/) sets root, and its check finds the same violation', () => {
    const root = join(tmp, 'nested');
    cpSync(join(FIXTURES, 'clean'), join(root, 'services/api'), { recursive: true });
    // A decoy at the top: one folder named like a layer must not outweigh four.
    mkdirSync(join(root, 'src/domain'), { recursive: true });
    writeFileSync(join(root, 'src/domain/Stray.ts'), 'export const stray = 1;\n');
    init(root);
    mapx(root, 'scan');
    const dry = json(root, 'arch', 'init', '--preset', 'clean', '--json');
    expect(dry.body.parameters).toEqual({ root: 'services/api/src/' });
    expect(dry.body.config).toContain('// root = "services/api/src/": the folder where the most of the preset\'s layers have files (4 of 4, 6 files).');
    expect(run(root, 'arch', 'init', '--preset', 'clean', '--write').status).toBe(0);
    const check = json(root, 'check', '--format', 'json');
    expect([check.status, check.body.configErrors]).toEqual([1, []]);
    expect(violations(check.body)).toEqual(['services/api/src/domain/Order.ts → services/api/src/infrastructure/SystemClock.ts']);
  });

  it('a layer selected inside `all` counts: the Next.js Learn layout (app/ui, app/lib) keeps root "" (review of M5-17-R1)', () => {
    const root = scanned('nextjs-learn', join(FIXTURES, 'nextjs-learn'));
    const dry = json(root, 'arch', 'init', '--preset', 'nextjs', '--json');
    expect(dry.body.parameters).toEqual({ root: '' });
    expect(Object.fromEntries(dry.body.layers.map((l: { name: string; files: number }) => [l.name, l.files]))).toEqual({ Routes: 2, Api: 1, Actions: 1, Components: 2, Hooks: 0, Lib: 2 });
    expect(run(root, 'arch', 'init', '--preset', 'nextjs', '--write').status).toBe(0);
    const check = json(root, 'check', '--format', 'json');
    expect([check.status, check.body.configErrors, violations(check.body)]).toEqual([0, [], []]);

    // Under src/ with no route handler or action file, only the `all` layers (Routes, Components,
    // Lib) find the folder: it is src/, not the default "".
    const nested = join(tmp, 'nextjs-learn-src');
    cpSync(join(FIXTURES, 'nextjs-learn'), join(nested, 'src'), { recursive: true });
    for (const f of ['src/app/query/route.ts', 'src/app/lib/actions.ts', 'src/app/ui/invoices/create-form.tsx']) rmSync(join(nested, f));
    init(nested);
    mapx(nested, 'scan');
    const src = json(nested, 'arch', 'init', '--preset', 'nextjs', '--json');
    expect(src.body.parameters).toEqual({ root: 'src/' });
    expect(Object.fromEntries(src.body.layers.map((l: { name: string; files: number }) => [l.name, l.files]))).toEqual({ Routes: 2, Api: 0, Actions: 0, Components: 1, Hooks: 0, Lib: 2 });
  });

  it('a folder with glob characters (svc (v2)/) is escaped, so the layers match it (review of M5-17)', () => {
    const root = join(tmp, 'glob');
    cpSync(join(FIXTURES, 'hexagonal/src'), join(root, 'svc (v2)'), { recursive: true });
    init(root);
    mapx(root, 'scan');
    const dry = json(root, 'arch', 'init', '--preset', 'hexagonal', '--json');
    expect(dry.body.parameters).toEqual({ root: 'svc \\(v2\\)/' });
    expect(Object.fromEntries(dry.body.layers.map((l: { name: string; files: number }) => [l.name, l.files]))).toEqual({ Domain: 1, Application: 2, Adapters: 2 });
    expect(run(root, 'arch', 'init', '--preset', 'hexagonal', '--write').status).toBe(0);
    const check = json(root, 'check', '--format', 'json');
    expect([check.status, check.body.configErrors]).toEqual([1, []]);
    expect(violations(check.body)).toEqual(['svc (v2)/application/PlaceOrder.ts → svc (v2)/adapters/MemoryOrderStore.ts']);
  });
});

describe('mapx arch init refuses what it should not write (review of M5-17)', SLOW, () => {
  it('a proposal whose every layer is empty: exit 3 without --force, a warning in the dry run', () => {
    const root = join(tmp, 'empty');
    mkdirSync(root);
    writeFileSync(join(root, 'README.md'), '# Synthetic workspace for M5-17: no code.\n');
    writeFileSync(join(root, 'package.json'), '{ "name": "m5-17-empty", "private": true }\n');
    init(root);
    mapx(root, 'scan');
    const before = snapshot(root);
    const dry = run(root, 'arch', 'init', '--preset', 'hexagonal');
    expect(dry.status).toBe(0);
    expect(dry.stderr).toContain('Warning: Every layer is empty: no file in this index matches the proposal\'s selectors (the hexagonal preset\'s layout, with root = ""). Writing it needs --force.');
    const refused = run(root, 'arch', 'init', '--preset', 'hexagonal', '--write');
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('Error: Every layer of the proposal is empty: no file in this index matches it. Nothing was written.');
    expect(snapshot(root)).toEqual(before);
    expect(run(root, 'arch', 'init', '--preset', 'hexagonal', '--write', '--force').status).toBe(0);
    expect(existsSync(join(root, '.mapx/architecture.jsonc'))).toBe(true);
  });

  it('a symlinked .mapx/architecture.jsonc is never written through, even with --force', () => {
    const root = scanned('symlink', join(FIXTURES, 'clean'));
    const outside = join(tmp, 'outside.jsonc');
    writeFileSync(outside, '{"precious":true}\n');
    symlinkSync(outside, join(root, '.mapx/architecture.jsonc'));
    const r = run(root, 'arch', 'init', '--preset', 'clean', '--write', '--force');
    expect([r.status, r.stderr]).toEqual([3, 'Error: .mapx/architecture.jsonc is a symbolic link: mapx arch init writes only inside the workspace, never through a symlink. Nothing was written.\n']);
    expect(readFileSync(outside, 'utf8')).toBe('{"precious":true}\n');
    expect(lstatSync(join(root, '.mapx/architecture.jsonc')).isSymbolicLink()).toBe(true);
  });

  it('a write that fails is exit 3 and changes nothing: the configuration is never left without its baseline', () => {
    const root = scanned('atomic', join(FIXTURES, 'clean'));
    writeFileSync(join(root, '.mapx/architecture.jsonc'), '// the old configuration\n{ "layers": [] }\n');
    // Something that is not a file where the baseline goes.
    mkdirSync(join(root, '.mapx/architecture.baseline.json'));
    writeFileSync(join(root, '.mapx/architecture.baseline.json/keep.txt'), 'kept\n');
    const before = snapshot(root);
    const r = json(root, 'arch', 'init', '--preset', 'clean', '--baseline', '--write', '--force', '--json');
    expect(r.status).toBe(3);
    expect(r.body.error).toBe('Cannot write .mapx/architecture.baseline.json: it exists and is not a file. Nothing was changed.');
    expect(snapshot(root)).toEqual(before);
  });

  it('writeAll stages every file before replacing any: a failure on the second leaves the first untouched, and no temporary file', () => {
    const dir = join(tmp, 'write-all');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.jsonc'), 'old\n');
    writeFileSync(join(dir, 'blocker'), 'a file, where a folder is needed\n');
    expect(() => writeAll(dir, [{ path: join(dir, 'a.jsonc'), text: 'new\n' }, { path: join(dir, 'blocker/b.json'), text: '{}\n' }]))
      .toThrow(/^Cannot write blocker\/b\.json \(ENOTDIR\): .*Nothing was changed\.$/);
    expect(readdirSync(dir).sort()).toEqual(['a.jsonc', 'blocker']);
    expect(readFileSync(join(dir, 'a.jsonc'), 'utf8')).toBe('old\n');
    writeAll(dir, [{ path: join(dir, 'a.jsonc'), text: 'new\n' }, { path: join(dir, 'b.json'), text: '{}\n' }]);
    expect(readdirSync(dir).sort()).toEqual(['a.jsonc', 'b.json', 'blocker']);
    expect(readFileSync(join(dir, 'a.jsonc'), 'utf8')).toBe('new\n');
  });
});

describe('mapx arch init --baseline: day one is green', SLOW, () => {
  it('roles (the arch-mcp app breaks its own layer order): check exits 1 without the baseline, 0 with it', () => {
    const root = scanned('roles', ROLES);
    rmSync(join(root, '.mapx/architecture.jsonc'), { force: true });
    const r = run(root, 'arch', 'init', '--baseline', '--write');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Wrote \.mapx\/architecture\.jsonc \(3 layers, 3 violations today\)\.\nWrote \.mapx\/architecture\.baseline\.json \(3 entries\)\./);
    const baseline = JSON.parse(readFileSync(join(root, '.mapx/architecture.baseline.json'), 'utf8'));
    // Data (SqlOrderRepository) on Service (the domain): its two imports and its `implements`.
    expect(baseline.entries.map((e: { source: string; target: string }) => `${e.source} → ${e.target}`)).toEqual([
      'src/infrastructure/SqlOrderRepository.ts → src/domain/Order.ts',
      'src/infrastructure/SqlOrderRepository.ts → src/domain/OrderRepository.ts',
      'src/infrastructure/SqlOrderRepository.ts#SqlOrderRepository → src/domain/OrderRepository.ts#OrderRepository',
    ]);
    expect(run(root, 'check').status).toBe(0);
    const report = json(root, 'check', '--format', 'json').body;
    expect([report.counts.violation, report.counts.skipped, report.counts.error]).toEqual([0, 3, 0]);
    // Without the baseline, the same configuration fails: the baseline is what makes it green.
    rmSync(join(root, '.mapx/architecture.baseline.json'));
    expect(run(root, 'check').status).toBe(1);
    // A new violation still fails with the baseline in place.
    expect(run(root, 'arch', 'init', '--baseline', '--write', '--force').status).toBe(0);
    appendFileSync(join(root, 'src/domain/Order.ts'), "import { OrderController } from '../controller/OrderController';\nexport const c = OrderController;\n");
    const after = run(root, 'check', '--sync', '--format', 'json');
    expect(after.status).toBe(1);
    expect(violations(JSON.parse(after.stdout))).toEqual(['src/domain/Order.ts → src/controller/OrderController.ts']);
  });

  it('a preset with violations (nestjs), and --from clusters, whose rules freeze today\'s cluster graph', () => {
    const nest = scanned('nest-baseline', join(FIXTURES, 'nestjs'));
    expect(run(nest, 'arch', 'init', '--preset', 'nestjs', '--baseline', '--write').status).toBe(0);
    expect(JSON.parse(readFileSync(join(nest, '.mapx/architecture.baseline.json'), 'utf8')).entries).toHaveLength(2);
    expect(run(nest, 'check').status).toBe(0);

    const clusters = scanned('clusters', ROLES);
    rmSync(join(clusters, '.mapx/architecture.jsonc'), { force: true });
    const dry = json(clusters, 'arch', 'init', '--from', 'clusters', '--json').body;
    expect(dry.layers).toEqual([{ name: 'Src', cluster: 'src', files: 3 }, { name: 'SrcDomain', cluster: 'src.domain', files: 2 }]);
    expect(JSON.parse(stripJsonc(dry.config)).rules).toEqual({ Src: ['SrcDomain'], SrcDomain: [] });
    expect(dry.violations).toBe(0);
    expect(run(clusters, 'arch', 'init', '--from', 'clusters', '--write').status).toBe(0);
    expect(run(clusters, 'check').status).toBe(0);
  });

  it('--baseline needs a current index (exit 4 when stale), as mapx check does; a plain proposal does not', () => {
    const root = scanned('stale', join(FIXTURES, 'clean'));
    appendFileSync(join(root, 'src/domain/Order.ts'), '// changed after the scan\n');
    const before = snapshot(root);
    const stale = run(root, 'arch', 'init', '--preset', 'clean', '--baseline', '--write');
    expect(stale.status).toBe(4);
    expect(stale.stderr).toContain('`mapx arch init --sync`');
    expect(snapshot(root)).toEqual(before);
    expect(run(root, 'arch', 'init', '--preset', 'clean').status).toBe(0);
    expect(run(root, 'arch', 'init', '--preset', 'clean', '--baseline', '--write', '--sync').status).toBe(0);
    expect(run(root, 'check').status).toBe(0);
  });
});

describe('mapx arch init: dry run by default, no silent overwrite, stable bytes, one engine with mapx_arch_init', SLOW, () => {
  let root = '';
  beforeAll(() => {
    root = scanned('writes', ROLES);
    rmSync(join(root, '.mapx/architecture.jsonc'), { force: true });
  }, 300_000);

  it('writes nothing without --write; prints the JSONC on stdout and the summary on stderr', () => {
    const before = snapshot(root);
    const a = run(root, 'arch', 'init');
    const b = run(root, 'arch', 'init', '--baseline', '--preset', 'clean');
    const c = run(root, 'arch', 'init', '--view', 'proposed', '--json');
    expect([a.status, b.status, c.status]).toEqual([0, 0, 0]);
    expect(snapshot(root)).toEqual(before);
    expect(a.stdout.startsWith('// Proposed by `mapx arch init` from MapX roles')).toBe(true);
    expect(a.stderr).toBe('Dry run (3 layers, 3 violations today): nothing written. Add --write to create .mapx/architecture.jsonc.\n');
    // PlaceOrder → SqlOrderRepository: import, instantiation and the `new SqlOrderRepository().save()` call (M2-12).
    expect(b.stderr).toContain('Add --write to create .mapx/architecture.jsonc and .mapx/architecture.baseline.json (3 entries).');
    expect(JSON.parse(c.stdout)).toMatchObject({ path: '.mapx/architecture/proposed.jsonc', view: 'proposed', written: false });
  });

  it('is byte-stable, and mapx_arch_init returns the same bytes', async () => {
    for (const args of [[], ['--from', 'clusters'], ['--preset', 'hexagonal', '--baseline']]) {
      const one = run(root, 'arch', 'init', ...args, '--json');
      const two = run(root, 'arch', 'init', ...args, '--json');
      expect(two.stdout).toBe(one.stdout);
      const mcpArgs = args[0] === '--from' ? { from: args[1] } : args[0] === '--preset' ? { preset: args[1], baseline: true } : {};
      const mcp = await client.callTool({ name: 'mapx_arch_init', arguments: { dir: root, ...mcpArgs } }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(mcp.isError).toBeFalsy();
      expect(JSON.parse(mcp.content[0]!.text)).toEqual(JSON.parse(one.stdout));
    }
  });

  it('--write creates the file; over it, exit 3 with a message and no change; --force overwrites', () => {
    const w = run(root, 'arch', 'init', '--write');
    expect(w.status).toBe(0);
    const path = join(root, '.mapx/architecture.jsonc');
    const first = readFileSync(path, 'utf8');
    expect(first).toBe(run(root, 'arch', 'init').stdout);
    const before = snapshot(root);
    const again = run(root, 'arch', 'init', '--from', 'clusters', '--write');
    expect(again.status).toBe(3);
    expect(again.stderr).toBe('Error: .mapx/architecture.jsonc already exists: nothing was written. Pass --force to overwrite it, or choose another view.\n');
    expect(snapshot(root)).toEqual(before);
    // A dry run over an existing file says so, and still writes nothing.
    expect(run(root, 'arch', 'init').stderr).toContain('.mapx/architecture.jsonc exists: add --force to overwrite it.');
    const forced = run(root, 'arch', 'init', '--from', 'clusters', '--write', '--force');
    expect(forced.status).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('"cluster": "src.domain"');
    // A baseline is never written over either.
    expect(run(root, 'arch', 'init', '--baseline', '--write', '--force').status).toBe(0);
    const baseline = readFileSync(join(root, '.mapx/architecture.baseline.json'), 'utf8');
    const refused = json(root, 'arch', 'init', '--view', 'other', '--baseline', '--write', '--json');
    expect(refused.status).toBe(0); // a view has its own baseline file
    mkdirSync(join(root, '.mapx/architecture'), { recursive: true });
    writeFileSync(join(root, '.mapx/architecture/third.baseline.json'), baseline);
    const third = json(root, 'arch', 'init', '--view', 'third', '--baseline', '--write', '--json');
    expect(third.status).toBe(3);
    expect(third.body.error).toBe('.mapx/architecture/third.baseline.json already exists: nothing was written. Pass --force to overwrite it.');
    expect(existsSync(join(root, '.mapx/architecture/third.jsonc'))).toBe(false);
  });

  it('usage errors are exit 3: an unknown preset, a preset with --from, a view outside .mapx/architecture/, no framework to use', () => {
    const before = snapshot(root);
    const cases: Array<[string[], string]> = [
      [['--preset', 'nope'], `unknown preset "nope"; available: ${ALL_PRESETS.join(', ')}`],
      [['--preset', 'clean', '--from', 'roles'], 'give a preset or a source (from), not both'],
      [['--from', 'graph'], 'from must be one of roles, clusters, framework, not "graph"'],
      [['--view', '../x', '--write'], 'view "../x" is not a file name in .mapx/architecture/'],
      [['--from', 'framework'], 'No framework with a preset was detected in this index (detected: none; presets exist for laravel, nestjs, django, symfony, nextjs, express, fastapi, rails, spring, aspnet, flutter, vue-router). Pass a preset instead.'],
    ];
    for (const [args, message] of cases) {
      const r = run(root, 'arch', 'init', ...args);
      expect([args, r.status, r.stderr]).toEqual([args, 3, `Error: ${message}\n`]);
    }
    expect(snapshot(root)).toEqual(before);
  });

  it('--from framework uses the detected framework\'s preset', () => {
    const nest = copies.get('nestjs') ?? scanned('nest-framework', join(FIXTURES, 'nestjs'));
    const r = json(nest, 'arch', 'init', '--from', 'framework', '--json');
    expect(r.status).toBe(0);
    expect(r.body).toMatchObject({ source: 'preset', preset: 'nestjs', notes: [] });
  });
});

// Review of M5-24: every proposal on an index with package references gets a Packages layer every
// layer may use, and `check --fail-on-uncovered` passes on the day the configuration is written.
// Since D039 (M5-24-R4) packages are uncovered only when the configuration opts in (a package
// selector, as the Packages layer is, or `policy.uncovered.externals: true`), and no baseline skips
// an uncovered dependency: day one passes with the layer and without it. tests/fixtures/arch-init/packages: express and
// pg (production), left-pad (in no manifest: its dev status is unknown, so `{ package: "*", dev: false }`
// would leave it uncovered), node:crypto (built in, never reported by default).
describe('mapx arch init on a project with packages: check --fail-on-uncovered passes on day one (review of M5-24)', SLOW, () => {
  const PACKAGES = join(FIXTURES, 'packages');
  for (const [name, args] of [['roles', ['--from', 'roles']], ['clusters', ['--from', 'clusters']], ['preset layered', ['--preset', 'layered']]] as const) {
    it(`${name}: a Packages layer every layer may use; --baseline then check --fail-on-uncovered exits 0`, () => {
      const root = scanned(`packages-${name.replace(/\W+/g, '-')}`, PACKAGES);
      const written = run(root, 'arch', 'init', ...args, '--baseline', '--write');
      expect(written.status, written.stderr).toBe(0);
      const config = JSON.parse(stripJsonc(readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8')));
      expect(config.layers.find((l: { name: string }) => l.name === 'Packages')).toEqual({ name: 'Packages', selectors: [{ package: '*' }] });
      // Packages first; then Unclassified (review of M5-17-R1) when the proposal leaves code unplaced.
      expect(config.rules['*']).toEqual(config.layers.some((l: { name: string }) => l.name === 'Unclassified') ? ['Packages', 'Unclassified'] : ['Packages']);
      expect(readFileSync(join(root, '.mapx/architecture.jsonc'), 'utf8')).toContain('policy.uncovered.externals');
      const check = run(root, 'check', '--fail-on-uncovered', '--format', 'json', '--report-uncovered');
      const report = JSON.parse(check.stdout);
      expect(report.findings.filter((f: { kind: string }) => f.kind === 'uncovered')).toEqual([]);
      expect(check.status, check.stdout).toBe(0);
    });
  }

  it('without the Packages layer packages are out of scope (exit 0); with policy.uncovered.externals they are uncovered (exit 2)', () => {
    const root = scanned('packages-without', PACKAGES);
    expect(run(root, 'arch', 'init', '--preset', 'layered', '--baseline', '--write').status).toBe(0);
    const path = join(root, '.mapx/architecture.jsonc');
    const config = JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
    delete config.rules;
    config.layers = config.layers.filter((l: { name: string }) => l.name !== 'Packages');
    writeFileSync(path, JSON.stringify(config));
    const out = run(root, 'check', '--fail-on-uncovered', '--format', 'json', '--report-uncovered');
    expect(JSON.parse(out.stdout).findings.filter((f: { kind: string }) => f.kind === 'uncovered')).toEqual([]);
    expect(out.status, out.stdout).toBe(0);
    writeFileSync(path, JSON.stringify({ ...config, policy: { uncovered: { externals: true } } }));
    const check = run(root, 'check', '--fail-on-uncovered', '--format', 'json', '--report-uncovered');
    expect(check.status).toBe(2);
    expect(JSON.parse(check.stdout).findings.filter((f: { kind: string }) => f.kind === 'uncovered').map((f: { target: { element: string } }) => f.target.element).sort())
      .toEqual(['express', 'express', 'left-pad', 'left-pad', 'pg', 'pg']);
  });
});
