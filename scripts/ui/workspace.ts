// Fixture workspaces for the dashboard audit (scripts/ui/audit.ts, M4-16) and the browser tests
// (tests/ui, M4-19): generated projects (no private code), scanned with the source CLI and served
// with `mapx ui` on a free port.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO = resolve(import.meta.dirname, '../..');
const MAIN = join(REPO, 'src/main.ts');
const TSX = pathToFileURL(join(REPO, 'node_modules/tsx/dist/loader.mjs')).href;
const ENV = { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1', MAPX_NO_BANNER: '1' };

/** Runs the source CLI in `cwd` and returns its stdout. */
export const cli = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--import', TSX, MAIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: ENV, maxBuffer: 256 * 1024 * 1024 }).toString();

export function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** n files: 50% TypeScript, 30% PHP, 10% Vue, 10% Python; each calls others of its language. */
export function generate(root: string, n: number) {
  const d = (i: number) => `d${i % 25}`;
  const counts = { ts: Math.round(n * 0.5), php: Math.round(n * 0.3), vue: Math.round(n * 0.1), py: n - Math.round(n * 0.5) - Math.round(n * 0.3) - Math.round(n * 0.1) };
  for (let i = 0; i < counts.ts; i++) {
    const a = (i * 7 + 1) % counts.ts;
    const rel = d(a) === d(i) ? `./m${a}` : `../${d(a)}/m${a}`;
    write(root, `src/${d(i)}/m${i}.ts`, `import { f${a} } from '${rel}';\nexport class C${i} { run(x: number) { return f${a}(x) + this.helper(x); } helper(x: number) { return x; } }\nexport function f${i}(x: number): number { return x > 0 ? f${a}(x - 1) : x; }\n`);
  }
  for (let i = 0; i < counts.php; i++) {
    const a = (i * 7 + 1) % counts.php;
    write(root, `app/${d(i)}/C${i}.php`, `<?php\nnamespace App\\${d(i).toUpperCase()};\n\nuse App\\${d(a).toUpperCase()}\\C${a};\n\nclass C${i}\n{\n    public function run(C${a} $o): int { return $o->helper(); }\n    public function helper(): int { return ${i}; }\n}\n`);
  }
  for (let i = 0; i < counts.vue; i++) {
    write(root, `web/${d(i)}/V${i}.vue`, `<script setup lang="ts">\nimport { f${i % counts.ts} } from '../../src/${d(i % counts.ts)}/m${i % counts.ts}';\nfunction go() { return f${i % counts.ts}(1); }\n</script>\n<template><button @click="go">go</button></template>\n`);
  }
  for (let i = 0; i < counts.py; i++) {
    const a = (i * 7 + 1) % counts.py;
    write(root, `py/${d(i)}/m${i}.py`, `from py.${d(a)}.m${a} import f${a}\n\n\ndef f${i}(x):\n    return f${a}(x - 1) if x > 0 else x\n`);
  }
  write(root, 'package.json', JSON.stringify({ name: 'audit-fixture', version: '1.0.0', dependencies: { vue: '^3.4.0' } }));
}

/**
 * A small workspace that gives every dashboard tab something to show: generated sources plus a
 * Laravel app with routes and a Vue component calling it with axios.
 */
export function smokeWorkspace(root: string) {
  generate(root, 60);
  write(root, 'artisan', '#!/usr/bin/env php\n<?php\n');
  write(root, 'composer.json', JSON.stringify({ require: { 'laravel/framework': '^11.0' } }));
  write(root, 'routes/api.php', "<?php\nuse Illuminate\\Support\\Facades\\Route;\nuse App\\Http\\Controllers\\OrderController;\n\nRoute::get('/orders', [OrderController::class, 'index']);\nRoute::post('/orders', [OrderController::class, 'store']);\n");
  write(root, 'app/Http/Controllers/OrderController.php', '<?php\nnamespace App\\Http\\Controllers;\n\nclass OrderController\n{\n    public function index() { return []; }\n    public function store() { return []; }\n}\n');
  write(root, 'web/Orders.vue', "<script setup lang=\"ts\">\nimport axios from 'axios';\nasync function load() { return axios.get('/api/orders'); }\n</script>\n<template><button @click=\"load\">load</button></template>\n");
}

/** `mapx init` (no agent files, MCP configs or discovery) then `mapx scan`. */
export function initAndScan(root: string, ...scanArgs: string[]) {
  cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
  cli(root, 'scan', ...scanArgs);
}

export const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const port = (s.address() as any).port; s.close(() => res(port)); });
  s.on('error', rej);
});

/** Serves `root` with `mapx ui` on a free port; resolves once the server listens. */
export async function serve(root: string): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', TSX, MAIN, 'ui', root, '--port', String(port), '--no-open'], {
    cwd: root, env: ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error('mapx ui did not start in 60 s')), 60_000);
    const onData = (d: Buffer) => { if (/UI Server running at/.test(String(d))) { clearTimeout(timer); res(); } };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`mapx ui exited ${code}`)); });
  });
  return { url: `http://127.0.0.1:${port}/`, child };
}
