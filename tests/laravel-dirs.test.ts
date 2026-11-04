import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bladeToPhp } from '../src/parsers/languages/blade.js';
import { cleanup, init, mapx, mapxResult, query, workspace } from './helpers/e2e.js';

// M2-23: PHP files under database/ (migrations, seeders, factories) and resources/views/ (plain PHP
// and Blade) were indexed, when included, with no edges at all: the parser dropped every reference
// of a migration, seeder or factory, and returned nothing for a .blade.php file. They now give the
// edges that name a class; a method called by name on a variable (`$table->id()`, `$order->name()`)
// is still no edge, since it would link every method of that name in the project. Whether the
// directories are indexed at all stays the documented laravelDefaultExcludes default.
type Edge = { source_symbol: string | null; edge_type: string; target_file: string; target_symbol: string };

/** `source_symbol -> file#symbol (type)` of every edge from one file, sorted and unique. */
function edges(root: string, file: string): string[] {
  return [...new Set(query<Edge>(root, `SELECT source_symbol, edge_type, target_file, target_symbol FROM edges
    WHERE source_file = ? ORDER BY 1, 2, 3, 4`, file)
    .map((e) => `${e.source_symbol ?? '-'} -> ${e.target_file}#${e.target_symbol} (${e.edge_type})`))];
}
/** The files an edge from `file` reaches, whatever its type. */
function reaches(root: string, file: string): string[] {
  return [...new Set(query<{ target_file: string }>(root, 'SELECT target_file FROM edges WHERE source_file = ? ORDER BY 1', file).map((e) => e.target_file))];
}

const MODEL = (name: string, body = '') => `<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass ${name} extends Model\n{\n${body}}\n`;

const FILES: Record<string, string> = {
  'composer.json': JSON.stringify({
    require: { 'laravel/framework': '^11.0' },
    autoload: { 'psr-4': { 'App\\': 'app/', 'Database\\Factories\\': 'database/factories/', 'Database\\Seeders\\': 'database/seeders/' } },
  }),
  artisan: '#!/usr/bin/env php\n<?php\n',
  'app/Models/Order.php': MODEL('Order', '    public function total() { return 1; }\n'),
  'app/Models/User.php': MODEL('User'),
  // Named only where Blade never evaluates it (a comment, @verbatim, an escaped echo): never linked.
  'app/Models/Ghost.php': MODEL('Ghost', '    public static function comment() {}\n    public static function verbatim() {}\n    public static function escaped() {}\n'),
  'app/Services/Mailer.php': '<?php\nnamespace App\\Services;\nclass Mailer {}\n',
  // Methods that share a name with Eloquent builder and view helpers: a call by name must never reach them.
  'app/Services/Pricing.php': [
    '<?php', 'namespace App\\Services;', 'class Pricing', '{',
    '    public function id() { return 1; }', '    public function string() { return 1; }', '    public function name() { return 1; }',
    '    public function count() { return 1; }', '    public function create() { return 1; }', '    public function run() { return 1; }',
    '    public function save() { return 1; }', '    public static function fmt($x) { return $x; }', '}', ''].join('\n'),
  // An anonymous migration, over several lines: a data step names a model; the column calls name nothing.
  'database/migrations/2024_01_01_000000_create_orders_table.php': [
    '<?php',
    'use App\\Models\\Order;',
    'use Illuminate\\Database\\Migrations\\Migration;',
    'use Illuminate\\Database\\Schema\\Blueprint;',
    'use Illuminate\\Support\\Facades\\Schema;',
    '',
    'return new class extends Migration',
    '{',
    '    public function up(): void',
    '    {',
    "        Schema::create('orders', function (Blueprint $table) {",
    '            $table->id();',
    "            $table->string('name');",
    "            $table->integer('count');",
    '        });',
    '        Order::query()->update([]);',
    '    }',
    '',
    '    public function down(): void',
    '    {',
    "        Schema::dropIfExists('orders');",
    '    }',
    '};',
    '',
  ].join('\n'),
  // The pre-Laravel-9 form: a named class, a fully qualified model, a `::class` in a data step.
  'database/migrations/2024_02_01_000000_backfill_users.php': [
    '<?php',
    'use Illuminate\\Database\\Migrations\\Migration;',
    '',
    'class BackfillUsers extends Migration',
    '{',
    '    public function up()',
    '    {',
    '        \\App\\Models\\User::query()->count();',
    '        $this->touch(\\App\\Models\\Order::class);',
    '    }',
    '    public function touch($c) { return $c; }',
    '}',
    '',
  ].join('\n'),
  'database/factories/OrderFactory.php': [
    '<?php', 'namespace Database\\Factories;', '', 'use App\\Models\\Order;', 'use Illuminate\\Database\\Eloquent\\Factories\\Factory;', '',
    'class OrderFactory extends Factory', '{', '    protected $model = Order::class;', '',
    '    public function definition(): array', '    {', "        return ['total' => 1];", '    }', '}', ''].join('\n'),
  // A factory that names its model without a `use`: the class of another namespace, written in full.
  'database/factories/UserFactory.php': [
    '<?php', 'namespace Database\\Factories;', '', 'use Illuminate\\Database\\Eloquent\\Factories\\Factory;', '',
    'class UserFactory extends Factory', '{', '    protected $model = \\App\\Models\\User::class;', '',
    '    public function definition(): array', '    {', "        return ['name' => 'x'];", '    }', '}', ''].join('\n'),
  // A seeder calling a factory by class, and other seeders by `::class`, in the same namespace and with no `use`.
  'database/seeders/DatabaseSeeder.php': [
    '<?php', 'namespace Database\\Seeders;', '', 'use Illuminate\\Database\\Seeder;', '',
    'class DatabaseSeeder extends Seeder', '{', '    public function run(): void', '    {',
    '        $this->call([OrderSeeder::class]);', '        $this->call(UserSeeder::class);', '    }', '}', ''].join('\n'),
  'database/seeders/OrderSeeder.php': [
    '<?php', 'namespace Database\\Seeders;', '', 'use App\\Models\\Order;', 'use Database\\Factories\\OrderFactory;', 'use Illuminate\\Database\\Seeder;', '',
    'class OrderSeeder extends Seeder', '{', '    public function run(): void', '    {',
    '        OrderFactory::new()->count(3)->create();', '        (new Order())->save();', '        $this->name();', '    }', '',
    '    private function name() { return 1; }', '}', ''].join('\n'),
  'database/seeders/UserSeeder.php': [
    '<?php', 'namespace Database\\Seeders;', '', 'use Illuminate\\Database\\Seeder;', '',
    'class UserSeeder extends Seeder', '{', '    public function run(): void', '    {',
    '        \\Database\\Factories\\UserFactory::new()->create();', '    }', '}', ''].join('\n'),
  // A Blade view: PHP blocks, echoes, @use and @inject name classes; comments, @verbatim and an escaped
  // echo name nothing; a method called on a view variable links nothing by name.
  'resources/views/orders/index.blade.php': [
    '{{-- \\App\\Models\\Ghost::comment()',
    '     a comment over two lines --}}',
    '@php use App\\Models\\Order; @endphp',
    '@use(\'App\\Services\\Pricing\')',
    '@inject(\'mailer\', \'App\\Services\\Mailer\')',
    '<ul>',
    '@foreach ($orders as $order)',
    '  <li>{{ $order->name() }} {{ $order->count() }}</li>',
    '@endforeach',
    '</ul>',
    '<p>{{ \\App\\Models\\User::count() }}</p>',
    '<p>{!! Pricing::fmt(Order::count()) !!}</p>',
    '@verbatim {{ \\App\\Models\\Ghost::verbatim() }} @endverbatim',
    '<p>@{{ \\App\\Models\\Ghost::escaped() }}</p>',
    '@php',
    '  $latest = \\App\\Models\\Order::query()->first();',
    '@endphp',
    '',
  ].join('\n'),
  // A plain PHP view.
  'resources/views/plain.php': '<?php use App\\Models\\Order; ?>\n<p><?= Order::count() ?></p>\n<p><?= $x->name() ?></p>\n',
  // A view with nothing to link: no PHP of its own.
  'resources/views/welcome.blade.php': '<h1>{{ $title }}</h1>\n@if ($x)\n<p>@lang(\'hi\')</p>\n@endif\n',
};

describe('Laravel database/ and resources/views/ PHP files give edges (M2-23)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(FILES);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('indexes the migrations, seeders, factories and views of a Laravel app that declined the default excludes', () => {
    const indexed = query<{ path: string }>(root, "SELECT path FROM files WHERE path LIKE 'database/%' OR path LIKE 'resources/%'").map((f) => f.path);
    expect(indexed).toEqual(expect.arrayContaining([
      'database/migrations/2024_01_01_000000_create_orders_table.php',
      'database/migrations/2024_02_01_000000_backfill_users.php',
      'database/factories/OrderFactory.php',
      'database/seeders/DatabaseSeeder.php',
      'resources/views/orders/index.blade.php',
      'resources/views/plain.php',
    ]));
    // `mapx init` adds `**/migrations/**` for a PHP project, but not to a Laravel one that kept its migrations.
    const config = JSON.parse(readFileSync(join(root, '.mapx', 'config.json'), 'utf8'));
    expect(config.settings.excludePatterns).not.toContain('**/migrations/**');
  });

  it('a migration calling a model gives its edges: the anonymous class and the named one', () => {
    const anonymous = edges(root, 'database/migrations/2024_01_01_000000_create_orders_table.php');
    expect(anonymous).toContain('- -> app/Models/Order.php#App\\Models\\Order (import)');
    expect(anonymous.some((e) => e.includes('app/Models/Order.php#App\\Models\\Order (call)'))).toBe(true);
    // Schema, Blueprint and Migration are the framework's: not a project edge.
    expect(reaches(root, 'database/migrations/2024_01_01_000000_create_orders_table.php')).toEqual(['app/Models/Order.php']);

    const named = edges(root, 'database/migrations/2024_02_01_000000_backfill_users.php');
    expect(named).toContain('BackfillUsers::up -> app/Models/User.php#App\\Models\\User (call)');
    expect(named.some((e) => e.includes('app/Models/Order.php#App\\Models\\Order'))).toBe(true);
    // `$this->touch(...)` is the migration's own method.
    expect(named).toContain('BackfillUsers::up -> database/migrations/2024_02_01_000000_backfill_users.php#touch (call)');
    expect(reaches(root, 'database/migrations/2024_02_01_000000_backfill_users.php')).toEqual(['app/Models/Order.php', 'app/Models/User.php', 'database/migrations/2024_02_01_000000_backfill_users.php']);
  });

  it('column calls by name never reach a project method of that name', () => {
    // Pricing declares id(), string(), count() and name(): `$table->id()` and the like are not its.
    for (const file of ['database/migrations/2024_01_01_000000_create_orders_table.php', 'database/seeders/OrderSeeder.php']) {
      expect(reaches(root, file)).not.toContain('app/Services/Pricing.php');
    }
  });

  it('a seeder calling a factory gives its edges', () => {
    const order = edges(root, 'database/seeders/OrderSeeder.php');
    expect(order).toContain('- -> database/factories/OrderFactory.php#Database\\Factories\\OrderFactory (import)');
    expect(order).toContain('OrderSeeder::run -> database/factories/OrderFactory.php#Database\\Factories\\OrderFactory (call)');
    expect(order).toContain('OrderSeeder::run -> app/Models/Order.php#App\\Models\\Order (instantiation)');
    // `$this->name()` is the seeder's own method; `(new Order())->save()` ends in Eloquent's vendor base, which
    // `Pricing::save` must not absorb; neither reaches Pricing::name or ::save.
    expect(order).toContain('OrderSeeder::run -> database/seeders/OrderSeeder.php#name (call)');
    expect(order.filter((e) => e.includes('Pricing') || e.includes('#save'))).toEqual([]);

    const user = edges(root, 'database/seeders/UserSeeder.php');
    expect(user).toContain('UserSeeder::run -> database/factories/UserFactory.php#Database\\Factories\\UserFactory (call)');
  });

  it('a seeder calling other seeders by ::class gives its edges, same namespace and no use', () => {
    expect(reaches(root, 'database/seeders/DatabaseSeeder.php')).toEqual(['database/seeders/OrderSeeder.php', 'database/seeders/UserSeeder.php']);
  });

  it('a factory gives an edge to its model, however its $model is written', () => {
    expect(reaches(root, 'database/factories/OrderFactory.php')).toEqual(['app/Models/Order.php']);
    expect(reaches(root, 'database/factories/UserFactory.php')).toEqual(['app/Models/User.php']);
  });

  it('keeps the symbols and the roles of migrations, seeders and factories', () => {
    const symbols = query<{ file_path: string; name: string; kind: string; metadata: string }>(root,
      "SELECT file_path, name, kind, metadata FROM symbols WHERE file_path LIKE 'database/%' AND kind IN ('class', 'method') ORDER BY file_path, name");
    const roles = Object.fromEntries(symbols.filter((s) => s.kind === 'class').map((s) => [s.name, JSON.parse(s.metadata).laravelRole]));
    expect(roles).toMatchObject({ BackfillUsers: 'migration', OrderFactory: 'factory', DatabaseSeeder: 'seeder', OrderSeeder: 'seeder' });
    expect(symbols.some((s) => s.file_path.endsWith('OrderSeeder.php') && s.name === 'run' && s.kind === 'method')).toBe(true);
  });

  it('a Blade view gives the edges of its PHP blocks, echoes, @use and @inject, and none for comments or by-name calls', () => {
    const view = edges(root, 'resources/views/orders/index.blade.php');
    expect(reaches(root, 'resources/views/orders/index.blade.php')).toEqual(['app/Models/Order.php', 'app/Models/User.php', 'app/Services/Mailer.php', 'app/Services/Pricing.php']);
    // `@php use X; @endphp` and `@use('X')` are imports; echoes and @php bodies are calls on the class.
    expect(view).toContain('- -> app/Models/Order.php#App\\Models\\Order (import)');
    expect(view).toContain('- -> app/Services/Pricing.php#App\\Services\\Pricing (import)');
    expect(view).toContain('- -> app/Models/User.php#App\\Models\\User (call)');
    expect(view).toContain('- -> app/Services/Pricing.php#App\\Services\\Pricing (call)');
    // `@inject('mailer', 'App\\Services\\Mailer')` names the class.
    expect(view).toContain('- -> app/Services/Mailer.php#App\\Services\\Mailer (import)');
  });

  it('a Blade edge carries the line of the Blade file, after comments, multi-line blocks and verbatim text', () => {
    const lines = Object.fromEntries(query<{ target_symbol: string; edge_type: string; metadata: string }>(root,
      "SELECT target_symbol, edge_type, metadata FROM edges WHERE source_file = 'resources/views/orders/index.blade.php'")
      .map((e) => [`${e.target_symbol.split('\\').at(-1)} ${e.edge_type}`, JSON.parse(e.metadata).startLine]));
    // `@php use Order`, `@use`, `@inject` on lines 3 to 5; the echoes on 11 and 12; `Order::query()` in the @php block on 16.
    expect(lines).toMatchObject({ 'Order import': 3, 'Pricing import': 4, 'Mailer import': 5, 'User call': 11 });
    const orderCalls = query<{ metadata: string }>(root,
      "SELECT metadata FROM edges WHERE source_file = 'resources/views/orders/index.blade.php' AND target_symbol = 'App\\Models\\Order' AND edge_type = 'call'")
      .map((e) => JSON.parse(e.metadata).startLine).sort();
    expect(orderCalls).toEqual([12, 16]);
  });

  it('a plain PHP view gives its edges, and a view with no PHP gives none', () => {
    expect(reaches(root, 'resources/views/plain.php')).toEqual(['app/Models/Order.php']);
    expect(reaches(root, 'resources/views/welcome.blade.php')).toEqual([]);
  });

  it('a Blade file never links the method of a view variable by name, nor a commented or escaped class', () => {
    const rows = query<{ target_file: string }>(root, "SELECT DISTINCT target_file FROM edges WHERE source_file LIKE 'resources/views/%'").map((r) => r.target_file);
    expect(rows).not.toContain('app/Models/Ghost.php');
    // `$order->count()` and `{{ $order->name() }}` would reach Pricing::count and Pricing::name by name.
    const byName = query<{ target_symbol: string }>(root,
      "SELECT target_symbol FROM edges WHERE source_file = 'resources/views/orders/index.blade.php' AND target_symbol IN ('count', 'name')");
    expect(byName).toEqual([]);
    const refs = query<{ specifier: string }>(root, "SELECT specifier FROM external_refs WHERE file_path LIKE 'resources/views/%'").map((r) => r.specifier);
    expect(refs.join(' ')).not.toContain('Ghost');
  });

  it('writing the same content back changes no edge (a rescan is stable)', () => {
    const before = JSON.stringify(query(root, "SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges WHERE source_file LIKE 'database/%' OR source_file LIKE 'resources/%' ORDER BY 1,2,3,4,5"));
    writeFileSync(join(root, 'database/seeders/UserSeeder.php'), FILES['database/seeders/UserSeeder.php']!);
    mapx(root, 'scan', root, '--force');
    const after = JSON.stringify(query(root, "SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges WHERE source_file LIKE 'database/%' OR source_file LIKE 'resources/%' ORDER BY 1,2,3,4,5"));
    expect(after).toBe(before);
  }, 60000);
});

// The point of it (found by M5-17-R1): the laravel preset's Database and Views rules are exercised.
// A copy of the preset's synthetic Laravel 11 app (tests/fixtures/arch-init/laravel11), where Database
// and Views may use Models only, gets a seeder and a view that use a controller.
describe('the laravel preset checks Database and Views (M2-23)', () => {
  let root: string;
  const violations = (stdout: string): string[] =>
    [...new Set((JSON.parse(stdout).findings as Array<{ kind: string; source?: { file: string }; target?: { file: string } }>)
      .filter((f) => f.kind === 'violation').map((f) => `${f.source!.file} → ${f.target!.file}`))].sort();

  beforeAll(() => {
    root = workspace({});
    cpSync(resolve(__dirname, 'fixtures/arch-init/laravel11'), root, { recursive: true });
    init(root);
    mapx(root, 'scan', root);
    expect(mapxResult(root, 'arch', 'init', '--preset', 'laravel', '--write').status).toBe(0);
  }, 120000);
  afterAll(() => cleanup(root));

  it('is clean but for the fixture\'s own planted violation, with the seeder, migration and view giving edges to Models', () => {
    const check = mapxResult(root, 'check', '--format', 'json');
    expect(violations(check.stdout)).toEqual(['app/Models/OrderItem.php → app/Http/Requests/StoreOrderRequest.php']);
    expect(reaches(root, 'database/seeders/DatabaseSeeder.php')).toEqual(['app/Models/Order.php']);
    expect(reaches(root, 'database/factories/OrderFactory.php')).toEqual(['app/Models/Order.php']);
    expect(reaches(root, 'resources/views/orders/index.blade.php')).toEqual(['app/Models/Order.php']);
  });

  it('a seeder, a migration and a view that use a controller are violations', () => {
    mkdirSync(join(root, 'database/seeders'), { recursive: true });
    writeFileSync(join(root, 'database/seeders/AuditSeeder.php'),
      '<?php\nnamespace Database\\Seeders;\nuse App\\Http\\Controllers\\OrderController;\nclass AuditSeeder\n{\n    public function run() { return OrderController::class; }\n}\n');
    writeFileSync(join(root, 'database/migrations/2024_03_01_000000_audit.php'),
      "<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nreturn new class extends Migration\n{\n    public function up(): void\n    {\n        (new \\App\\Http\\Controllers\\OrderController())->index();\n    }\n};\n");
    writeFileSync(join(root, 'resources/views/orders/audit.blade.php'), "@php use App\\Http\\Controllers\\OrderController; @endphp\n<p>{{ OrderController::class }}</p>\n");
    mapx(root, 'sync', root);
    const check = mapxResult(root, 'check', '--format', 'json');
    expect(check.status).toBe(1);
    expect(violations(check.stdout)).toEqual([
      'app/Models/OrderItem.php → app/Http/Requests/StoreOrderRequest.php',
      'database/migrations/2024_03_01_000000_audit.php → app/Http/Controllers/OrderController.php',
      'database/seeders/AuditSeeder.php → app/Http/Controllers/OrderController.php',
      'resources/views/orders/audit.blade.php → app/Http/Controllers/OrderController.php',
    ]);
  }, 120000);
});

// A method called on an object is kept in these files when the syntax gives its class (M2-23 review): a
// typed parameter or property, `$this`, `new X`. One whose class it does not give would link every
// method of that name in the project, so it stays out; so does a method of a migration, seeder or
// factory as the target of such a by-name call from another file.
describe('member calls in migrations, seeders, factories and views link the class the syntax gives (M2-23 review)', () => {
  let root: string;
  const MEMBERS: Record<string, string> = {
    'composer.json': FILES['composer.json']!,
    artisan: FILES['artisan']!,
    'app/Models/Order.php': MODEL('Order', '    public function total() { return 1; }\n'),
    'app/Services/Mailer.php': '<?php\nnamespace App\\Services;\nclass Mailer\n{\n    public function dispatchMail() {}\n    public function send() {}\n}\n',
    // Decoys sharing the names the seeder calls on objects it cannot type.
    'app/Services/Other.php': '<?php\nnamespace App\\Services;\nclass Other\n{\n    public function dispatchMail() {}\n    public function send() {}\n    public function helper2() {}\n    public function save() {}\n    public function total() {}\n}\n',
    // Untyped calls by name of the migrations', seeder's and factory's own method names.
    'app/Services/Svc.php': [
      '<?php', 'namespace App\\Services;', 'class Svc', '{', '    public function go($app, $m, $s, $f)', '    {',
      '        $app->down();', '        $m->up();', '        $s->run();', '        $f->definition();', '        $s->helperx();', '    }', '}', ''].join('\n'),
    'database/migrations/2024_01_01_000000_m1.php': '<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nreturn new class extends Migration\n{\n    public function up(): void {}\n    public function down(): void {}\n    public function helperx(): void {}\n};\n',
    'database/migrations/2024_01_02_000000_m2.php': '<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nclass M2 extends Migration\n{\n    public function up(): void {}\n    public function down(): void {}\n}\n',
    'database/factories/UFactory.php': '<?php\nnamespace Database\\Factories;\nuse Illuminate\\Database\\Eloquent\\Factories\\Factory;\nclass UFactory extends Factory\n{\n    public function definition(): array { return []; }\n}\n',
    'database/seeders/NS.php': [
      '<?php',                                                    // 1
      'namespace Database\\Seeders;',                             // 2
      'use App\\Models\\Order;',                                  // 3
      'use App\\Services\\Mailer;',                               // 4
      'use Illuminate\\Database\\Seeder;',                        // 5
      'class NS extends Seeder',                                  // 6
      '{',                                                        // 7
      '    public function __construct(private Mailer $mailer) {}', // 8
      '    public function run(Mailer $m, $any, ?Mailer $r): void', // 9
      '    {',                                                    // 10
      '        $m->send();',                                      // 11
      '        $this->mailer->dispatchMail();',                   // 12
      '        $this->helper2();',                                // 13
      '        (new Mailer())->dispatchMail();',                  // 14
      '        $any->dispatchMail();',                            // 15
      '        (new Order())->save();',                           // 16
      '        Order::query()->where(1)->total();',               // 17
      '        $r = $any;',                                       // 18
      '        $r->send();',                                      // 19
      '        $this->call(Order::class);',                       // 20
      '    }',                                                    // 21
      '',
      '    public function helper2() {}',                             // 23
      '    private ?Mailer $typed = null;',                       // 24
      '    public function more(?Mailer $o)',                     // 25
      '    {',                                                    // 26
      '        $this->typed->send();',                            // 27
      '        $fn = function () use ($o) { $o->dispatchMail(); };', // 28
      '        $arrow = fn() => $o->send();',                     // 29
      '        $untyped = fn($z) => $z->send();',                 // 30
      '    }',
      '}', ''].join('\n'),
    // A view is no class: `$this` and `$x` name nothing the syntax gives.
    'resources/views/v.php': '<?php use App\\Models\\Order; ?>\n<p><?= $this->helper() ?> <?= $x->send() ?> <?= Order::count() ?></p>\n',
  };
  beforeAll(() => {
    root = workspace(MEMBERS);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const calls = (file: string) => query<{ source_symbol: string | null; target_file: string; target_symbol: string; verifiability: string; metadata: string }>(root,
    "SELECT source_symbol, target_file, target_symbol, verifiability, metadata FROM edges WHERE source_file = ? AND edge_type = 'call' ORDER BY json_extract(metadata, '$.startLine'), target_symbol", file)
    .map((e) => `${JSON.parse(e.metadata).startLine} ${e.source_symbol} -> ${e.target_file}#${e.target_symbol} ${e.verifiability}`);

  it('a typed parameter, a typed property, $this and new X give their method, verified', () => {
    expect(calls('database/seeders/NS.php')).toEqual([
      '11 NS::run -> app/Services/Mailer.php#send verified',
      '12 NS::run -> app/Services/Mailer.php#dispatchMail verified',
      '13 NS::run -> database/seeders/NS.php#helper2 verified',
      '14 NS::run -> app/Services/Mailer.php#dispatchMail verified',
      '17 NS::run -> app/Models/Order.php#App\\Models\\Order verified',
      // A typed property, and a nullable parameter read by a closure (`use`) and by an arrow function.
      '27 NS::more -> app/Services/Mailer.php#send verified',
      '28 NS::more -> app/Services/Mailer.php#dispatchMail verified',
      '29 NS::more -> app/Services/Mailer.php#send verified',
    ]);
  });

  it('an untyped receiver, a reassigned parameter and a chain end in no by-name edge', () => {
    // Lines 15 (`$any`), 16 (`(new Order())->save()`, past Eloquent's vendor base), 17 (`->total()`) and 19 (`$r` reassigned).
    expect(reaches(root, 'database/seeders/NS.php')).not.toContain('app/Services/Other.php');
    expect(calls('database/seeders/NS.php').filter((c) => /^(15|19) /.test(c) || /#(save|total)\b/.test(c))).toEqual([]);
  });

  it('a view names no class for $this or a variable: no by-name edge', () => {
    expect(edges(root, 'resources/views/v.php').filter((e) => /#(helper|send)\b/.test(e))).toEqual([]);
    expect(reaches(root, 'resources/views/v.php')).toEqual(['app/Models/Order.php']);
  });

  it('a method of a migration, seeder or factory is no by-name target of a call in another file', () => {
    // `$app->down()`, `$m->up()`, `$s->run()`, `$f->definition()`, `$s->helperx()`: nothing in app/ names their class.
    expect(reaches(root, 'app/Services/Svc.php').filter((f) => f.startsWith('database/'))).toEqual([]);
    // Nor after a sync, which reads the stored symbols, not the parsed ones.
    writeFileSync(join(root, 'app/Services/Svc.php'), `${MEMBERS['app/Services/Svc.php']}\n// edited\n`);
    mapx(root, 'sync', root);
    expect(reaches(root, 'app/Services/Svc.php').filter((f) => f.startsWith('database/'))).toEqual([]);
  });
});

// The Blade conversion, one piece per view (M2-23 review): each view names `User` or `Order` where
// Blade evaluates it and `Ghost` where it does not, so a piece read wrongly adds or loses an edge.
describe('Blade views are read as Blade does (M2-23 review)', () => {
  let root: string;
  const view = (body: string) => body;
  const BLADE: Record<string, string> = {
    'composer.json': FILES['composer.json']!,
    artisan: FILES['artisan']!,
    'app/Models/Order.php': MODEL('Order', '    public static function count() {}\n    public function save() {}\n'),
    'app/Models/User.php': MODEL('User', '    public static function count() {}\n    public static function first() {}\n'),
    'app/Models/Ghost.php': MODEL('Ghost', '    public static function x() {}\n'),
    // An address in the text: its `@php` is no directive, so the comment after it stays a comment.
    'resources/views/email.blade.php': view('<footer>webmaster@php.net</footer>\n{{-- \\App\\Models\\Ghost::x() --}}\n<p>{{ \\App\\Models\\Order::count() }}</p>\n'),
    // `@php`, a newline, then `(`: a block, not the one-statement form.
    'resources/views/block.blade.php': view('@php\n    (new \\App\\Models\\Order)->save();\n    $a = \\App\\Models\\User::first();\n@endphp\n'),
    'resources/views/triple.blade.php': view('<p>x</p>\n<p>{{{ \\App\\Models\\User::count() }}}</p>\n'),
    'resources/views/inline.blade.php': view('<p>x</p>\n@php($u = \\App\\Models\\User::first())\n{{-- \\App\\Models\\Ghost::x() --}}\n<p>{{ \\App\\Models\\Order::count() }}</p>\n'),
    'resources/views/escape.blade.php': view('@@php \\App\\Models\\Ghost::x(); @@endphp\n<p>{{ \\App\\Models\\User::count() }}</p>\n'),
    'resources/views/alias.blade.php': view('@use(\'App\\Models\\Order\', \'O\')\n<p>{{ O::count() }}</p>\n'),
    'resources/views/verb.blade.php': view('@verbatim\n@php \\App\\Models\\Ghost::x(); @endphp\n@endverbatim\n<p>{{ \\App\\Models\\User::count() }}</p>\n'),
    'resources/views/crlf.blade.php': view('{{-- one\r\n two --}}\r\n@php use App\\Models\\Order; @endphp\r\n<p>{{ \\App\\Models\\User::count() }}</p>\r\n@php\r\n  $x = Order::count();\r\n@endphp\r\n'),
  };
  beforeAll(() => {
    root = workspace(BLADE);
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  /** `line type target` of every edge of a view, sorted. */
  const lines = (file: string) => query<{ target_symbol: string; edge_type: string; metadata: string }>(root,
    'SELECT target_symbol, edge_type, metadata FROM edges WHERE source_file = ?', file)
    .map((e) => `${JSON.parse(e.metadata).startLine} ${e.edge_type} ${e.target_symbol.split('\\').at(-1)}`).sort();

  it('an address with @php in it is text: what follows is still read as Blade', () => {
    expect(lines('resources/views/email.blade.php')).toEqual(['3 call Order']);
  });

  it('@php, a newline and a parenthesis is a block', () => {
    expect(lines('resources/views/block.blade.php')).toEqual(['2 call save', '2 instantiation Order', '3 call User']);
  });

  it('{{{ }}} is an echo', () => {
    expect(lines('resources/views/triple.blade.php')).toEqual(['2 call User']);
  });

  it('@php(...) is one statement: the comment after it is still a comment', () => {
    expect(lines('resources/views/inline.blade.php')).toEqual(['2 call User', '4 call Order']);
  });

  it('@@ escapes a directive', () => {
    expect(lines('resources/views/escape.blade.php')).toEqual(['2 call User']);
  });

  it('@use with an alias binds the alias', () => {
    expect(lines('resources/views/alias.blade.php')).toEqual(['1 import Order', '2 call Order']);
  });

  it('@php inside @verbatim is text', () => {
    expect(lines('resources/views/verb.blade.php')).toEqual(['4 call User']);
  });

  it('a view with CRLF line ends gives each edge on its own line', () => {
    expect(lines('resources/views/crlf.blade.php')).toEqual(['3 import Order', '4 call User', '6 call Order']);
  });
});

// The conversion itself. The PHP grammar recovers from a stray `{` or from Blade text read as PHP, so an
// edge does not always show a piece read wrongly; the converted text does.
describe('bladeToPhp (M2-23 review)', () => {
  it('turns {{ }}, {!! !!} and {{{ }}} into echoes of exactly their expression', () => {
    expect(bladeToPhp('{{ $a }}|{!! $b !!}|{{{ $c }}}')).toBe('<?php echo  $a ; ?>|<?php echo  $b ; ?>|<?php echo  $c ; ?>');
  });
  it('turns @php(...) into one statement and @php ... @endphp into a block', () => {
    expect(bladeToPhp('@php($x = 1) text')).toBe('<?php $x = 1; ?> text');
    expect(bladeToPhp('@php\n$y = 2;\n@endphp text')).toBe('<?php \n$y = 2;\n ?> text');
    // A newline before the parenthesis is a block, as in Blade; spaces and tabs are not.
    expect(bladeToPhp('@php\n($y = 2);\n@endphp')).toBe('<?php \n($y = 2);\n ?>');
    expect(bladeToPhp('@php \t($z = 3)')).toBe('<?php $z = 3; ?>');
  });
  it('keeps an escaped @@ and an address as text, and reads a directive after a non-word character', () => {
    expect(bladeToPhp('@@php x @@endphp')).toBe('@@php x @@endphp');
    expect(bladeToPhp('a@php.net')).toBe('a@php.net');
    expect(bladeToPhp('<p>@php($a = 1)</p>')).toBe('<p><?php $a = 1; ?></p>');
  });
  it('binds an @use alias and names an @inject class', () => {
    expect(bladeToPhp("@use('App\\Models\\Order', 'O')")).toBe('<?php use App\\Models\\Order as O; ?>');
    expect(bladeToPhp("@inject('m', 'App\\Services\\Mailer')")).toBe('<?php \\App\\Services\\Mailer::class; ?>');
  });
  it('keeps every line of the source, CRLF included', () => {
    const source = '{{-- a\r\nb --}}\r\n@php use X; @endphp\r\n@verbatim\r\n@php y @endphp\r\n@endverbatim\r\n{{ $c }}\r\n';
    const lines = (t: string) => t.split('\n').length;
    expect(lines(bladeToPhp(source))).toBe(lines(source));
    expect(bladeToPhp(source).split('\n').findIndex((l) => l.includes('echo'))).toBe(6);
  });
});
