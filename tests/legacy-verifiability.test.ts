import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanup, init, mapx, query, workspace } from './helpers/e2e.js';

type Edge = { source_file: string; source_symbol: string | null; target_symbol: string; target_file: string; verifiability: string };
const EDGE_COLUMNS = 'source_file, source_symbol, target_symbol, target_file, verifiability';

// M0-01-R1: untyped JS/TS member calls are inferred references; DOT dashes only inferred edges.
// M0-17-R2: no call edge targets a constant or variable, built-in receivers make no edges, and
// the built-in skip and DOT styles are pinned by fixtures that fail when their code is removed.
// M0-17-R5: a binding is skipped only when its value is a literal; one made by a call or bound to
// another name is a function symbol, so calls reach it.
describe('edge verifiability', () => {
  let root: string;
  const edgesFrom = (file: string, type = 'call') =>
    query<Edge>(root, `SELECT ${EDGE_COLUMNS} FROM edges WHERE source_file = ? AND edge_type = ? ORDER BY target_symbol, target_file`, file, type);

  beforeAll(() => {
    root = workspace({
      'src/worker.ts': 'export function doWork() { return 1; }\nexport class Repo { save() { return 2; } }\n',
      'src/use.ts': "import { doWork, Repo } from './worker';\nexport function f(o: any, items: number[]) {\n  o.doWork();\n  items.map((x) => x);\n  const r = new Repo();\n  return doWork();\n}\n",
      'src/plain.js': "export function g(svc) { return svc.doWork(); }\n",
      // Constants and variables (M0-17-R1 kinds) are not call targets; a homonym function is.
      'src/consts.js': 'export const config = { port: 1 };\nlet state = {};\nexport const setup = 1;\n',
      'src/setup.js': 'export function setup() { return 2; }\n',
      'src/params.js': 'export function b(config, state) {\n  config();\n  state();\n  return setup();\n}\n',
      'py/settings.py': 'LIMIT = 10\nhandlers = []\n',
      'py/run.py': 'def go(LIMIT, handlers):\n    LIMIT()\n    handlers()\n',
      // Callables made by a factory or bound to another name are call targets; a literal is not (M0-17-R5).
      'web/hooks.ts': "import { useSelector } from 'react-redux';\nexport const useAppSelector = useSelector;\nexport const fetchUser = createAsyncThunk('user/fetch', async () => 1);\nexport const options = { retry: 1 };\n",
      'web/store.js': "import { create } from 'zustand';\nexport const useBears = create((set) => ({ bears: 0 }));\n",
      'web/page.ts': "import { useAppSelector, fetchUser, options } from './hooks';\nimport { useBears } from './store';\nexport function Page() {\n  useAppSelector();\n  useBears();\n  options();\n  return fetchUser();\n}\n",
      'py/handlers.py': 'import functools\ndef _base(x):\n    return x\nhandler = functools.partial(_base, 1)\nalias = _base\nRETRIES = 3\n',
      'py/main.py': 'from handlers import handler, alias, RETRIES\ndef run():\n    handler()\n    RETRIES()\n    return alias()\n',
      // A parameter or local variable of the same name shadows the module function.
      'web/make.ts': 'export function make() { return () => 1; }\n',
      'web/shadow.ts': "import { make } from './make';\nexport function wrap(fetchUser: () => number, ...useBears: any[]) {\n  const useAppSelector = make();\n  useAppSelector();\n  useBears();\n  return fetchUser();\n}\nif (globalThis) { let useAppSelector = make(); useAppSelector(); }\nexport const lambda = (fetchUser) => fetchUser();\n",
      'py/make.py': 'def make():\n    return 1\n',
      'py/shadow.py': 'from make import make\ndef go(handler, *rest, alias=None):\n    _base = make()\n    handler()\n    _base()\n    return alias()\nsquare = lambda handler: handler()\n',
      // User functions named like built-in methods: only a non-built-in receiver may link to them.
      'src/util.ts': 'export function max(a: number, b: number) { return a; }\nexport function now() { return 0; }\nexport function from() {}\nexport function exit() {}\nexport function map() {}\nexport class Cli { status() { return 1; } }\n',
      'src/handler.ts': 'export function handler(items: number[], cli: any) {\n  Math.max(1, 2);\n  Date.now();\n  Array.from([1]);\n  process.exit(0);\n  items.map((x) => x);\n  cli.status();\n}\n',
      // Verified implements (TS) and dispatch (Laravel) edges for the DOT styles.
      'src/contracts.ts': 'export interface Store { put(): void }\n',
      'src/memory.ts': "import { Store } from './contracts';\nexport class MemoryStore implements Store { put() {} }\n",
      artisan: '#!/usr/bin/env php\n<?php\n',
      'app/Contracts/Repo.php': '<?php\nnamespace App\\Contracts;\ninterface Repo {}\n',
      'app/Services/DbRepo.php': '<?php\nnamespace App\\Services;\nclass DbRepo {}\n',
      'app/Providers/AppServiceProvider.php': '<?php\nnamespace App\\Providers;\nuse App\\Contracts\\Repo;\nuse App\\Services\\DbRepo;\nclass AppServiceProvider { public function register() { $this->app->bind(Repo::class, DbRepo::class); } }\n',
      'app/Jobs/SendReport.php': '<?php\nnamespace App\\Jobs;\nclass SendReport implements \\Illuminate\\Contracts\\Queue\\ShouldQueue {}\n',
      'app/Http/Controllers/ReportController.php': '<?php\nnamespace App\\Http\\Controllers;\nuse App\\Jobs\\SendReport;\nclass ReportController { public function run() { SendReport::dispatch(); } }\n',
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

  it('call references never resolve to constants or variables (M0-17-R2)', () => {
    expect(edgesFrom('src/params.js')).toEqual([
      { source_file: 'src/params.js', source_symbol: 'b', target_symbol: 'setup', target_file: 'src/setup.js', verifiability: 'verified' },
    ]);
    expect([...edgesFrom('py/run.py'), ...edgesFrom('py/run.py', 'instantiation')]).toEqual([]);
  });

  it('calls reach callables bound from a factory call or another name (M0-17-R5)', () => {
    // `options` and `RETRIES` are literals, so their calls still make no edge.
    expect(edgesFrom('web/page.ts')).toEqual([
      { source_file: 'web/page.ts', source_symbol: 'Page', target_symbol: 'fetchUser', target_file: 'web/hooks.ts', verifiability: 'verified' },
      { source_file: 'web/page.ts', source_symbol: 'Page', target_symbol: 'useAppSelector', target_file: 'web/hooks.ts', verifiability: 'verified' },
      { source_file: 'web/page.ts', source_symbol: 'Page', target_symbol: 'useBears', target_file: 'web/store.js', verifiability: 'verified' },
    ]);
    expect(edgesFrom('py/main.py')).toEqual([
      { source_file: 'py/main.py', source_symbol: 'run', target_symbol: 'alias', target_file: 'py/handlers.py', verifiability: 'verified' },
      { source_file: 'py/main.py', source_symbol: 'run', target_symbol: 'handler', target_file: 'py/handlers.py', verifiability: 'verified' },
    ]);
  });

  it('a call on a parameter or local variable does not reach the module function of that name (M0-17-R5)', () => {
    expect(edgesFrom('web/shadow.ts').map((e) => e.target_symbol)).toEqual(['make', 'make']);
    expect(edgesFrom('py/shadow.py').map((e) => e.target_symbol)).toEqual(['make']);
  });

  it('member calls on built-in receivers and built-in method names make no edges (M0-17-R2)', () => {
    // `items.map()` must not link to the user function `map`, nor `Math.max()` to `max`; the
    // untyped `cli.status()` still links to Cli::status as an inferred call.
    expect(edgesFrom('src/handler.ts')).toEqual([
      { source_file: 'src/handler.ts', source_symbol: 'handler', target_symbol: 'status', target_file: 'src/util.ts', verifiability: 'inferred' },
    ]);
  });

  it('dashes exactly the edges with no verified edge behind them in DOT output', () => {
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
    const style = (src: string, tgt: string, type: string) => parsed.find((e) => e.src === src && e.tgt === tgt && e.type === type)?.style;

    // Verified edges keep their type's style; only an all-inferred pair is dashed (F01).
    expect(style('src/plain.js', 'src/worker.ts', 'call')).toBe('dashed');
    expect(style('src/use.ts', 'src/worker.ts', 'call')).toBe('dotted');
    expect(style('src/memory.ts', 'src/contracts.ts', 'implements')).toBe('solid');
    expect(style('app/Http/Controllers/ReportController.php', 'app/Jobs/SendReport.php', 'dispatch')).toBe('bold');
    expect(style('app/Providers/AppServiceProvider.php', 'app/Contracts/Repo.php', 'binding')).toBe('solid');
    for (const e of parsed) {
      const v = verifs(e);
      expect(e.style === 'dashed', JSON.stringify({ e, v })).toBe(v.length > 0 && v.every((x) => x === 'inferred'));
    }
  });
});
