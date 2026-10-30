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
