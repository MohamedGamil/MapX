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
