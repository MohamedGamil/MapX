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

// M0-20-R2: class segmentation must ignore comments, strings and generics.
// Synthetic fixtures, one scenario per file so each assertion isolates one defect.
describe('NestJS segmentation with comments, strings and generics', () => {
  let root: string;
  let routes: string[];
  let gqlOps: Record<string, string>;
  const routesOf = (file: string) => routes.filter((r) => r.startsWith(`${file} `)).map((r) => r.slice(file.length + 1)).sort();

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10' } }),
      // AC1: a JSDoc mentioning "class" before the controller.
      'src/jsdoc.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        '/**',
        ' * This class handles orders. See class OrdersService { for the logic.',
        ' */',
        "@Controller('orders')",
        'export class OrdersController {',
        "  @Get() list() { return []; }",
        "  @Get(':id') one() { return {}; }",
        '}',
      ].join('\n'),
      // AC2: an apostrophe in a comment inside a controller, then a plain class.
      'src/apostrophe.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('items')",
        'export class ItemsController {',
        "  // don't cache this",
        "  @Get() all() { return []; }",
        '}',
        '',
        'export class ItemsHelper {',
        "  @Get('phantom') check() { return 1; }",
        '}',
      ].join('\n'),
      // AC2: an unbalanced brace in a comment inside a controller, then a plain class and a second controller.
      'src/brace.controller.ts': [
        "import { Controller, Get, Post } from '@nestjs/common';",
        "@Controller('carts')",
        'export class CartsController {',
        '  // TODO: close the { when ready',
        "  @Get() all() { return []; }",
        "  @Post('checkout') checkout() { return 1; }",
        '}',
        '',
        'export class CartsHelper {',
        "  @Get('phantom') check() { return 1; }",
        '}',
        '',
        "@Controller('wishlists')",
        'export class WishlistsController {',
        "  @Get() all() { return []; }",
        '}',
      ].join('\n'),
      // A string containing `class X {` and a stray brace.
      'src/string.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "const banner = 'class Fake { not code';",
        'const tpl = `}} ${banner} class Other {`;',
        "@Controller('strings')",
        'export class StringsController {',
        "  @Get() a() { return '}'; }",
        "  @Get('b') b() { return \"class Inner {\"; }",
        '}',
        '',
        'export class StringsHelper {',
        "  @Get('phantom') check() { return 1; }",
        '}',
      ].join('\n'),
      // AC3 and generics from the brief.
      'src/generic.controller.ts': [
        "import { Controller, Get, Post } from '@nestjs/common';",
        "@Controller('generic')",
        'export class GenericController<T extends { id: string }> {',
        "  @Get() all() { return []; }",
        "  @Get(':id') one() { return {}; }",
        '}',
        '',
        'export class Repository<E> { find(): E[] { return []; } }',
        'class User { id = 1; }',
        '',
        "@Controller({ path: 'users', version: '1' })",
        'export class UsersV1Controller extends Base<Repository<User>> implements Svc<Promise<Map<string, {a: number}>>> {',
        "  @Get() async all(): Promise<Map<string, {a: number}>> { return new Map(); }",
        "  @Post({ path: 'bulk' } as any) bulk(): Repository<User> { return null as any; }",
        '}',
        '',
        'export class GenericHelper {',
        "  @Get('phantom') check() { return 1; }",
        '}',
      ].join('\n'),
      // A commented-out controller decorator must not make a plain class a controller.
      'src/commented.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "// @Controller('ghost')",
        'export class GhostThing {',
        "  @Get('phantom') check() { return 1; }",
        '}',
      ].join('\n'),
      // AC4: `name:` inside a description string is not the operation name; decorators with object literals.
      'src/posts.resolver.ts': [
        "import { Resolver, Query, Mutation } from '@nestjs/graphql';",
        '@Resolver(() => Post)',
        'export class PostsResolver {',
        "  @Query(returns => Post, { description: \"the post's name: 'x'\" }) post() { return {}; }",
        "  @Mutation(() => Post, { description: 'renames { a post', name: 'renamePost' }) rename() { return {}; }",
        "  @Query(() => [Post], { nullable: { items: true }, name: 'allPosts' }) list() { return []; }",
        '}',
        'class Post {}',
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
    const raw = JSON.parse(mapx(root, 'routes', root, '--json')) as { method: string; path: string; handlerFile?: string; handlerSymbol?: string }[];
    routes = raw.map((r) => `${r.handlerSymbol?.split('@')[0]} ${r.method} ${r.path} ${r.handlerSymbol}`);
    const edges = query<{ metadata: string }>(root, "SELECT metadata FROM edges WHERE edge_type = 'graphql_resolver'").map((e) => JSON.parse(e.metadata));
    gqlOps = Object.fromEntries(edges.map((m) => [m.hookName, m.operationType]));
  }, 90000);
  afterAll(() => cleanup(root));

  it('keeps routes of a controller preceded by a JSDoc mentioning "class" (AC1)', () => {
    expect(routesOf('OrdersController')).toEqual(['GET /orders OrdersController@list', 'GET /orders/:id OrdersController@one']);
    expect(routesOf('OrdersService')).toEqual([]);
  });

  it('an apostrophe in a comment does not leak the prefix to a later plain class (AC2)', () => {
    expect(routesOf('ItemsController')).toEqual(['GET /items ItemsController@all']);
    expect(routesOf('ItemsHelper')).toEqual([]);
  });

  it('an unbalanced brace in a comment neither leaks nor misattributes routes (AC2)', () => {
    expect(routesOf('CartsController')).toEqual(['GET /carts CartsController@all', 'POST /carts/checkout CartsController@checkout']);
    expect(routesOf('CartsHelper')).toEqual([]);
    expect(routesOf('WishlistsController')).toEqual(['GET /wishlists WishlistsController@all']);
  });

  it('ignores `class X {` and stray braces inside strings and templates', () => {
    expect(routesOf('StringsController')).toEqual(['GET /strings StringsController@a', 'GET /strings/b StringsController@b']);
    expect(routesOf('StringsHelper')).toEqual([]);
    expect(routesOf('Fake')).toEqual([]);
    expect(routesOf('Other')).toEqual([]);
    expect(routesOf('Inner')).toEqual([]);
  });

  it('keeps routes of a controller with a generic `<T extends { id: string }>` (AC3)', () => {
    expect(routesOf('GenericController')).toEqual(['GET /generic GenericController@all', 'GET /generic/:id GenericController@one']);
    expect(routesOf('GenericHelper')).toEqual([]);
  });

  it('handles nested generics such as Repository<User> and Promise<Map<string, {a: number}>>', () => {
    expect(routesOf('UsersV1Controller')).toEqual(['GET /users UsersV1Controller@all', 'POST /users/bulk UsersV1Controller@bulk']);
  });

  it('ignores a commented-out @Controller', () => {
    expect(routesOf('GhostThing')).toEqual([]);
  });

  it('every route in the workspace is one of the expected ones (no phantom anywhere)', () => {
    expect(routes.filter((r) => /phantom/.test(r))).toEqual([]);
  });

  it('takes the GraphQL operation name from a real `name:` key, not from a description string (AC4)', () => {
    expect(gqlOps).toEqual({ post: 'query', renamePost: 'mutation', allPosts: 'query' });
  });
});

// M0-20-R3: Prettier trailing commas, generic handlers, a regex literal after a condition's `)`.
// Synthetic fixtures, one scenario per file; each `*Helper` after a controller catches a swallowed class.
describe('NestJS trailing commas, generic handlers and regex after a parenthesis', () => {
  let root: string;
  let routes: string[];
  const routesOf = (cls: string) => routes.filter((r) => r.startsWith(`${cls} `)).map((r) => r.slice(cls.length + 1)).sort();

  beforeAll(() => {
    root = workspace({
      'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^10', '@nestjs/common': '^10' } }),
      // AC1: Prettier breaks long decorator arguments over lines with a trailing comma.
      'src/multi.controller.ts': [
        "import { Controller, Get, Post } from '@nestjs/common';",
        '@Controller(',
        "  'x',",
        ')',
        'export class MultiController {',
        '  @Get(',
        "    ':id',",
        '  )',
        '  one() { return 1; }',
        '  @Post(',
        "    { path: 'bulk' },",
        '  )',
        '  bulk() { return 2; }',
        '}',
      ].join('\n'),
      // AC2: a generic handler is named after itself, not after the first call in its body.
      'src/generic-method.controller.ts': [
        "import { Controller, Get, Post } from '@nestjs/common';",
        "@Controller('gm')",
        'export class GmController {',
        '  constructor(private readonly svc: any) {}',
        '  @Get() async list<T>(): Promise<T[]> { return this.svc.findAll(); }',
        "  @Post('save') save<K extends keyof Map<string, () => void>, V = {}>(k: K): V { return this.svc.store(k); }",
        '}',
      ].join('\n'),
      // AC3: a regex literal right after the `)` of an if / while / for condition.
      'src/regex-if.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('re-if')",
        'export class ReIfController {',
        "  @Get() a(s: string) { if (s) /{'/.test(s); return 1; }",
        "  @Get('b') b() { return 2; }",
        '}',
        "export class ReIfHelper { @Get('phantom') check() {} }",
      ].join('\n'),
      'src/regex-while.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('re-while')",
        'export class ReWhileController {',
        "  @Get() a(s: string) { while (s.length > 9) /'{/.test(s) && (s = s.slice(1)); return s; }",
        "  @Get('b') b() { return 2; }",
        '}',
        "export class ReWhileHelper { @Get('phantom') check() {} }",
      ].join('\n'),
      'src/regex-for.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('re-for')",
        'export class ReForController {',
        "  @Get() a(s: string[]) { for (const c of s) /'/.test(c); return s; }",
        "  @Get('b') b() { return 2; }",
        '}',
        "export class ReForHelper { @Get('phantom') check() {} }",
      ].join('\n'),
      // A `/` after the `)` of a call or a grouping is still a division.
      'src/division.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('div')",
        'export class DivController {',
        "  @Get() a(n: number) { return Math.abs(n) / 2 + '/' + '{'; }",
        "  @Get('b') b(n: number) { return (n + 1) / 2 + '/' + '{'; }",
        "  @Get('c') c() { return 3; }",
        '}',
        "export class DivHelper { @Get('phantom') check() {} }",
      ].join('\n'),
    });
    init(root);
    mapx(root, 'scan', root);
    const raw = JSON.parse(mapx(root, 'routes', root, '--json')) as { method: string; path: string; handlerSymbol?: string }[];
    routes = raw.map((r) => `${r.handlerSymbol?.split('@')[0]} ${r.method} ${r.path} ${r.handlerSymbol}`);
  }, 90000);
  afterAll(() => cleanup(root));

  it('drops the trailing comma of a multi-line decorator argument (AC1)', () => {
    expect(routesOf('MultiController')).toEqual(['GET /x/:id MultiController@one', 'POST /x/bulk MultiController@bulk']);
  });

  it('names a generic handler after itself (AC2)', () => {
    expect(routesOf('GmController')).toEqual(['GET /gm GmController@list', 'POST /gm/save GmController@save']);
  });

  it('a regex literal after an if condition does not swallow the next class (AC3)', () => {
    expect(routesOf('ReIfController')).toEqual(['GET /re-if ReIfController@a', 'GET /re-if/b ReIfController@b']);
    expect(routesOf('ReIfHelper')).toEqual([]);
  });

  it('a regex literal after a while condition does not swallow the next class (AC3)', () => {
    expect(routesOf('ReWhileController')).toEqual(['GET /re-while ReWhileController@a', 'GET /re-while/b ReWhileController@b']);
    expect(routesOf('ReWhileHelper')).toEqual([]);
  });

  it('a regex literal after a for header does not swallow the next class (AC3)', () => {
    expect(routesOf('ReForController')).toEqual(['GET /re-for ReForController@a', 'GET /re-for/b ReForController@b']);
    expect(routesOf('ReForHelper')).toEqual([]);
  });

  it('a `/` after the `)` of a call or a grouping stays a division', () => {
    expect(routesOf('DivController')).toEqual(['GET /div DivController@a', 'GET /div/b DivController@b', 'GET /div/c DivController@c']);
    expect(routesOf('DivHelper')).toEqual([]);
  });

  it('no phantom route anywhere in the workspace', () => {
    expect(routes.filter((r) => /phantom/.test(r))).toEqual([]);
  });
});
