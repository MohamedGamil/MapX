// Parse worker benchmark (docs/baton M4-10 … M4-15, D025). Generates a synthetic mixed-language
// workspace in a temp dir (TypeScript, PHP, Vue, Python, Go, Ruby; each file calls others of its
// language), scans it with the real CLI on worker threads and with --no-parallel, and prints wall
// time, peak RSS and the parallel run's worker statistics (MAPX_WORKER_STATS). No real code is involved.
//   npx tsx scripts/bench/workers.ts [--files 3000] [--mix typescript:40,php:35,vue:10,python:5,go:5,ruby:5]
//                                    [--corpus <dir> [--copies 1]] [--bin <compiled mapx>] [--keep] [--json]
// --corpus scans copies of an existing directory instead (for example `git archive HEAD src tests`
// of MapX itself): generated files parse much faster per byte than real code. MAPX_PARSE_WORKERS
// and the other variables pass through to the scans.
// Exit code 1 when the parallel index differs from the one-thread index; 2 on usage or scan errors.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const REPO = resolve(import.meta.dirname, '../..');
const MAIN = join(REPO, 'src/main.ts');
const TSX = pathToFileURL(join(REPO, 'node_modules/tsx/dist/loader.mjs')).href;
// Prints the process's peak RSS (KB) at exit: Node's own figure, worker threads included.
const RSS_PRELOAD = `data:text/javascript,process.on('exit',()=>{try{process.stderr.write('[bench] maxrss '+process.resourceUsage().maxRSS+'\\n')}catch{}})`;

function value(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return v;
}

const FILES = Number(value('files') ?? '3000');
if (!Number.isInteger(FILES) || FILES < 20) {
  console.error('--files needs an integer ≥ 20');
  process.exit(2);
}
const GENERATORS = ['typescript', 'php', 'vue', 'python', 'go', 'ruby'] as const;
type Lang = (typeof GENERATORS)[number];
const MIX: Array<[Lang, number]> = (value('mix') ?? 'typescript:40,php:35,vue:10,python:5,go:5,ruby:5').split(',').map((part) => {
  const [lang, weight] = part.split(':');
  if (!GENERATORS.includes(lang as Lang) || !(Number(weight) > 0)) {
    console.error(`--mix: "${part}" is not <${GENERATORS.join('|')}>:<positive weight>`);
    process.exit(2);
  }
  return [lang as Lang, Number(weight)];
});
const BIN = value('bin');
const CORPUS = value('corpus');
const COPIES = Number(value('copies') ?? '1');
if (CORPUS && (!existsSync(CORPUS) || !Number.isInteger(COPIES) || COPIES < 1)) {
  console.error('--corpus needs an existing directory, and --copies a whole number ≥ 1');
  process.exit(2);
}
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** n files of one language; file i calls files (i*7+1) % n and (i*13+5) % n of the same language. */
function generate(root: string, lang: Lang, n: number) {
  const d = (i: number) => `d${i % 20}`;
  for (let i = 0; i < n; i++) {
    const a = (i * 7 + 1) % n;
    const b = (i * 13 + 5) % n;
    switch (lang) {
      case 'typescript': {
        const rel = (j: number) => (d(j) === d(i) ? `./m${j}` : `../${d(j)}/m${j}`);
        write(root, `ts/${d(i)}/m${i}.ts`, `import { f${a} } from '${rel(a)}';\nimport { f${b} } from '${rel(b)}';\n` +
          `export class C${i} { run(x: number) { return this.helper(x) + f${a}(x); } helper(x: number) { return x * 2; } }\n` +
          `export function f${i}(x: number): number { return x > 0 ? f${b}(x - 1) : new C${i}().helper(x); }\n`);
        break;
      }
      case 'php':
        write(root, `app/${d(i)}/C${i}.php`, `<?php\nnamespace App\\${d(i).toUpperCase()};\n\nuse App\\${d(a).toUpperCase()}\\C${a};\n\n` +
          `class C${i}\n{\n    public function run(C${a} $other): int\n    {\n        return $other->helper() + $this->helper();\n    }\n\n` +
          `    public function helper(): int\n    {\n        return ${i};\n    }\n}\n`);
        break;
      case 'vue':
        write(root, `web/${d(i)}/V${i}.vue`, `<script setup lang="ts">\nimport V${a} from '../${d(a)}/V${a}.vue';\nimport { ref } from 'vue';\n` +
          `const count = ref(${i});\nfunction bump() { count.value += 1; }\n</script>\n\n<template>\n  <div @click="bump">{{ count }}<V${a} v-if="count < 0" /></div>\n</template>\n`);
        break;
      case 'python':
        write(root, `py/${d(i)}/m${i}.py`, `from py.${d(a)}.m${a} import f${a}\n\n\nclass C${i}:\n    def run(self, x):\n        return f${a}(x) + self.helper(x)\n\n` +
          `    def helper(self, x):\n        return x * 2\n\n\ndef f${i}(x):\n    return C${i}().helper(x)\n`);
        break;
      case 'go':
        write(root, `go/m${i}.go`, `package bench\n\ntype T${i} struct{}\n\nfunc (t T${i}) Helper(x int) int { return x * 2 }\n\n` +
          `func F${i}(x int) int {\n\tif x > 0 {\n\t\treturn F${b}(x - 1)\n\t}\n\treturn T${i}{}.Helper(x)\n}\n`);
        break;
      case 'ruby':
        write(root, `rb/${d(i)}/c${i}.rb`, `class C${i}\n  def run(x)\n    C${a}.new.helper(x) + helper(x)\n  end\n\n  def helper(x)\n    x * 2\n  end\nend\n`);
        break;
    }
  }
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const fullEnv = { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1', ...env };
  const start = process.hrtime.bigint();
  const timed = BIN && existsSync('/usr/bin/time');
  const r = BIN
    ? spawnSync(timed ? '/usr/bin/time' : BIN, timed ? ['-f', '[bench] maxrss %M', BIN, ...args] : args, { cwd, encoding: 'utf8', env: fullEnv })
    : spawnSync(process.execPath, ['--import', TSX, '--import', RSS_PRELOAD, MAIN, ...args], { cwd, encoding: 'utf8', env: fullEnv });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.status !== 0) {
    console.error(`mapx ${args.join(' ')} exited ${r.status}:\n${r.stderr}`);
    process.exit(2);
  }
  const out = r.stdout + r.stderr;
  const rss = /\[bench\] maxrss (\d+)/.exec(out);
  const stats = /\[mapx\] worker-stats (\{.*\})/.exec(out);
  return {
    ms: Math.round(ms),
    peakRssMb: rss ? Math.round(Number(rss[1]) / 1024) : null,
    workerStats: stats ? JSON.parse(stats[1]!) : null,
    fallback: /Parallel parsing unavailable/.test(out),
  };
}

function digest(root: string) {
  const db = new Database(join(root, '.mapx/mapx.db'), { readonly: true });
  try {
    const hash = createHash('sha256');
    const counts: Record<string, number> = {};
    for (const [table, sql] of [
      ['files', 'SELECT path, repo, language, content_hash FROM files ORDER BY path'],
      ['symbols', 'SELECT file_path, name, kind, scope, start_line, end_line FROM symbols ORDER BY file_path, start_line, name, kind'],
      ['edges', 'SELECT source_file, source_symbol, target_file, target_symbol, edge_type FROM edges ORDER BY 1, 2, 3, 4, 5'],
    ] as const) {
      const rows = db.prepare(sql).all();
      counts[table] = rows.length;
      hash.update(table + JSON.stringify(rows));
    }
    return { sha256: hash.digest('hex').slice(0, 16), files: counts.files!, symbols: counts.symbols!, edges: counts.edges! };
  } finally {
    db.close();
  }
}

const root = mkdtempSync(join(tmpdir(), 'mapx-bench-workers-'));
try {
  const total = MIX.reduce((sum, [, w]) => sum + w, 0);
  const counts: Array<readonly [string, number]> = CORPUS
    ? [[`corpus ${CORPUS} ×${COPIES}`, COPIES]]
    : MIX.map(([lang, w]) => [lang, Math.max(2, Math.round((FILES * w) / total))] as const);
  if (CORPUS) for (let k = 0; k < COPIES; k++) cpSync(CORPUS, join(root, `copy${k}`), { recursive: true });
  else for (const [lang, n] of counts) generate(root, lang as Lang, n);
  write(root, 'package.json', JSON.stringify({ name: 'bench-workers', version: '1.0.0', dependencies: { vue: '^3.4.0' } }));
  write(root, 'vite.config.ts', "export default { resolve: { alias: { '@': '/web' } } };\n");

  run(root, ['init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover']);
  const parallel = run(root, ['scan'], { MAPX_WORKER_STATS: '1' });
  const parallelIndex = digest(root);
  unlinkSync(join(root, '.mapx/mapx.db'));
  const single = run(root, ['scan', '--no-parallel']);
  const singleIndex = digest(root);
  const identical = parallelIndex.sha256 === singleIndex.sha256;

  const report = {
    runtime: BIN ? `binary ${BIN}` : `node ${process.version} (source)`,
    files: Object.fromEntries(counts),
    parallel: { ms: parallel.ms, peakRssMb: parallel.peakRssMb, fallback: parallel.fallback, workerStats: parallel.workerStats },
    single: { ms: single.ms, peakRssMb: single.peakRssMb },
    index: { parallel: parallelIndex, single: singleIndex, identical },
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const ws = parallel.workerStats;
    const loads = ws ? ws.workers.reduce((n: number, w: any) => n + w.grammars.reduce((m: number, g: any) => m + g.loads, 0), 0) : null;
    console.log(`${report.runtime}; ${CORPUS ? '' : `${FILES} files `}${JSON.stringify(report.files)}`);
    console.log(`  parallel:  ${parallel.ms} ms, peak RSS ${parallel.peakRssMb ?? '?'} MB${parallel.fallback ? ' (FELL BACK TO ONE THREAD)' : ''}` +
      (ws ? `, ${ws.started} workers, ${loads} grammar loads, ${ws.handbacks} hand-backs` : ''));
    if (ws) for (const [i, w] of ws.workers.entries()) console.log(`    worker ${i}: ${w.files} files; ${w.grammars.map((g: any) => g.loads > 1 ? `${g.grammar}×${g.loads}` : g.grammar).join(', ')}`);
    console.log(`  one thread: ${single.ms} ms, peak RSS ${single.peakRssMb ?? '?'} MB`);
    console.log(`  index: ${identical ? 'identical' : 'DIFFERENT'} (${parallelIndex.files} files, ${parallelIndex.symbols} symbols, ${parallelIndex.edges} edges)`);
  }
  process.exitCode = identical && !parallel.fallback ? 0 : 1;
} finally {
  if (KEEP) console.error(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
