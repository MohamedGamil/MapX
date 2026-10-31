import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

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
