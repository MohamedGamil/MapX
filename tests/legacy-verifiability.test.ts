import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

// M0-01-R1: untyped JS/TS member calls are inferred references; DOT dashes only inferred edges.
describe('edge verifiability', () => {
  let root: string;
  beforeAll(() => {
    root = workspace({
      'src/worker.ts': 'export function doWork() { return 1; }\nexport class Repo { save() { return 2; } }\n',
      'src/use.ts': "import { doWork, Repo } from './worker';\nexport function f(o: any, items: number[]) {\n  o.doWork();\n  items.map((x) => x);\n  const r = new Repo();\n  return doWork();\n}\n",
      'src/plain.js': "export function g(svc) { return svc.doWork(); }\n",
      'app/Contracts/Repo.php': '<?php\nnamespace App\\Contracts;\ninterface Repo {}\n',
      'app/Services/DbRepo.php': '<?php\nnamespace App\\Services;\nclass DbRepo {}\n',
      'app/Providers/AppServiceProvider.php': '<?php\nnamespace App\\Providers;\nuse App\\Contracts\\Repo;\nuse App\\Services\\DbRepo;\nclass AppServiceProvider { public function register() { $this->app->bind(Repo::class, DbRepo::class); } }\n',
    });
    init(root);
    mapx(root, 'scan', root);
  }, 60000);
  afterAll(() => cleanup(root));

  it('captures obj.method() as an inferred call and skips built-in methods', () => {
    const calls = query<{ source_file: string; target_symbol: string; verifiability: string }>(
      root, "SELECT source_file, target_symbol, verifiability FROM edges WHERE edge_type = 'call' ORDER BY source_file, verifiability",
    );
    expect(calls).toEqual(expect.arrayContaining([
      { source_file: 'src/use.ts', target_symbol: 'doWork', verifiability: 'inferred' },
      { source_file: 'src/use.ts', target_symbol: 'doWork', verifiability: 'verified' },
      { source_file: 'src/plain.js', target_symbol: 'doWork', verifiability: 'inferred' },
    ]));
    expect(calls.some((c) => c.target_symbol === 'map')).toBe(false);
  });

  it('dashes only inferred edges in DOT output', () => {
    const dot = mapx(root, 'export', '-d', root, '--format', 'dot');
    const lines = dot.split('\n').filter((l) => l.includes('->'));
    const parse = (l: string) => {
      const m = l.match(/"([^"]+)" -> "([^"]+)" \[label="([^"]+)", style=(\w+)/)!;
      return { src: m[1]!, tgt: m[2]!, type: m[3]!, style: m[4]! };
    };
    const verifs = (e: ReturnType<typeof parse>) =>
      query<{ verifiability: string }>(root, 'SELECT verifiability FROM edges WHERE source_file = ? AND target_file = ? AND edge_type = ?', e.src, e.tgt, e.type)
        .map((r) => r.verifiability);
    const parsed = lines.map(parse);
    expect(parsed.some((e) => e.style === 'dashed')).toBe(true);
    const binding = parsed.find((e) => e.type === 'binding');
    expect(binding, 'verified binding edge present').toBeDefined();
    expect(binding!.style).not.toBe('dashed');
    for (const e of parsed) {
      if (e.style === 'dashed') expect(verifs(e), JSON.stringify(e)).toContain('inferred');
      else expect(verifs(e).every((v) => v === 'verified') || e.style !== 'dashed').toBe(true);
    }
  });
});
