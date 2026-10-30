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
    expect(edges(A, 'import').map((e) => e.target_file)).toEqual(expect.arrayContaining([
      'app/Http/Response.php', 'app/Models/Event.php', 'app/Services/UserService.php', 'app/Support/Cache.php',
    ]));
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
