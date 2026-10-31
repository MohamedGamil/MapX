import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp.js';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-05-R2: the Laravel structure surface of F07–F09: model relationships in `query` and the LLM
// export, route → middleware edges, routes grouped by controller, abstract → concrete bindings.
const files: Record<string, string> = {
  artisan: '#!/usr/bin/env php\n<?php\n',
  'app/Models/User.php': [
    '<?php',
    'namespace App\\Models;',
    'use Illuminate\\Database\\Eloquent\\Model;',
    'class User extends Model',
    '{',
    '    public function team()',
    '    {',
    '        return $this->belongsTo(Team::class);',
    '    }',
    '',
    '    public function orders()',
    '    {',
    '        return $this->hasMany(Order::class);',
    '    }',
    '}',
  ].join('\n'),
  'app/Models/Team.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Team extends Model {}\n',
  'app/Models/Order.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model {}\n',
  'app/Http/Controllers/OrderController.php': [
    '<?php',
    'namespace App\\Http\\Controllers;',
    'class OrderController',
    '{',
    ...['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'].map((m) => `    public function ${m}() {}`),
    '}',
  ].join('\n'),
  'app/Http/Middleware/Authenticate.php': '<?php\nnamespace App\\Http\\Middleware;\nclass Authenticate { public function handle($r, $next) { return $next($r); } }\n',
  'app/Http/Kernel.php': "<?php\nnamespace App\\Http;\nclass Kernel\n{\n    protected $routeMiddleware = [\n        'auth' => \\App\\Http\\Middleware\\Authenticate::class,\n    ];\n}\n",
  'app/Contracts/PaymentGateway.php': '<?php\nnamespace App\\Contracts;\ninterface PaymentGateway {}\n',
  'app/Services/StripeGateway.php': '<?php\nnamespace App\\Services;\nuse App\\Contracts\\PaymentGateway;\nclass StripeGateway implements PaymentGateway {}\n',
  'app/Providers/AppServiceProvider.php': [
    '<?php',
    'namespace App\\Providers;',
    'use App\\Contracts\\PaymentGateway;',
    'use App\\Services\\StripeGateway;',
    'use Illuminate\\Support\\ServiceProvider;',
    'class AppServiceProvider extends ServiceProvider',
    '{',
    '    public function register()',
    '    {',
    '        $this->app->bind(PaymentGateway::class, StripeGateway::class);',
    '    }',
    '}',
  ].join('\n'),
  'routes/web.php': [
    '<?php',
    'use App\\Http\\Controllers\\OrderController;',
    "Route::resource('orders', OrderController::class)->middleware('auth');",
  ].join('\n'),
};

describe('Laravel structure surface (F07–F09)', () => {
  let root: string;
  let client: Client;
  beforeAll(async () => {
    expect(Object.keys(files).length).toBeGreaterThan(10); // parallel scan path
    root = workspace(files);
    init(root);
    mapx(root, 'scan', root);
    // A real MCP client over an in-memory transport (M0-05-R4).
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
  }, 90000);
  afterAll(async () => {
    await client?.close();
    cleanup(root);
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: { dir: root, ...args } })) as any).content[0].text as string;

  it('mapx query User lists its relationships (method, type, target)', () => {
    const out = mapx(root, 'query', 'User');
    expect(out).toMatch(/class User[\s\S]*relationships:\n\s+team → belongsTo App\\Models\\Team \(many-to-one\)\n\s+orders → hasMany App\\Models\\Order \(one-to-many\)/);
  });

  it("->middleware('auth') gives a middleware edge from the route file to the middleware class", () => {
    const rows = query<{ target_file: string; verifiability: string; metadata: string }>(
      root, "SELECT target_file, verifiability, metadata FROM edges WHERE edge_type = 'middleware' AND source_file = 'routes/web.php'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_file).toBe('app/Http/Middleware/Authenticate.php');
    expect(rows[0]!.verifiability).toBe('verified');
    expect(JSON.parse(rows[0]!.metadata)).toMatchObject({ routeCount: 8 });
  });

  it('LLM export has a Models section and one line for OrderController and its 8 routes', () => {
    const out = mapx(root, 'export');
    expect(out).toMatch(/## Models \(1\)\n- User @ app\/Models\/User\.php: team → belongsTo App\\Models\\Team \(many-to-one\); orders → hasMany App\\Models\\Order \(one-to-many\)/);
    const controllerLines = out.split('\n').filter((l) => l.startsWith('- routes/web.php → ') && l.includes('OrderController ('));
    expect(controllerLines).toHaveLength(1);
    expect(controllerLines[0]).toMatch(/OrderController \(8 routes: /);
  });

  it('mapx deps AppServiceProvider shows abstract → concrete bindings', () => {
    expect(mapx(root, 'deps', 'AppServiceProvider')).toContain('Bindings (abstract → concrete):\n  App\\Contracts\\PaymentGateway → App\\Services\\StripeGateway (bind)');
  });

  // M0-05-R4: the MCP tools carry the same relationships and bindings as the CLI.
  it('mapx_query on a model lists its relationships (MCP client)', async () => {
    const out = await call('mapx_query', { term: 'User' });
    expect(out).toMatch(/class User\n  @ app\/Models\/User\.php:\d+\n(?:  signature: .*\n)?  relationships:\n    team → belongsTo App\\Models\\Team \(many-to-one\)\n    orders → hasMany App\\Models\\Order \(one-to-many\)/);
  });

  it('mapx_dependencies on a provider lists its bindings (MCP client)', async () => {
    const out = await call('mapx_dependencies', { file: 'app/Providers/AppServiceProvider.php' });
    expect(out).toContain('Bindings (abstract → concrete):\n  App\\Contracts\\PaymentGateway → App\\Services\\StripeGateway (bind)');
  });
});
