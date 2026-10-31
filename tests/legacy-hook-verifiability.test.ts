import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-05-R3: a hook edge is verified when its detector declares it (F01), as route edges are.
// Laravel declares its Kernel aliases; NestJS guards carry no declared confidence and stay inferred.
// The guard is not imported, so its hook edge is the controller's only edge.
const files: Record<string, string> = {
  artisan: '#!/usr/bin/env php\n<?php\n',
  'app/Http/Middleware/Authenticate.php':
    '<?php\nnamespace App\\Http\\Middleware;\nclass Authenticate { public function handle($r, $next) { return $next($r); } }\n',
  'app/Http/Kernel.php': [
    '<?php',
    'namespace App\\Http;',
    'class Kernel',
    '{',
    '    protected $routeMiddleware = [',
    "        'auth' => \\App\\Http\\Middleware\\Authenticate::class,",
    '    ];',
    '}',
  ].join('\n'),
  // Declares no middleware; only the HTTP Kernel's aliases and groups are hooks (review 2026-10-31).
  'app/Console/Kernel.php':
    '<?php\nnamespace App\\Console;\nclass Kernel\n{\n    protected function schedule($schedule) { }\n}\n',
  'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10' } }),
  'src/users.controller.ts': [
    "import { Controller, Get, UseGuards } from '@nestjs/common';",
    "@Controller('users')",
    '@UseGuards(AuthGuard)',
    'export class UsersController {',
    '  @Get() findAll() { return []; }',
    '}',
  ].join('\n'),
  'src/auth.guard.ts': 'export class AuthGuard { canActivate() { return true; } }\n',
};

type Row = { target_file: string; edge_type: string; verifiability: string; metadata: string };
type Metrics = { files: { path: string; inDegree: number; outDegree: number }[] };

describe('hook edge verifiability (F01)', () => {
  let root: string;
  beforeAll(() => {
    root = workspace(files);
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  const edgesFrom = (source: string) =>
    query<Row>(root, 'SELECT target_file, edge_type, verifiability, metadata FROM edges WHERE source_file = ?', source)
      .sort((a, b) => (JSON.parse(a.metadata).hookName < JSON.parse(b.metadata).hookName ? -1 : 1));
  const degrees = (...flags: string[]) => {
    const report = JSON.parse(mapx(root, 'metrics', root, '--format', 'json', '--top', '0', ...flags)) as Metrics;
    return Object.fromEntries(report.files.map((f) => [f.path, [f.inDegree, f.outDegree]]));
  };

  it('stores a declared Kernel alias edge verified and an inferred NestJS guard edge inferred', () => {
    const kernel = edgesFrom('app/Http/Kernel.php');
    // The alias (`auth`) and its qualified entry; both declared by the Kernel.
    expect(kernel.map((e) => [e.target_file, e.edge_type, e.verifiability, JSON.parse(e.metadata).hookName, JSON.parse(e.metadata).confidence])).toEqual([
      ['app/Http/Middleware/Authenticate.php', 'middleware', 'verified', 'App\\Http\\Middleware\\Authenticate', 'declared'],
      ['app/Http/Middleware/Authenticate.php', 'middleware', 'verified', 'auth', 'declared'],
    ]);

    const guard = edgesFrom('src/users.controller.ts').filter((e) => e.edge_type === 'middleware');
    expect(guard.map((e) => [e.target_file, e.verifiability, JSON.parse(e.metadata).hookName, JSON.parse(e.metadata).confidence])).toEqual([
      ['src/auth.guard.ts', 'inferred', 'UseGuards:AuthGuard', 'inferred'],
    ]);
  });

  it('gives the Console Kernel no middleware edges: it declares none', () => {
    expect(edgesFrom('app/Console/Kernel.php')).toEqual([]);
    expect(degrees('--verified-only')['app/Console/Kernel.php']).toEqual([0, 0]);
  });

  it('metrics --verified-only keeps the declared middleware edge and drops the inferred guard edge', () => {
    const all = degrees();
    expect(all['app/Http/Kernel.php']).toEqual([0, 1]);
    expect(all['app/Http/Middleware/Authenticate.php']).toEqual([1, 0]);
    expect(all['src/auth.guard.ts']).toEqual([1, 0]);

    const verified = degrees('--verified-only');
    expect(verified['app/Http/Kernel.php']).toEqual([0, 1]);
    expect(verified['app/Http/Middleware/Authenticate.php']).toEqual([1, 0]);
    expect(verified['src/auth.guard.ts']).toEqual([0, 0]);
  });
});

// M0-04-R6 (review 2026-10-31): the workspace context merged the Kernel aliases and groups of every
// Laravel app in the repo, so each app's Kernel emitted the other's middleware and its routes
// expanded the other's aliases. Both apps declare the same classes, so a leak resolves inside the
// leaking app's own tree and only the per-app lists below can catch it.
describe('two Laravel apps keep their own Kernel aliases and groups', () => {
  const mw = (name: string) =>
    `<?php\nnamespace App\\Http\\Middleware;\nclass ${name} { public function handle($r, $next) { return $next($r); } }\n`;
  const kernel = (aliases: string[], groups: string[]) => [
    '<?php',
    'namespace App\\Http;',
    'class Kernel',
    '{',
    '    protected $middlewareGroups = [',
    ...groups.map((g) => `        ${g},`),
    '    ];',
    '    protected $middlewareAliases = [',
    ...aliases.map((a) => `        ${a},`),
    '    ];',
    '}',
  ].join('\n');
  const app = (name: string, kernelSource: string) => ({
    [`${name}/artisan`]: '#!/usr/bin/env php\n<?php\n',
    [`${name}/app/Http/Kernel.php`]: kernelSource,
    [`${name}/app/Http/Middleware/EnsureTeam.php`]: mw('EnsureTeam'),
    [`${name}/app/Http/Middleware/Audit.php`]: mw('Audit'),
    [`${name}/app/Http/Middleware/Authenticate.php`]: mw('Authenticate'),
    [`${name}/app/Http/Controllers/HomeController.php`]:
      '<?php\nnamespace App\\Http\\Controllers;\nclass HomeController { public function index() {} }\n',
    [`${name}/routes/api.php`]: [
      '<?php',
      'use App\\Http\\Controllers\\HomeController;',
      "Route::get('home', [HomeController::class, 'index'])->middleware(['team', 'portal', 'auth']);",
    ].join('\n'),
  });
  let root: string;
  beforeAll(() => {
    root = workspace({
      // App A declares `team` and the group `portal`; app B only `auth`.
      ...app('admin', kernel(
        ["'team' => \\App\\Http\\Middleware\\EnsureTeam::class"],
        ["'portal' => ['team', \\App\\Http\\Middleware\\Audit::class]"],
      )),
      ...app('backend', kernel(["'auth' => \\App\\Http\\Middleware\\Authenticate::class"], [])),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 120000);
  afterAll(() => cleanup(root));

  const middlewareEdges = (source: string) =>
    query<Row>(root, "SELECT target_file, edge_type, verifiability, metadata FROM edges WHERE source_file = ? AND edge_type = 'middleware'", source)
      .map((e) => `${JSON.parse(e.metadata).hookName ?? JSON.parse(e.metadata).middleware} -> ${e.target_file}`)
      .sort();

  it('each Kernel emits only its own aliases and groups, linked inside its own app', () => {
    expect(middlewareEdges('admin/app/Http/Kernel.php')).toEqual([
      'App\\Http\\Middleware\\Audit -> admin/app/Http/Middleware/Audit.php',
      'App\\Http\\Middleware\\EnsureTeam -> admin/app/Http/Middleware/EnsureTeam.php',
      'portal -> admin/app/Http/Middleware/Audit.php',
      'portal -> admin/app/Http/Middleware/EnsureTeam.php',
      'team -> admin/app/Http/Middleware/EnsureTeam.php',
    ]);
    expect(middlewareEdges('backend/app/Http/Kernel.php')).toEqual([
      'App\\Http\\Middleware\\Authenticate -> backend/app/Http/Middleware/Authenticate.php',
      'auth -> backend/app/Http/Middleware/Authenticate.php',
    ]);
  });

  it("each app's routes expand only that app's aliases and groups", () => {
    const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as { path: string; middlewares: string[]; metadata?: { sourceFile?: string } }[];
    const of = (app: string) => routes.find((r) => r.metadata?.sourceFile === `${app}/routes/api.php`)?.middlewares.filter((m) => m !== 'api');
    expect(of('admin')).toEqual(['App\\Http\\Middleware\\EnsureTeam', 'App\\Http\\Middleware\\Audit', 'auth']);
    expect(of('backend')).toEqual(['team', 'portal', 'App\\Http\\Middleware\\Authenticate']);
    expect(middlewareEdges('admin/routes/api.php')).toEqual([
      'App\\Http\\Middleware\\Audit -> admin/app/Http/Middleware/Audit.php',
      'App\\Http\\Middleware\\EnsureTeam -> admin/app/Http/Middleware/EnsureTeam.php',
    ]);
    expect(middlewareEdges('backend/routes/api.php')).toEqual([
      'App\\Http\\Middleware\\Authenticate -> backend/app/Http/Middleware/Authenticate.php',
    ]);
  });
});
