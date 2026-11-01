import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace, useParseWorkers } from './helpers/e2e.js';

// These scans exercise the parse workers; test projects are below the automatic break-even (M4-13).
useParseWorkers(4);

// M0-04-R1: PHP name resolution — use imports as edges, own-namespace resolution, facades vs
// imports, Request/Response as classes, qualified names in extends/implements/new.
describe('PHP name resolution through the scanner', () => {
  let root: string;
  beforeAll(() => {
    const cls = (ns: string, name: string, extra = '') => `<?php\nnamespace ${ns};\n${extra}class ${name} {}\n`;
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Services/UserService.php': cls('App\\Services', 'UserService'),
      'app/Support/Cache.php': cls('App\\Support', 'Cache'),
      'app/Models/Event.php': cls('App\\Models', 'Event'),
      'app/Models/Role.php': cls('App\\Models', 'Role'),
      'app/Admin/Role.php': cls('App\\Admin', 'Role'),
      'app/Http/Response.php': cls('App\\Http', 'Response'),
      'app/Other/Z.php': cls('App\\Other', 'Z'),
      'app/Contracts/Foo.php': '<?php\nnamespace App\\Contracts;\ninterface Foo {}\n',
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nclass User { public function roles() { return $this->belongsToMany(Role::class); } }\n',
      'app/Http/Controllers/A.php': [
        '<?php',
        'namespace App\\Http\\Controllers;',
        'use App\\Services\\UserService;',
        'use App\\Support\\Cache;',
        'use App\\Models\\Event;',
        'use App\\Http\\Response;',
        'use App\\Contracts;',
        'use Illuminate\\Support\\Facades\\Log;',
        'class A extends \\App\\Other\\Z implements Contracts\\Foo {',
        "  public function h(UserService $s): Response { new Cache(); Event::create(); Log::info('x'); return new Response(); }",
        '}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const edges = (source: string, type: string) =>
    query<{ target_file: string; target_symbol: string }>(root, 'SELECT target_file, target_symbol FROM edges WHERE source_file = ? AND edge_type = ? ORDER BY target_file', source, type);
  const A = 'app/Http/Controllers/A.php';

  it('turns use statements into import edges to the PSR-4 files', () => {
    // Exactly these: `use App\Contracts` names a namespace and the Log facade is vendor code (M0-04-R2).
    expect(edges(A, 'import').map((e) => `${e.target_file} ${e.target_symbol}`)).toEqual([
      'app/Http/Response.php App\\Http\\Response',
      'app/Models/Event.php App\\Models\\Event',
      'app/Services/UserService.php App\\Services\\UserService',
      'app/Support/Cache.php App\\Support\\Cache',
    ]);
  });

  it('resolves a same-namespace short name to its own namespace, not a homonym', () => {
    expect(edges('app/Models/User.php', 'relation').map((e) => e.target_file)).toEqual(['app/Models/Role.php']);
  });

  it('never rewrites an imported class to a facade, but still rewrites real facades', () => {
    const inst = edges(A, 'instantiation').map((e) => e.target_symbol);
    expect(inst).toEqual(expect.arrayContaining(['App\\Support\\Cache', 'App\\Http\\Response']));
    expect(inst.join()).not.toMatch(/CacheManager|ResponseFactory/);
    const calls = edges(A, 'call').map((e) => `${e.target_symbol}`);
    expect(calls).toContain('App\\Models\\Event');
    expect(calls.join()).not.toContain('Dispatcher');
    const all = query<{ target_symbol: string }>(root, "SELECT target_symbol FROM edges WHERE source_file = ?", A).map((e) => e.target_symbol);
    expect(all.join()).not.toMatch(/Illuminate\\Events/);
  });

  it('keeps app classes named Response as return types', () => {
    expect(edges(A, 'return_type').map((e) => e.target_file)).toEqual(['app/Http/Response.php']);
  });

  it('captures qualified names in extends and implements', () => {
    expect(edges(A, 'extends').map((e) => e.target_file)).toEqual(['app/Other/Z.php']);
    expect(edges(A, 'implements').map((e) => e.target_file)).toEqual(['app/Contracts/Foo.php']);
  });
});

// M0-04-R2: on a stock Laravel skeleton, `Illuminate\…` names never resolve to app files. A
// two-segment path suffix made `use Illuminate\Foundation\Http\Kernel as HttpKernel` a verified
// import of app/Http/Kernel.php itself, and the short-name fallback made `extends HttpKernel` a
// self-edge. Synthetic files modelled on the public laravel/laravel skeleton (no pilot code).
describe('PHP resolution on a stock Laravel skeleton', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'composer.json': JSON.stringify({
        name: 'laravel/laravel',
        autoload: { 'psr-4': { 'App\\': 'app/', 'Database\\Factories\\': 'database/factories/' } },
        'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
      }, null, 2),
      'app/Http/Kernel.php': [
        '<?php',
        'namespace App\\Http;',
        'use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;',
        'class Kernel extends HttpKernel',
        '{',
        '    protected $middleware = [',
        '        \\App\\Http\\Middleware\\TrustProxies::class,',
        '        \\Illuminate\\Http\\Middleware\\HandleCors::class,',
        '    ];',
        '    protected $middlewareAliases = [',
        "        'auth' => \\App\\Http\\Middleware\\Authenticate::class,",
        "        'verified' => \\Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified::class,",
        '    ];',
        '}',
      ].join('\n'),
      'app/Http/Middleware/TrustProxies.php': '<?php\nnamespace App\\Http\\Middleware;\nuse Illuminate\\Http\\Middleware\\TrustProxies as Middleware;\nclass TrustProxies extends Middleware {}\n',
      'app/Http/Middleware/Authenticate.php': [
        '<?php',
        'namespace App\\Http\\Middleware;',
        'use Illuminate\\Auth\\Middleware\\Authenticate as Middleware;',
        'use Illuminate\\Http\\Request;',
        'class Authenticate extends Middleware',
        '{',
        '    protected function redirectTo(Request $request): ?string',
        '    {',
        "        return $request->expectsJson() ? null : route('login');",
        '    }',
        '}',
      ].join('\n'),
      'app/Providers/EventServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use Illuminate\\Auth\\Events\\Registered;',
        'use Illuminate\\Auth\\Listeners\\SendEmailVerificationNotification;',
        'use Illuminate\\Foundation\\Support\\Providers\\EventServiceProvider as ServiceProvider;',
        'use Illuminate\\Support\\Facades\\Event;',
        'class EventServiceProvider extends ServiceProvider',
        '{',
        '    protected $listen = [',
        '        Registered::class => [',
        '            SendEmailVerificationNotification::class,',
        '        ],',
        '    ];',
        '    public function boot(): void {}',
        '}',
      ].join('\n'),
      'app/Exceptions/Handler.php': [
        '<?php',
        'namespace App\\Exceptions;',
        'use Illuminate\\Foundation\\Exceptions\\Handler as ExceptionHandler;',
        'use Throwable;',
        'class Handler extends ExceptionHandler',
        '{',
        '    public function register(): void { $this->reportable(function (Throwable $e) {}); }',
        '}',
      ].join('\n'),
      'app/Console/Kernel.php': '<?php\nnamespace App\\Console;\nuse Illuminate\\Console\\Scheduling\\Schedule;\nuse Illuminate\\Foundation\\Console\\Kernel as ConsoleKernel;\nclass Kernel extends ConsoleKernel\n{\n    protected function schedule(Schedule $schedule): void {}\n}\n',
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Foundation\\Auth\\User as Authenticatable;\nuse Illuminate\\Notifications\\Notifiable;\nclass User extends Authenticatable\n{\n    use Notifiable;\n}\n',
      'app/Http/Controllers/Controller.php': '<?php\nnamespace App\\Http\\Controllers;\nuse Illuminate\\Routing\\Controller as BaseController;\nabstract class Controller extends BaseController {}\n',
      // App classes sharing their last two segments with framework names: Events/Registered, Support/Collection.
      'app/Events/Registered.php': '<?php\nnamespace App\\Events;\nclass Registered {}\n',
      'app/Support/Collection.php': '<?php\nnamespace App\\Support;\nclass Collection {}\n',
      'app/Http/Controllers/UserController.php': [
        '<?php',
        'namespace App\\Http\\Controllers;',
        'use App\\Models\\User;',
        'use App\\Support\\Collection as AppCollection;',
        'use Illuminate\\Support\\Collection;',
        'class UserController extends Controller',
        '{',
        '    public function index(): Collection { new AppCollection(); return new Collection([User::first()]); }',
        '}',
      ].join('\n'),
      'routes/web.php': [
        '<?php',
        'use App\\Http\\Controllers\\UserController;',
        'use Illuminate\\Support\\Facades\\Route;',
        "Route::get('/users', [UserController::class, 'index'])->middleware(['auth', 'verified']);",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  type Row = { source_file: string; target_file: string; target_symbol: string; edge_type: string };
  const all = () => query<Row>(root, 'SELECT source_file, target_file, target_symbol, edge_type FROM edges');

  it('links only app classes by import, exactly', () => {
    const imports = all().filter((e) => e.edge_type === 'import').map((e) => `${e.source_file} → ${e.target_file} ${e.target_symbol}`).sort();
    expect(imports).toEqual([
      'app/Http/Controllers/UserController.php → app/Models/User.php App\\Models\\User',
      'app/Http/Controllers/UserController.php → app/Support/Collection.php App\\Support\\Collection',
      'routes/web.php → app/Http/Controllers/UserController.php App\\Http\\Controllers\\UserController',
    ]);
  });

  it('never resolves an Illuminate name to an app file, and makes no self-edges from framework names', () => {
    const illuminate = all().filter((e) => e.target_symbol?.startsWith('Illuminate\\')).map((e) => `${e.source_file} ${e.edge_type} ${e.target_symbol} → ${e.target_file}`);
    expect(illuminate).toEqual([]);
    const selfEdges = all().filter((e) => e.source_file === e.target_file && e.edge_type !== 'call').map((e) => `${e.source_file} ${e.edge_type} ${e.target_symbol}`);
    expect(selfEdges).toEqual([]);
  });

  it('still links app classes: extends, instantiation and the app middleware', () => {
    const uc = all().filter((e) => e.source_file === 'app/Http/Controllers/UserController.php' && e.edge_type !== 'import' && e.edge_type !== 'call')
      .map((e) => `${e.edge_type} ${e.target_file} ${e.target_symbol}`).sort();
    expect(uc).toEqual([
      'extends app/Http/Controllers/Controller.php App\\Http\\Controllers\\Controller',
      'instantiation app/Support/Collection.php App\\Support\\Collection',
    ]);
    const middleware = all().filter((e) => e.source_file === 'routes/web.php' && e.edge_type === 'middleware').map((e) => `${e.target_file} ${e.target_symbol}`);
    expect(middleware).toEqual(['app/Http/Middleware/Authenticate.php App\\Http\\Middleware\\Authenticate']);
  });
});

// M0-04-R2: `use App\Billing\Invoice; new Invoice()` resolved to app/Models/Invoice.php (verified).
describe('a use-imported FQN with no matching file', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Models/Invoice.php': '<?php\nnamespace App\\Models;\nclass Invoice {}\n',
      'app/Contracts/Payable.php': '<?php\nnamespace App\\Contracts;\ninterface Payable {}\n',
      'app/Http/Controllers/BillingController.php': [
        '<?php',
        'namespace App\\Http\\Controllers;',
        'use App\\Billing\\Invoice;',
        'use App\\Billing\\Contracts\\Payable;',
        'use App\\Models\\Invoice as Stored;',
        'class BillingController implements Payable',
        '{',
        '    public function store(Invoice $i): Invoice { Invoice::create(); new Stored(); return new Invoice(); }',
        '}',
      ].join('\n'),
      // `use function` / `use const` must not shadow the own-namespace class Money.
      'app/Http/Controllers/Money.php': '<?php\nnamespace App\\Http\\Controllers;\nclass Money {}\n',
      'app/Helpers/functions.php': '<?php\nnamespace App\\Helpers;\nfunction Money() {}\nconst Limit = 1;\n',
      'app/Http/Controllers/PriceController.php': [
        '<?php',
        'namespace App\\Http\\Controllers;',
        'use function App\\Helpers\\Money;',
        'use const App\\Helpers\\Limit;',
        'class PriceController',
        '{',
        '    public function show() { return new Money(); }',
        '}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('resolves to nothing rather than to a homonym in another namespace', () => {
    const rows = query<{ edge_type: string; target_file: string; target_symbol: string }>(root,
      "SELECT edge_type, target_file, target_symbol FROM edges WHERE source_file = 'app/Http/Controllers/BillingController.php'")
      .map((e) => `${e.edge_type} ${e.target_file} ${e.target_symbol}`).sort();
    // Only the aliased App\Models\Invoice links (import and instantiation); no composer.json here.
    expect(rows).toEqual([
      'import app/Models/Invoice.php App\\Models\\Invoice',
      'instantiation app/Models/Invoice.php App\\Models\\Invoice',
    ]);
  });

  it('keeps use function / use const out of the class table', () => {
    const rows = query<{ edge_type: string; target_file: string; target_symbol: string }>(root,
      "SELECT edge_type, target_file, target_symbol FROM edges WHERE source_file = 'app/Http/Controllers/PriceController.php' AND edge_type = 'instantiation'")
      .map((e) => `${e.target_file} ${e.target_symbol}`);
    expect(rows).toEqual(['app/Http/Controllers/Money.php App\\Http\\Controllers\\Money']);
  });
});

// M0-04-R5: global function calls and require/include gave zero edges (no query capture for
// function calls; include patterns needed parentheses; `require` went to the namespace resolver).
describe('PHP function calls and includes', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'helpers.php': "<?php\n\nfunction helper_fmt($n)\n{\n    return strlen((string) $n);\n}\n",
      'lib/util.php': "<?php\n\nfunction util_join(array $a)\n{\n    return implode(',', array_map('trim', $a));\n}\n",
      'bootstrap/boot.php': '<?php\n',
      'public/index.php': [
        '<?php',
        "require dirname(__DIR__) . '/bootstrap/boot.php';",
        "require __DIR__ . '/../missing.php';",
      ].join('\n'),
      'main.php': [
        '<?php',
        'require_once "helpers.php";',
        'include __DIR__ . "/lib/util.php";',
        "require_once('bootstrap/boot.php');",
        '',
        'function run()',
        '{',
        '    return helper_fmt(1) . util_join([]) . strlen("x") . count([]);',
        '}',
        '',
        'class Runner',
        '{',
        '    public function count() { return 0; }',
        '    public function go()',
        '    {',
        '        return helper_fmt(2);',
        '    }',
        '}',
      ].join('\n'),
      // Namespaced functions: `fmt` in two namespaces, a global `fallback`, a method named `fmt`.
      'app/Support/functions.php': '<?php\nnamespace App\\Support;\n\nfunction fmt($v) { return $v; }\n',
      'app/Other/functions.php': '<?php\nnamespace App\\Other;\n\nfunction fmt($v) { return $v; }\nfunction local_only() { return 1; }\n',
      'app/global.php': '<?php\n\nfunction fallback() { return 1; }\nfunction local_only() { return 2; }\n',
      'app/Formatter.php': '<?php\nnamespace App;\n\nclass Formatter { public function fmt($v) { return $v; } }\n',
      'app/Http/Imported.php': [
        '<?php',
        'namespace App\\Http;',
        'use function App\\Support\\fmt;',
        'use function App\\Support\\{fmt as format};',
        'class Imported',
        '{',
        '    public function a() { return fmt(1); }',
        '    public function b() { return format(2); }',
        '    public function c() { return \\App\\Support\\fmt(3) . fallback(); }',
        '}',
      ].join('\n'),
      'app/Other/Caller.php': [
        '<?php',
        'namespace App\\Other;',
        'class Caller',
        '{',
        // Unqualified in App\Other: its own fmt and local_only win over the global local_only.
        '    public function b() { return fmt(1) . local_only() . namespace\\fmt(2); }',
        '}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  type Row = { source_file: string; source_symbol: string | null; target_file: string; target_symbol: string; edge_type: string };
  const rows = (where: string) => query<Row>(root, `SELECT DISTINCT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges WHERE ${where}`)
    .map((e) => `${e.source_file}#${e.source_symbol} -${e.edge_type}-> ${e.target_file}#${e.target_symbol}`).sort();

  it('links global function calls to the declaring file, from functions and methods', () => {
    expect(rows("source_file = 'main.php' AND edge_type = 'call'")).toEqual([
      'main.php#Runner::go -call-> helpers.php#helper_fmt',
      'main.php#run -call-> helpers.php#helper_fmt',
      'main.php#run -call-> lib/util.php#util_join',
    ]);
    // strlen / implode / array_map are built-ins, declared nowhere in the workspace; count() is
    // not Runner::count.
    expect(rows("source_file IN ('helpers.php', 'lib/util.php') AND edge_type = 'call'")).toEqual([]);
  });

  it('links require and include, in every form, to the resolved file', () => {
    expect(rows("edge_type IN ('require', 'import')")).toEqual([
      'main.php#null -require-> bootstrap/boot.php#bootstrap/boot.php',
      'main.php#null -require-> helpers.php#helpers.php',
      'main.php#null -require-> lib/util.php#__DIR__/lib/util.php',
      'public/index.php#null -require-> bootstrap/boot.php#__DIR__/../bootstrap/boot.php',
    ]);
  });

  it('resolves namespaced functions by namespace only, with the global fallback for unqualified names', () => {
    expect(rows("source_file IN ('app/Http/Imported.php', 'app/Other/Caller.php') AND edge_type = 'call'")).toEqual([
      'app/Http/Imported.php#Imported::a -call-> app/Support/functions.php#App\\Support\\fmt',
      'app/Http/Imported.php#Imported::b -call-> app/Support/functions.php#App\\Support\\fmt',
      'app/Http/Imported.php#Imported::c -call-> app/Support/functions.php#App\\Support\\fmt',
      'app/Http/Imported.php#Imported::c -call-> app/global.php#fallback',
      'app/Other/Caller.php#Caller::b -call-> app/Other/functions.php#App\\Other\\fmt',
      'app/Other/Caller.php#Caller::b -call-> app/Other/functions.php#App\\Other\\local_only',
    ]);
  });

  // The scan above parses its 12 files in worker threads; the main thread must give the same edges.
  it('gives the same call and require edges when parsed on the main thread', () => {
    const where = "edge_type IN ('call', 'require')";
    const parallel = rows(where);
    expect(parallel.length).toBeGreaterThan(0);
    mapx(root, 'scan', root, '--force', '--no-parallel');
    expect(rows(where)).toEqual(parallel);
  }, 120000);
});

// Review 2026-10-31: two Laravel apps in one repo (M1-08) declare the same classes and helpers.
// A name resolves to the declaration nearest the caller, as `use` imports already do, never to the
// first app found.
describe('two Laravel apps with the same names in one repo', () => {
  const app = (name: string) => ({
    [`${name}/artisan`]: '#!/usr/bin/env php\n<?php\n',
    [`${name}/composer.json`]: JSON.stringify({ require: { 'laravel/framework': '^12.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
    [`${name}/app/Models/User.php`]: '<?php\nnamespace App\\Models;\nclass User {}\n',
    [`${name}/app/helpers.php`]: '<?php\nfunction format_money($v) { return $v; }\n',
    [`${name}/app/Http/Controllers/UserController.php`]: [
      '<?php',
      'namespace App\\Http\\Controllers;',
      'use App\\Models\\User;',
      'class UserController',
      '{',
      '    public function show() { format_money(1); return new User(); }',
      '}',
    ].join('\n'),
    [`${name}/routes/web.php`]: "<?php\nuse Illuminate\\Support\\Facades\\Route;\nuse App\\Http\\Controllers\\UserController;\nRoute::get('/users', [UserController::class, 'show']);\n",
  });
  let root: string;
  beforeAll(() => {
    root = workspace({ ...app('admin'), ...app('backend') });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  it('links instantiations, function calls and routes inside each app', () => {
    const rows = query<{ s: string; t: string; e: string }>(
      root,
      "SELECT source_file AS s, target_file AS t, edge_type AS e FROM edges WHERE edge_type IN ('import', 'instantiation', 'call', 'route') AND source_file LIKE 'backend/%' ORDER BY e, s, t",
    );
    expect(rows.filter((r) => r.t.startsWith('admin/'))).toEqual([]);
    expect(rows.map((r) => `${r.e} ${r.s} -> ${r.t}`)).toEqual(expect.arrayContaining([
      'call backend/app/Http/Controllers/UserController.php -> backend/app/helpers.php',
      'import backend/app/Http/Controllers/UserController.php -> backend/app/Models/User.php',
      'instantiation backend/app/Http/Controllers/UserController.php -> backend/app/Models/User.php',
      'route backend/routes/web.php -> backend/app/Http/Controllers/UserController.php',
    ]));
  });
});
