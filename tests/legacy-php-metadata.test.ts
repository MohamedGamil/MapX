import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-05-R1: reference metadata reaches stored edges; route edges carry verifiability.
type Edge = { source_file: string; target_file: string; edge_type: string; verifiability: string; metadata: string };

describe('PHP reference metadata and route verifiability', () => {
  let root: string;
  const edges = (where: string) =>
    query<Edge>(root, `SELECT source_file, target_file, edge_type, verifiability, metadata FROM edges WHERE ${where}`)
      .map((e) => ({ ...e, meta: JSON.parse(e.metadata || '{}') }));

  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Models/Team.php': '<?php\nnamespace App\\Models;\nclass Team {}\n',
      'app/Models/User.php': '<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass User extends Model {\n  public function team() { return $this->belongsTo(Team::class); }\n}\n',
      'app/Contracts/Repo.php': '<?php\nnamespace App\\Contracts;\ninterface Repo {}\n',
      'app/Contracts/Mailer.php': '<?php\nnamespace App\\Contracts;\ninterface Mailer {}\n',
      'app/Services/DbRepo.php': '<?php\nnamespace App\\Services;\nclass DbRepo implements \\App\\Contracts\\Repo {}\n',
      'app/Providers/AppServiceProvider.php': [
        '<?php',
        'namespace App\\Providers;',
        'use App\\Contracts\\Repo;',
        'use App\\Contracts\\Mailer;',
        'use App\\Services\\DbRepo;',
        'use Illuminate\\Support\\ServiceProvider;',
        'class AppServiceProvider extends ServiceProvider {',
        '  public function register() {',
        '    $this->app->singleton(Repo::class, DbRepo::class);',
        '    $this->app->bind(Mailer::class, fn ($app) => new DbRepo());',
        '  }',
        '}',
      ].join('\n'),
      'app/Http/Controllers/UserController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass UserController { public function index() {} public function show() {} public function store() {} }\n',
      'routes/api.php': [
        '<?php',
        'use App\\Http\\Controllers\\UserController;',
        "Route::get('/users', [UserController::class, 'index']);",
        "Route::post('/users', 'UserController@store');",
        "Route::resource('teams', UserController::class);",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('stores the Eloquent relationship type and method on relation edges', () => {
    const rel = edges("edge_type = 'relation'");
    expect(rel).toHaveLength(1);
    expect(rel[0]!.meta).toMatchObject({ relationshipMethod: 'belongsTo', relationshipType: 'many-to-one' });
  });

  it('stores binding type, provider phase and a null concrete for closures', () => {
    const bindings = edges("edge_type = 'binding'");
    const singleton = bindings.find((b) => b.meta.bindingType === 'singleton');
    expect(singleton?.meta).toMatchObject({ serviceProviderPhase: 'register', concreteClass: 'App\\Services\\DbRepo' });
    const closure = bindings.find((b) => b.meta.bindingType === 'bind');
    expect(closure?.meta.concreteClass).toBeNull();
  });

  it('marks class-constant routes verified, string handlers inferred, and keeps resourceType', () => {
    const routes = edges("edge_type = 'route'");
    const index = routes.find((r) => r.meta.uri === '/api/users' && r.meta.httpVerb === 'GET');
    const store = routes.find((r) => r.meta.uri === '/api/users' && r.meta.httpVerb === 'POST');
    expect(index?.verifiability).toBe('verified');
    expect(store?.verifiability).toBe('inferred');
    const resource = routes.filter((r) => r.meta.uri?.startsWith('/api/teams'));
    expect(resource.length).toBe(7 + 1);
    expect(resource.every((r) => r.meta.resourceType === 'resource' && r.verifiability === 'verified')).toBe(true);
  });

  it('keeps verified routes in metrics --verified-only', () => {
    const out = mapx(root, 'metrics', root, '--verified-only');
    expect(out).toContain('routes/api.php');
  });
});

// Review 2026-10-31 (post-acceptance defect): class names given as strings got the file's
// namespace prefixed (`App\Models\App\Models\Team`).
describe('PHP class names in strings are fully qualified', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Models/Team.php': '<?php\nnamespace App\\Models;\nclass Team {}\n',
      'app/Contracts/Gateway.php': '<?php\nnamespace App\\Contracts;\ninterface Gateway {}\n',
      'app/Services/Stripe.php': '<?php\nnamespace App\\Services;\nclass Stripe {}\n',
      'app/Models/User.php': "<?php\nnamespace App\\Models;\nclass User {\n  public function team() { return $this->belongsTo('App\\Models\\Team'); }\n}\n",
      'app/Providers/AppServiceProvider.php':
        '<?php\nnamespace App\\Providers;\nuse Illuminate\\Support\\ServiceProvider;\nclass AppServiceProvider extends ServiceProvider {\n  public function register() {\n    $this->app->bind(\'App\\Contracts\\Gateway\', \'\\App\\Services\\Stripe\');\n  }\n}\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('keeps string relation and binding targets as written', () => {
    const rows = query<{ edge_type: string; target_symbol: string; target_file: string | null; metadata: string }>(
      root, "SELECT edge_type, target_symbol, target_file, metadata FROM edges WHERE edge_type IN ('relation', 'binding')");
    const relation = rows.find((r) => r.edge_type === 'relation')!;
    expect(relation.target_symbol).toBe('App\\Models\\Team');
    expect(relation.target_file).toBe('app/Models/Team.php');
    const binding = rows.find((r) => r.edge_type === 'binding')!;
    expect(binding.target_symbol).toBe('App\\Contracts\\Gateway');
    expect(JSON.parse(binding.metadata).concreteClass).toBe('App\\Services\\Stripe');
  });
});
