import { describe, it, expect, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getBuiltinLanguages } from '../src/languages/registry.js';
import { grammarLoadCounts, loadLanguage } from '../src/parsers/wasm-parser.js';
import type { WorkerStats } from '../src/core/scanner.js';
import { cleanup, init, mapxWithStderr, query, workspace } from './helpers/e2e.js';

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
