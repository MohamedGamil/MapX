import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import { grammarLoadCounts, loadLanguage } from '../src/parsers/wasm-parser.js';
import { Scanner, type WorkerStats } from '../src/core/scanner.js';
import { POOL_SIZING, ParseWorkerPool, availableMemory, parseWorkersSetting, poolSize } from '../src/core/worker-pool.js';
import { Store } from '../src/core/store.js';
import { Config } from '../src/core/config.js';
import { MapxGraph } from '../src/core/graph.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, mcpParsePool } from '../src/mcp.js';
import { cleanup, init, mapxWithStderr, query, workspace, useParseWorkers } from './helpers/e2e.js';

// These scans exercise the parse workers; test projects are below the automatic break-even (M4-13).
useParseWorkers(4);

// Parse worker resources (D025): M4-10 grammars per worker, M4-11 pool, M4-13 sizing,
// M4-12 distribution, M4-14 batching.

/** Runs the CLI with extra environment variables, returning its output and the worker-stats lines. */
export function mapxStats(root: string, env: Record<string, string>, ...args: string[]) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const r = mapxWithStderr(root, ...args);
    const output = r.stdout + r.stderr;
    const stats = [...output.matchAll(/\[mapx\] worker-stats (\{.*\})/g)].map((m) => JSON.parse(m[1]!) as WorkerStats);
    return { output, stats };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const indexRows = (root: string) => ({
  files: query(root, 'SELECT path, language, content_hash FROM files ORDER BY path'),
  symbols: query(root, 'SELECT file_path, name, kind, scope, start_line, end_line FROM symbols ORDER BY file_path, start_line, name, kind'),
  edges: query(root, 'SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges ORDER BY 1, 2, 3, 4, 5'),
});

/** A PHP, TypeScript and Vue project of 18 files: enough for the scanner to parse on workers. */
function mixedProject(): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { vue: '^3.4.0' } }) };
  for (let i = 0; i < 6; i++) {
    files[`app/C${i}.php`] = `<?php\nnamespace App;\nclass C${i} { public function run(C${(i + 1) % 6} $o) { return $o->helper(); } public function helper() { return ${i}; } }\n`;
    files[`src/m${i}.ts`] = `import { f${(i + 1) % 6} } from './m${(i + 1) % 6}';\nexport function f${i}(x: number): number { return x > 0 ? f${(i + 1) % 6}(x - 1) : x; }\n`;
    files[`web/V${i}.vue`] = `<script setup lang="ts">\nimport { f${i} } from '../src/m${i}';\nfunction go() { return f${i}(1); }\n</script>\n<template><button @click="go">x</button></template>\n`;
  }
  return files;
}

describe('M4-10: a thread loads each grammar file once, only when it parses that language', () => {
  it('concurrent first uses of a grammar share one load', async () => {
    const lua = getBuiltinLanguages().lua!;
    const [a, b] = await Promise.all([loadLanguage(lua), loadLanguage(lua)]);
    expect(a).toBe(b);
    expect(await loadLanguage(lua)).toBe(a);
    expect(grammarLoadCounts().find((g) => g.grammar === 'lua')).toEqual({ grammar: 'lua', loads: 1 });
  });

  it('the generic capture walk still extracts symbols for a file its language parser failed on', () => {
    const files = mixedProject();
    const root = workspace(files);
    try {
      init(root);
      const { output } = mapxStats(root, { MAPX_TEST_WORKER_FALLBACK: 'src/m2.ts' }, 'scan');
      expect(output).not.toContain('Parallel parsing unavailable');
      const names = query<{ name: string; kind: string }>(root, "SELECT name, kind FROM symbols WHERE file_path = 'src/m2.ts'");
      expect(names).toContainEqual({ name: 'f2', kind: 'function' });
    } finally {
      cleanup(root);
    }
  }, 120000);

  describe('workers of a real scan (MAPX_WORKER_STATS)', () => {
    let root: string;
    afterAll(() => cleanup(root));

    it('report their work, load only the project\'s grammars once each, and index what one thread does', () => {
      root = workspace(mixedProject());
      init(root);
      const { output, stats } = mapxStats(root, { MAPX_WORKER_STATS: '1' }, 'scan');
      expect(output).not.toContain('Parallel parsing unavailable');
      expect(stats).toHaveLength(1);
      const [run] = stats;
      expect(run!.started).toBeGreaterThan(0);
      expect(run!.workers).toHaveLength(run!.started);
      expect(run!.handbacks).toBe(0);
      expect(run!.peakRssMb).toBeGreaterThan(0);
      // The 18 source files (package.json is excluded by default), each parsed by exactly one worker.
      expect(run!.workers.reduce((n, w) => n + w.files, 0)).toBe(18);
      for (const worker of run!.workers) {
        for (const g of worker.grammars) {
          // The Vue parser reads <script> with the TypeScript grammar: php and typescript only.
          expect(['php', 'typescript']).toContain(g.grammar);
          expect(g.loads).toBe(1);
        }
      }
      expect(new Set(run!.workers.flatMap((w) => w.grammars.map((g) => g.grammar)))).toEqual(new Set(['php', 'typescript']));

      const parallel = indexRows(root);
      unlinkSync(join(root, '.mapx/mapx.db'));
      mapxWithStderr(root, 'scan', '--no-parallel');
      expect(indexRows(root)).toEqual(parallel);
    }, 120000);
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
/** n TypeScript files under dir/, each calling the next. */
const tsFiles = (dir: string, n: number, tag = '') => Object.fromEntries(Array.from({ length: n }, (_, i) =>
  [`${dir}/m${i}.ts`, `import { f${(i + 1) % n} } from './m${(i + 1) % n}';\nexport function f${i}(x: number): number { return x > 0 ? f${(i + 1) % n}(x - 1) : x; }${tag}\n`]));

describe('M4-11: one controlled pool of workers', () => {
  it('serves every parse batch of a multi-repo scan --all, starting each worker once', () => {
    const root = workspace({ ...tsFiles('src', 12), ...tsFiles('libs/a', 12), ...tsFiles('libs/b', 12) }, ['.', 'libs/a', 'libs/b']);
    try {
      init(root);
      mapxWithStderr(root, 'workspaces', 'add', 'libs/a');
      mapxWithStderr(root, 'workspaces', 'add', 'libs/b');
      const { output, stats } = mapxStats(root, { MAPX_WORKER_STATS: '1' }, 'scan', '--all', '--force');
      expect(output).not.toContain('Parallel parsing unavailable');
      expect(stats).toHaveLength(1);
      const [run] = stats;
      // A batch per repo at least: before the pool, each batch started its own workers.
      expect(run!.batches).toBeGreaterThanOrEqual(3);
      expect(run!.started).toBe(run!.workers.length);
      expect(run!.started).toBeLessThanOrEqual(8);
      expect(run!.workers.reduce((n, w) => n + w.files, 0)).toBeGreaterThanOrEqual(36);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('replaces a worker that dies, hands back a file that killed two, and indexes what one thread does', () => {
    const root = workspace(tsFiles('src', 14));
    try {
      init(root);
      const { output, stats } = mapxStats(root, { MAPX_WORKER_STATS: '1', MAPX_TEST_WORKER_EXIT: 'src/m3.ts' }, 'scan');
      expect(output).not.toContain('Parallel parsing unavailable');
      expect(output).toContain('[mapx] 1 file(s) parsed on the main thread: a worker could not return them (src/m3.ts: worker exited with code 3).');
      expect(stats[0]!.handbacks).toBe(1);
      const parallel = indexRows(root);
      expect(parallel.symbols).toContainEqual(expect.objectContaining({ file_path: 'src/m3.ts', name: 'f3' }));
      unlinkSync(join(root, '.mapx/mapx.db'));
      mapxWithStderr(root, 'scan', '--no-parallel');
      expect(indexRows(root)).toEqual(parallel);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('lets the CLI exit as soon as a scan ends, whatever the idle timeout', () => {
    const root = workspace(tsFiles('src', 14));
    try {
      init(root);
      const start = Date.now();
      mapxStats(root, { MAPX_WORKER_IDLE_MS: '600000' }, 'scan');
      expect(Date.now() - start).toBeLessThan(30000);
    } finally {
      cleanup(root);
    }
  }, 120000);

  it('closes the run\'s pool when a scan is aborted', async () => {
    const root = workspace(tsFiles('src', 40));
    const close = vi.spyOn(ParseWorkerPool.prototype, 'close');
    try {
      const config = await Config.load(root);
      let scanner: Scanner;
      scanner = new Scanner(new Store(':memory:'), config, new MapxGraph(config.repos[0]!.name), (p) => {
        if (p.phase === 'parse' && p.current >= 1) scanner.abort();
      });
      const result = await scanner.scanFull();
      expect(result.interrupted).toBe(true);
      expect(close).toHaveBeenCalled();
      expect((scanner as any).runPool).toBeNull();
      const pool = close.mock.contexts[0] as ParseWorkerPool;
      expect(pool.liveWorkers).toBe(0);
    } finally {
      close.mockRestore();
      cleanup(root);
    }
  }, 120000);

  describe('in mapx serve (one pool across tool calls)', () => {
    let root: string;
    let client: Client;
    afterAll(async () => {
      await client?.close();
      await mcpParsePool().close();
      cleanup(root);
    });
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: { dir: root, ...args } })) as any).content[0].text as string;

    it('reuses its workers for the next call, parses with each call\'s context, and closes them when idle', async () => {
      process.env['MAPX_WORKER_IDLE_MS'] = '1500';
      const files: Record<string, string> = {
        ...tsFiles('src', 12),
        'app/Services/ThingService.php': '<?php\nnamespace App\\Services;\nclass ThingService { public function make() { return 1; } }\n',
        // No namespace: an unqualified Thing is a global alias, which settings.php.facadeMap rewrites.
        'app/UseIt.php': '<?php\nclass UseIt { public function go() { return Thing::make(); } }\n',
      };
      root = workspace(files);
      git(root, 'init', '-q');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'init');
      init(root);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await buildServer().connect(serverSide);
      client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientSide);
      const pool = mcpParsePool();
      delete process.env['MAPX_WORKER_IDLE_MS'];

      await call('mapx_scan', { force: true });
      const startedAfterScan = pool.started;
      expect(startedAfterScan).toBeGreaterThan(0);
      const facadeEdges = () => query(root, "SELECT target_file FROM edges WHERE source_file = 'app/UseIt.php' AND target_file = 'app/Services/ThingService.php'");
      expect(facadeEdges()).toEqual([]);

      // Another call within the idle timeout: same workers, this call's context (a facade map).
      const configPath = join(root, '.mapx/config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.settings.php = { ...(config.settings.php ?? {}), facadeMap: { Thing: 'App\\Services\\ThingService' } };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      await call('mapx_scan', { force: true });
      expect(pool.started).toBe(startedAfterScan);
      expect(facadeEdges().length).toBeGreaterThan(0);

      for (let i = 0; i < 12; i++) appendFileSync(join(root, `src/m${i}.ts`), `export const v${i} = ${i};\n`);
      await call('mapx_sync', {});
      expect(pool.started).toBe(startedAfterScan);
      expect(query(root, "SELECT name FROM symbols WHERE name = 'v7'")).toHaveLength(1);
      expect(pool.liveWorkers).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 3000));
      expect(pool.liveWorkers).toBe(0);
    }, 120000);
  });
});

describe('M4-11 review: the shared pool under concurrent tool calls, and process exit', () => {
  it('runs concurrent MCP scans of two workspaces one batch at a time, each with its own settings', async () => {
    const php = (map: boolean) => {
      const files: Record<string, string> = {
        'app/Services/ThingService.php': '<?php\nnamespace App\\Services;\nclass ThingService { public function make() { return 1; } }\n',
      };
      for (let i = 0; i < 150; i++) files[`app/U${i}.php`] = `<?php\nclass U${i} { public function go() { return Thing::make(); } }\n`;
      const root = workspace(files);
      init(root);
      if (map) {
        const configPath = join(root, '.mapx/config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.settings.php = { ...(config.settings.php ?? {}), facadeMap: { Thing: 'App\\Services\\ThingService' } };
        writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
      return root;
    };
    const plain = php(false);
    const mapped = php(true);
    const warn = vi.spyOn(console, 'warn');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const scan = (dir: string) => client.callTool({ name: 'mapx_scan', arguments: { dir, force: true } });
      await Promise.all([scan(plain), scan(mapped)]);
      const thing = (root: string) => query(root, "SELECT source_file FROM edges WHERE target_file = 'app/Services/ThingService.php' AND edge_type = 'call'").length;
      expect(thing(plain)).toBe(0);
      expect(thing(mapped)).toBe(150);
      expect(warn.mock.calls.flat().join('\n')).not.toContain('Parallel parsing unavailable');
    } finally {
      warn.mockRestore();
      await client.close();
      await mcpParsePool().close();
      cleanup(plain);
      cleanup(mapped);
    }
  }, 180000);

  it('lets mapx serve exit when stdin closes, though its idle workers have a long timeout', async () => {
    const root = workspace(tsFiles('src', 14));
    init(root);
    const main = resolve(__dirname, '../src/main.ts');
    const tsx = pathToFileURL(resolve(__dirname, '../node_modules/tsx/dist/loader.mjs')).href;
    const child = spawn(process.execPath, ['--import', tsx, main, 'serve', '--dir', root], {
      env: { ...process.env, MAPX_WORKER_IDLE_MS: '600000', MAPX_WORKER_STATS: '1', MAPX_NO_TELEMETRY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
    const response = (id: number) => new Promise<void>((r, reject) => {
      const timer = setInterval(() => {
        if (stdout.split('\n').some((l) => l.includes(`"id":${id}`))) { clearInterval(timer); r(); }
      }, 50);
      setTimeout(() => { clearInterval(timer); reject(new Error(`no response ${id}: ${stderr}`)); }, 60000);
    });
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      await response(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mapx_scan', arguments: { dir: root } } });
      await response(2);
      // The scan ran on the shared pool, whose workers are now idle for up to 10 minutes.
      expect(stderr).toContain('[mapx] worker-stats');
      const start = Date.now();
      child.stdin.end();
      const winner = await Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 15000))]);
      expect(winner).toBe('exited');
      expect(Date.now() - start).toBeLessThan(15000);
    } finally {
      child.kill('SIGKILL');
      cleanup(root);
    }
  }, 120000);
});

describe('M4-13: pool size from the work and the machine', () => {
  const KB = 1024;
  const MB = 1024 * KB;
  const GB = 1024 * MB;
  const machine = { cpus: 16, availableMemory: 16 * GB };

  it.each([
    ['a small batch parses on the main thread', { files: 20, bytes: 50 * KB }, 0],
    ['below two cold workers\' worth', { files: 300, bytes: 700 * KB }, 0],
    ['two cold workers\' worth', { files: 300, bytes: 2 * POOL_SIZING.coldBytesPerWorker }, 2],
    ['MapX\'s own sources (3.4 MB)', { files: 383, bytes: 3.4 * MB }, 8],
    ['never more than 8', { files: 5000, bytes: 70 * MB }, 8],
    ['never more than CPUs - 1', { files: 5000, bytes: 70 * MB, cpus: 4 }, 3],
    ['two CPUs leave one: the main thread', { files: 5000, bytes: 70 * MB, cpus: 2 }, 0],
    ['never more than half the free memory holds', { files: 5000, bytes: 70 * MB, availableMemory: 1 * GB }, 4],
    ['too little memory for two', { files: 5000, bytes: 70 * MB, availableMemory: 300 * MB }, 0],
    ['never more than the files', { files: 3, bytes: 30 * MB }, 3],
    ['running workers need less source', { files: 40, bytes: 200 * KB, warmWorkers: 4 }, 4],
    ['one running worker alone does not', { files: 40, bytes: 200 * KB, warmWorkers: 1 }, 0],
    ['a number is used as given', { files: 20, bytes: 10 * KB, setting: 3 }, 3],
    ['a number never exceeds the files', { files: 2, bytes: 10 * KB, setting: 6 }, 2],
    ['0 is the main thread', { files: 5000, bytes: 70 * MB, setting: 0 }, 0],
  ] as const)('%s', (_name, input, expected) => {
    expect(poolSize({ ...machine, ...input })).toBe(expected);
  });

  it('reads MAPX_PARSE_WORKERS before settings.parseWorkers, and ignores invalid values with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseWorkersSetting(undefined, null)).toBe('auto');
      expect(parseWorkersSetting(3, null)).toBe(3);
      expect(parseWorkersSetting(3, '0')).toBe(0);
      expect(parseWorkersSetting('auto', '5')).toBe(5);
      expect(parseWorkersSetting(2, '')).toBe(2);
      expect(parseWorkersSetting(-1, 'many')).toBe('auto');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('a small "auto" scan starts no worker; settings.parseWorkers 2 starts two; --no-parallel wins over it', () => {
    const root = workspace(tsFiles('src', 14));
    try {
      init(root);
      expect(mapxStats(root, { MAPX_WORKER_STATS: '1', MAPX_PARSE_WORKERS: 'auto' }, 'scan', '--force').stats).toEqual([]);
      const configPath = join(root, '.mapx/config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.settings.parseWorkers = 2;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      const configured = mapxStats(root, { MAPX_WORKER_STATS: '1', MAPX_PARSE_WORKERS: '' }, 'scan', '--force').stats;
      expect(configured).toHaveLength(1);
      expect(configured[0]!.started).toBe(2);
      expect(mapxStats(root, { MAPX_WORKER_STATS: '1', MAPX_PARSE_WORKERS: '' }, 'scan', '--force', '--no-parallel').stats).toEqual([]);
    } finally {
      cleanup(root);
    }
  }, 120000);
});

describe('M4-13 review: memory figure, setting parsing, static files', () => {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  it.each([
    ['Bun in a 600 MB cgroup reports the host\'s free memory as available: the limit less RSS wins', { freemem: 11 * GB, available: 11 * GB, limit: 600 * MB, rss: 100 * MB }, 500 * MB],
    ['Node at its cgroup limit (available 0) stays at 0, not the host\'s free memory', { freemem: 11 * GB, available: 0, limit: 600 * MB, rss: 650 * MB }, 0],
    ['no limit (0): the lower of free and available', { freemem: 8 * GB, available: 6 * GB, limit: 0, rss: 100 * MB }, 6 * GB],
    ['an unlimited sentinel is ignored', { freemem: 8 * GB, available: 8 * GB, limit: 2 ** 64, rss: 100 * MB }, 8 * GB],
    ['a runtime without the figures: free memory', { freemem: 3 * GB, rss: 100 * MB }, 3 * GB],
  ] as const)('%s', (_name, m, expected) => {
    expect(availableMemory({
      freemem: () => m.freemem,
      availableMemory: 'available' in m ? () => m.available : undefined,
      constrainedMemory: 'limit' in m ? () => m.limit : undefined,
      rss: () => m.rss,
    })).toBe(expected);
  });

  it('accepts only "auto" and whole numbers, warning once per invalid value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bad of [' ', '\t', '1e1', '0x10', '4 ', '-1', '2.5']) expect(parseWorkersSetting(undefined, bad)).toBe('auto');
      for (const bad of [true, [4], 2.5, -3, {}]) expect(parseWorkersSetting(bad, null)).toBe('auto');
      expect(parseWorkersSetting(undefined, '12')).toBe(12);
      expect(parseWorkersSetting(0, null)).toBe(0);
      const before = warn.mock.calls.length;
      parseWorkersSetting(undefined, '1e1');
      parseWorkersSetting(true, null);
      expect(warn.mock.calls.length).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });

  it('weighs JSON and other static files at a twentieth of code', async () => {
    const root = workspace({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const config = await Config.load(root);
      const scanner: any = new Scanner(new Store(':memory:'), config, new MapxGraph(config.repos[0]!.name));
      const batch = (language: string) => Array.from({ length: 60 }, (_, i) => ({ absolutePath: join(root, `f${i}`), language, sizeBytes: Math.round((19 * MB) / 60), lines: 1 }));
      const saved = process.env['MAPX_PARSE_WORKERS'];
      process.env['MAPX_PARSE_WORKERS'] = 'auto';
      try {
        const json = scanner.workerLanes(batch('json'));
        const ts = scanner.workerLanes(batch('typescript'));
        expect(json).toBeLessThanOrEqual(2);
        expect(ts).toBeGreaterThanOrEqual(json);
      } finally {
        if (saved === undefined) delete process.env['MAPX_PARSE_WORKERS'];
        else process.env['MAPX_PARSE_WORKERS'] = saved;
      }
    } finally {
      cleanup(root);
    }
  });
});
