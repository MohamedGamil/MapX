// Import-resolution scaling benchmark (docs/baton M0-12-R3). Generates two synthetic Java
// workspaces in a temp dir, identical except that one gives every file K import lines (most naming
// other generated classes, the rest java.util), runs the real CLI (init + scan) on each and prints
// the scan wall times and their ratio. No real code is involved.
//   npx tsx scripts/bench/import-resolution.ts [--files N] [--imports K] [--runs R] [--package-local] [--resolvers-only] [--max-ratio X] [--json]
// Exit code 1 when the median ratio exceeds --max-ratio; 2 on usage or scan errors.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '../..');
const MAIN = join(REPO, 'src/main.ts');
const TSX = pathToFileURL(join(REPO, 'node_modules/tsx/dist/loader.mjs')).href;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`--${name} needs a positive number`);
    process.exit(2);
  }
  return v;
}

const FILES = arg('files', 2000);
const IMPORTS = arg('imports', 10);
const RUNS = arg('runs', 1);
const MAX_RATIO = process.argv.includes('--max-ratio') ? arg('max-ratio', 1.5) : null;
const PACKAGES = Math.max(1, Math.round(FILES / 50));
const EXTERNAL = ['java.util.List', 'java.util.Map', 'java.io.File'];

/** Class i lives in package com.bench.p<i % PACKAGES>; deterministic, so both variants match. */
const pkg = (i: number) => `com.bench.p${i % PACKAGES}`;
const cls = (i: number) => `C${i}`;
// --package-local keeps imports inside each ~50-class package. Without it the generated graph is
// one large cycle, and at 10,000 files the recursive SCC pass of the architecture analyzer
// overflows the stack (it does so on the base commit too, independently of import resolution).
const PACKAGE_LOCAL = process.argv.includes('--package-local');
function target(i: number, k: number): number {
  if (!PACKAGE_LOCAL) return (i * 7 + k * 131) % FILES;
  const p = i % PACKAGES;
  const inPackage = Math.floor((FILES - 1 - p) / PACKAGES) + 1;
  return p + PACKAGES * ((Math.floor(i / PACKAGES) * 7 + k * 13) % inPackage);
}

function generate(withImports: boolean): string {
  const root = mkdtempSync(join(tmpdir(), `mapx-bench-${withImports ? 'imports' : 'plain'}-`));
  for (let i = 0; i < FILES; i++) {
    const lines = [`package ${pkg(i)};`, ''];
    if (withImports) {
      const internal = Math.max(0, IMPORTS - Math.min(EXTERNAL.length, Math.floor(IMPORTS / 3)));
      for (let k = 1; k <= internal; k++) {
        const j = target(i, k);
        lines.push(`import ${pkg(j)}.${cls(j)};`);
      }
      for (let k = 0; k < IMPORTS - internal; k++) lines.push(`import ${EXTERNAL[k % EXTERNAL.length]};`);
      lines.push('');
    }
    lines.push(`public class ${cls(i)} {`, `  private int value${i};`, `  public int get() { return value${i}; }`, '}', '');
    const path = join(root, 'src/main/java', ...pkg(i).split('.'), `${cls(i)}.java`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join('\n'));
  }
  return root;
}

function cli(cwd: string, ...args: string[]): void {
  execFileSync(process.execPath, ['--import', TSX, MAIN, ...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', MAPX_NO_TELEMETRY: '1' },
  });
}

/** Wall time of `mapx scan` on a freshly initialised copy (init excluded). */
function timeScan(withImports: boolean): number {
  const root = generate(withImports);
  try {
    cli(root, 'init', root, '--no-agents', '--no-suggestions', '--no-mcp-configs', '--no-discover');
    const t0 = performance.now();
    cli(root, 'scan', root);
    return (performance.now() - t0) / 1000;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// --resolvers-only: time this checkout's JVM resolver in-process on the same generated paths and
// imports, without parsing or SQLite, so machine load and other scan phases don't blur the result.
if (process.argv.includes('--resolvers-only')) {
  const { resolveJvmImport } = await import(pathToFileURL(join(REPO, 'src/core/import-resolvers.ts')).href);
  const path = (i: number) => `src/main/java/${pkg(i).replace(/\./g, '/')}/${cls(i)}.java`;
  const files = new Set(Array.from({ length: FILES }, (_, i) => path(i)));
  const internal = Math.max(0, IMPORTS - Math.min(EXTERNAL.length, Math.floor(IMPORTS / 3)));
  const ctx = { files, readText: () => null };
  const t0 = performance.now();
  let resolved = 0;
  for (let i = 0; i < FILES; i++) {
    for (let k = 1; k <= internal; k++) if (resolveJvmImport(`${pkg(target(i, k))}.${cls(target(i, k))}`, path(i), ctx, ['.java', '.kt'])) resolved++;
    for (let k = 0; k < IMPORTS - internal; k++) resolveJvmImport(EXTERNAL[k % EXTERNAL.length]!, path(i), ctx, ['.java', '.kt']);
  }
  console.log(`resolvers only: ${FILES * IMPORTS} imports over ${FILES} files, ${resolved} resolved, ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  process.exit(0);
}

try {
  const plain: number[] = [];
  const imports: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    plain.push(timeScan(false));
    imports.push(timeScan(true));
  }
  const result = {
    files: FILES,
    importsPerFile: IMPORTS,
    runs: RUNS,
    plainSeconds: plain.map((s) => +s.toFixed(2)),
    importsSeconds: imports.map((s) => +s.toFixed(2)),
    ratio: +(median(imports) / median(plain)).toFixed(2),
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(`files=${FILES} imports/file=${IMPORTS} runs=${RUNS}`);
    console.log(`scan without imports: ${result.plainSeconds.join(', ')} s (median ${median(plain).toFixed(2)})`);
    console.log(`scan with imports:    ${result.importsSeconds.join(', ')} s (median ${median(imports).toFixed(2)})`);
    console.log(`ratio: ${result.ratio}`);
  }
  if (MAX_RATIO !== null && result.ratio > MAX_RATIO) {
    console.error(`ratio ${result.ratio} exceeds --max-ratio ${MAX_RATIO}`);
    process.exit(1);
  }
} catch (err: any) {
  console.error(err?.stderr?.toString?.() || err?.message || err);
  process.exit(2);
}
