import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseWorkerUrl } from '../src/core/scanner.js';
import { getParserForFile } from '../src/parsers/parser-registry.js';
import { resourceParam } from '../src/frameworks/detectors/laravel-mounts.js';
import { cleanup, init, mapxWithStderr, query, workspace, useParseWorkers } from './helpers/e2e.js';

// These scans exercise the parse workers; test projects are below the automatic break-even (M4-13).
useParseWorkers(4);

// M0-06-R2: the bun-compiled binary embeds the parse worker and scans on worker threads. It printed
// "Parallel parsing unavailable (Cannot find module '/$bunfs/parsers/parse-worker.js')" on every
// scan of more than 10 files: the worker was never an entrypoint of the build.
const ROOT = resolve(__dirname, '..');
const ENTRYPOINTS = ['./src/main.ts', './src/parsers/parse-worker.ts'];

describe('parseWorkerUrl', () => {
  it('finds the worker beside the scanner module in source and npm builds', () => {
    expect(parseWorkerUrl('file:///repo/src/core/scanner.ts').href).toBe('file:///repo/src/parsers/parse-worker.ts');
    expect(parseWorkerUrl('file:///lib/node_modules/@mgamil/mapx/dist/core/scanner.js').href)
      .toBe('file:///lib/node_modules/@mgamil/mapx/dist/parsers/parse-worker.js');
  });

  it('finds the embedded worker beside the binary\'s module in a bun --compile binary', () => {
    expect(parseWorkerUrl('file:///$bunfs/root/mapx').href).toBe('file:///$bunfs/root/parsers/parse-worker.js');
    expect(parseWorkerUrl('file:///B:/~BUN/root/mapx.exe').href).toBe('file:///B:/~BUN/root/parsers/parse-worker.js');
  });
});

describe('bun build --compile commands', () => {
  const builds = (text: string) => text.split('\n').filter((l) => /bun build --compile/.test(l));

  it('the Makefile and build-all.ts name the parse worker as an entrypoint', () => {
    const lines = [...builds(readFileSync(join(ROOT, 'Makefile'), 'utf8')), ...builds(readFileSync(join(ROOT, 'scripts/build-all.ts'), 'utf8'))];
    expect(lines.length).toBe(6);
    for (const line of lines) expect(line).toContain('./src/main.ts ./src/parsers/parse-worker.ts --outfile');
  });

  it('package.sh names the parse worker and smoke-scans the host binary it packages, built by make or by itself', () => {
    const script = readFileSync(join(ROOT, 'scripts/package.sh'), 'utf8');
    const build = script.slice(script.indexOf('if bun build --compile'), script.indexOf('--outfile'));
    expect(build).toContain('"$PROJECT_ROOT/src/main.ts"');
    expect(build).toContain('"$PROJECT_ROOT/src/parsers/parse-worker.ts"');
    const tarball = script.slice(script.indexOf('package_tarball() {'), script.indexOf('package_zip() {'));
    expect(tarball).toMatch(/if \[ "bun-\$\{binary#mapx-\}" = "\$\(host_target\)" \]; then\n\s+smoke_binary "\$PROJECT_ROOT\/dist\/\$binary"/);
    expect(script).toMatch(/\*"Parallel parsing unavailable"\*\) error /);
    expect(script).toContain('MAPX_TEST_WORKER_FAIL=f1.ts "$bin" scan');
    expect(script).toMatch(/\*\) error "Smoke test: \$bin never started its parse workers" ;;/);
  });
});

// A PHP call named after an Object.prototype member read that member as a Laravel facade's class:
// the call was dropped, and on worker threads its result could not be posted, so every parallel
// scan reaching such a file fell back to one thread for the whole project.
const PROTOTYPE_CALLS = {
  'app/Text.php': '<?php\nnamespace App;\nclass Text { public function toString() { return ""; } public function valueOf() { return 1; } public function constructor() { return 2; } }\n',
  'app/Runner.php': '<?php\nnamespace App;\nclass Runner { public function run(Text $t) { return $t->toString() . $t->valueOf() . $t->constructor(); } }\n',
};
const prototypeCallEdges = (root: string) => query(root, `SELECT source_symbol, target_file, target_symbol FROM edges
  WHERE source_file = 'app/Runner.php' AND edge_type = 'call' ORDER BY target_symbol`);
// The one-line method is the calls' source, not its class (M2-13).
const EXPECTED_PROTOTYPE_CALLS = ['constructor', 'toString', 'valueOf'].map((name) => ({ source_symbol: 'Runner::run', target_file: 'app/Text.php', target_symbol: name }));

describe('parallel scans of PHP calls named after Object.prototype members (real CLI)', () => {
  let root: string;
  afterAll(() => cleanup(root));

  it('stay on worker threads, keep the calls, and index what a one-thread scan does', () => {
    const files: Record<string, string> = { ...PROTOTYPE_CALLS };
    for (let i = 1; i <= 10; i++) files[`app/F${i}.php`] = `<?php\nnamespace App;\nclass F${i} { public function go() { return ${i}; } }\n`;
    root = workspace(files);
    init(root);
    const parallel = mapxWithStderr(root, 'scan');
    expect(parallel.stdout + parallel.stderr).not.toContain('Parallel parsing unavailable');
    expect(prototypeCallEdges(root)).toEqual(EXPECTED_PROTOTYPE_CALLS);
    const all = () => query(root, 'SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges ORDER BY 1, 2, 3, 4, 5');
    const edges = all();
    unlinkSync(join(root, '.mapx/mapx.db'));
    mapxWithStderr(root, 'scan', '--no-parallel');
    expect(all()).toEqual(edges);
  }, 120000);
});

describe('other lookups keyed by names from source code (review 2026-11-01)', () => {
  it('a Vuex call check reads only its own kinds: hasOwnProperty is not a store call, and the result clones', async () => {
    const src = "export function check(routes) {\n  this.$store.dispatch('cart/load');\n  return routes.hasOwnProperty('users/list');\n}\n";
    const result: any = await getParserForFile('src/comp.js').parse('src/comp.js', src, {});
    expect(() => structuredClone(result)).not.toThrow();
    const stores = result.references.filter((r: any) => r.metadata?.vueStore || r.vueStore);
    expect(stores.map((r: any) => r.targetName)).not.toContain('list');
  });

  it('Laravel resource parameters of Object.prototype names are strings', () => {
    expect(['constructor', 'constructors', 'toString', '__proto__', 'hasOwnProperty', 'photos'].map(resourceParam))
      .toEqual(['constructor', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'photo']);
  });

  it('a Route::resource named constructor keeps the other routes of its file (real CLI)', () => {
    const root = workspace({
      artisan: '#!/usr/bin/env php\n<?php\n',
      'routes/web.php': "<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::resource('photos', PhotoController::class);\nRoute::resource('constructor', ConstructorController::class);\n",
      'app/Http/Controllers/PhotoController.php': '<?php\nnamespace App\\Http\\Controllers;\nclass PhotoController { public function index() {} }\n',
    });
    try {
      init(root);
      const scan = mapxWithStderr(root, 'scan');
      expect(scan.stdout + scan.stderr).not.toContain('Failed to extract routes');
      const routes = JSON.parse(mapxWithStderr(root, 'routes', root, '--json').stdout) as Array<{ method: string; path: string }>;
      const paths = routes.map((r) => r.path);
      expect(paths).toEqual(expect.arrayContaining(['/photos', '/photos/{photo}', '/constructor', '/constructor/{constructor}']));
    } finally {
      cleanup(root);
    }
  }, 120000);
});

describe('a file a worker cannot return is parsed on the main thread (real CLI)', () => {
  let root: string;
  afterAll(() => cleanup(root));

  it('stays on worker threads, says so, and indexes what a one-thread scan does', () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) files[`src/m${i}.ts`] = `import { m${i + 1} } from './m${i + 1}';\nexport function m${i}() { return m${i + 1}(); }\n`;
    files['src/m13.ts'] = 'export function m13() { return 13; }\n';
    root = workspace(files);
    init(root);
    process.env['MAPX_TEST_WORKER_FAIL'] = 'src/m3.ts';
    let output: string;
    try {
      const r = mapxWithStderr(root, 'scan');
      output = r.stdout + r.stderr;
    } finally {
      delete process.env['MAPX_TEST_WORKER_FAIL'];
    }
    expect(output).not.toContain('Parallel parsing unavailable');
    expect(output).toContain('[mapx] 1 file(s) parsed on the main thread: a worker could not return them (src/m3.ts: Error: MAPX_TEST_WORKER_FAIL).');
    const all = () => ({
      symbols: query(root, 'SELECT file_path, name, kind, start_line FROM symbols ORDER BY 1, 2, 4'),
      edges: query(root, 'SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges ORDER BY 1, 2, 3, 4, 5'),
    });
    const handedBack = all();
    expect(handedBack.symbols).toContainEqual({ file_path: 'src/m3.ts', name: 'm3', kind: 'function', start_line: 2 });
    unlinkSync(join(root, '.mapx/mapx.db'));
    mapxWithStderr(root, 'scan', '--no-parallel');
    expect(all()).toEqual(handedBack);
  }, 120000);
});

const hasBun = spawnSync('bun', ['--version']).status === 0;

describe.skipIf(!hasBun)('the compiled binary scans on worker threads (real bun build)', () => {
  let binDir: string;
  let bin: string;
  let root: string;
  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'mapx-bin-'));
    bin = join(binDir, 'mapx');
    execFileSync('bun', ['build', '--compile', '--minify', ...ENTRYPOINTS, '--outfile', bin], { cwd: ROOT, stdio: 'pipe' });
    // Assets next to the binary come first in findAssetRoot: this checkout's, not an installed copy's.
    symlinkSync(join(ROOT, 'wasm'), join(binDir, 'wasm'));
    symlinkSync(join(ROOT, 'queries'), join(binDir, 'queries'));

    const files: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) {
      files[`src/m${i}.ts`] = `import { m${i + 1} } from './m${i + 1}';\nexport function m${i}() { return m${i + 1}(); }\n`;
    }
    files['src/m13.ts'] = 'export function m13() { return 13; }\nexport class Service { run() { return m13(); } }\n';
    files['app/util.py'] = 'def helper():\n    return 1\n\ndef main():\n    return helper()\n';
    Object.assign(files, PROTOTYPE_CALLS);
    files['app/User.php'] = '<?php\nnamespace App;\nclass User { public function name() { return $this->id(); } public function id() { return 1; } }\n';
    root = workspace(files);
    execFileSync(bin, ['init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover'], { stdio: 'pipe' });
  }, 300000);
  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
    cleanup(root);
  });

  const scan = (...args: string[]) => {
    const r = spawnSync(bin, ['scan', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1' } });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout + r.stderr;
  };
  const rows = () => ({
    files: query(root, 'SELECT repo, path, language, content_hash FROM files ORDER BY path'),
    symbols: query(root, 'SELECT file_path, name, kind, start_line, end_line FROM symbols ORDER BY file_path, name, start_line'),
    edges: query(root, `SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges
      ORDER BY source_file, source_symbol, target_file, target_symbol, edge_type`),
  });

  it('parses more than 10 files without falling back to one thread, and indexes what a one-thread scan does', () => {
    const output = scan();
    expect(output).not.toContain('Parallel parsing unavailable');
    const parallel = rows();
    expect((parallel.files as unknown[]).length).toBe(17);
    expect(prototypeCallEdges(root)).toEqual(EXPECTED_PROTOTYPE_CALLS);
    expect(parallel.edges).toContainEqual({ source_file: 'src/m1.ts', source_symbol: 'm1', target_file: 'src/m2.ts', target_symbol: 'm2', edge_type: 'call' });
    expect((parallel.symbols as Array<{ name: string }>).map((s) => s.name)).toEqual(expect.arrayContaining(['helper', 'User', 'Service']));

    unlinkSync(join(root, '.mapx/mapx.db'));
    scan('--no-parallel');
    expect(rows()).toEqual(parallel);
  }, 300000);
});
