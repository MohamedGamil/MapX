import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-20-R1: NestJS decorator scope and GraphQL operation parsing.
describe('NestJS and GraphQL extraction', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10' } }),
      'src/users.controller.ts': [
        "import { Controller, Get, Post, UseGuards, CanActivate, OnModuleInit } from '@nestjs/common';",
        "@Controller('users')",
        '@UseGuards(AuthGuard)',
        'export class UsersController implements OnModuleInit {',
        "  @Get() findAll() { return []; }",
        "  @Get(':id') findOne() { return {}; }",
        "  @Post('bulk') bulk() { return 1; }",
        '  onModuleInit() {}',
        '}',
        '',
        'export class HealthHelper {',
        "  @Get('not-a-route') check() { return 1; }",
        '}',
        '',
        'export class AuthGuard implements CanActivate { canActivate() { return true; } }',
      ].join('\n'),
      'src/users.resolver.ts': [
        "import { Resolver, Query, Mutation } from '@nestjs/graphql';",
        '@Resolver(() => User)',
        'export class UsersResolver {',
        "  @Query(() => [User], { name: 'users' }) list() { return []; }",
        "  @Mutation(() => User, { name: 'createUser', nullable: true }) create() { return {}; }",
        '  @Query(() => Number) count() { return 0; }',
        '}',
        'class User {}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
  }, 90000);
  afterAll(() => cleanup(root));

  it('keeps controller decorators inside their class: 3 routes, no phantom route or hook', () => {
    const routes = JSON.parse(mapx(root, 'routes', root, '--json')) as { method: string; path: string }[];
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /users', 'GET /users/:id', 'POST /users/bulk']);
    const hooks = JSON.parse(mapx(root, 'hooks', root, '--json')) as { hookName: string; handlerSymbol?: string }[];
    expect(hooks.filter((h) => h.handlerSymbol?.startsWith('HealthHelper'))).toEqual([]);
  });

  it('names GraphQL operations and records their type', () => {
    const edges = query<{ metadata: string }>(root, "SELECT metadata FROM edges WHERE edge_type = 'graphql_resolver'").map((e) => JSON.parse(e.metadata));
    const ops = Object.fromEntries(edges.map((m) => [m.hookName, m.operationType]));
    expect(ops).toEqual({ users: 'query', createUser: 'mutation', count: 'query' });
  });

  it('creates no file-to-itself edge for interface hooks', () => {
    expect(query(root, "SELECT * FROM edges WHERE source_file = target_file AND edge_type = 'hook'")).toEqual([]);
    expect(query(root, "SELECT * FROM edges WHERE source_file = target_file AND edge_type = 'middleware'")).toEqual([]);
  });
});
